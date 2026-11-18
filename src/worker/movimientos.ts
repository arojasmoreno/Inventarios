import { Hono } from "hono";
import type { CrudSpec } from "./crud";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { logMovimiento } from "./audit";
import { leerPeriodo } from "./periodo";
import { centrosDeUsuario, marcas } from "./alcance";

// Auditoría: quién consumió o ajustó qué, cuándo y con qué cantidad.
// (Sin costes: solo interesa la cantidad de producto consumida.) El registro
// completo es solo para administradores: incluye la actividad de todos los
// centros y el nombre de cada usuario.
export { logMovimiento };
export const movimientosSpec: CrudSpec = {
  table: "movimientos", orderBy: "id", refUsuario: true, noAudit: true,
  extraSelect: ["t.accion", "t.tabla", "t.registro_id", "t.estacion_id", "t.descripcion", "t.cantidad", "t.motivo"],
  extraSearchCols: ["t.accion", "t.descripcion", "t.motivo"],
  read: "admin", create: "admin", update: "admin", delete: "admin",
  fields: [],
};

// Recursos con stock que admiten entrada/salida/ajuste manual y consumo en
// estaciones: la clave es el tipo de artículo (`articulo_tipo` de estaciones).
// Ropa de trabajo y EPIs NO son consumibles: su stock solo cambia con las
// entregas de la sección Equipación, ediciones e importaciones.
export const STOCK_TABLA: Record<string, { tabla: string; columna: string; nombre: string; columnaNombre: string }> = {
  quimicos: { tabla: "quimicos", columna: "num_garrafas", nombre: "químico", columnaNombre: "nombre" },
  material_limpieza: { tabla: "material_limpieza", columna: "cantidad", nombre: "material de limpieza", columnaNombre: "nombre" },
  maquinaria: { tabla: "maquinaria", columna: "cantidad", nombre: "máquina", columnaNombre: "nombre" },
};
const STOCK = STOCK_TABLA;

// Artículo del inventario dentro de los centros del usuario.
async function articuloEnAlcance(db: Env["DB"], user: { id: number; rol: string }, tabla: string, id: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  const permitidos = await centrosDeUsuario(db, user.id);
  if (!permitidos.length) return false;
  const row = await db.prepare(`SELECT centro_id FROM ${tabla} WHERE id = ?`).bind(id).first<{ centro_id: number | null }>();
  return row ? row.centro_id != null && permitidos.includes(Number(row.centro_id)) : false;
}

// Entradas, salidas y ajustes de stock (solo administradores).
export const movimientosRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // ¿Puede el usuario tocar este artículo? El «administrador de centros» solo
  // los de sus centros; el administrador, todos.
  .get("/recientes", async (c) => {
    const user = c.get("user");
    // Listado acotado al alcance del usuario: el panel de stock y la pestaña
    // «Consumos» lo usan en lugar de la auditoría completa.
    const pedido = Number(c.req.query("limit"));
    const limit = Number.isInteger(pedido) && pedido > 0 ? Math.min(pedido, 500) : 20;
    if (user.rol === "admin") {
      const res = await c.env.DB.prepare(
        `SELECT m.id, m.accion, m.cantidad, m.descripcion, m.created_at, u.nombre AS usuario_nombre
         FROM movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id
         ORDER BY m.id DESC LIMIT ?`,
      ).bind(limit).all();
      return c.json({ items: res.results });
    }
    const permitidos = await centrosDeUsuario(c.env.DB, user.id);
    if (!permitidos.length) return c.json({ items: [] });
    const ph = marcas(permitidos.length);
    const res = await c.env.DB.prepare(
      `SELECT m.id, m.accion, m.cantidad, m.descripcion, m.created_at, u.nombre AS usuario_nombre
       FROM movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id
       WHERE (m.tabla = 'quimicos' AND m.registro_id IN (SELECT id FROM quimicos WHERE centro_id IN (${ph})))
          OR (m.tabla = 'material_limpieza' AND m.registro_id IN (SELECT id FROM material_limpieza WHERE centro_id IN (${ph})))
       ORDER BY m.id DESC LIMIT ?`,
    ).bind(...permitidos, ...permitidos, limit).all();
    return c.json({ items: res.results });
  })
  // Historial de movimientos de un artículo concreto (entradas, salidas,
  // consumos y ajustes) con su fecha, usuario, motivo y estación.
  .get("/historial", async (c) => {
    const user = c.get("user");
    if (user.rol === "usuario") return c.json({ error: "Requiere permisos de administrador" }, 403);
    const tabla = (c.req.query("tabla") ?? "").trim();
    const registroId = Number(c.req.query("registro_id"));
    if (!Object.values(STOCK).some((t) => t.tabla === tabla)) return c.json({ error: "tabla no válida" }, 400);
    if (!Number.isInteger(registroId) || registroId < 1) return c.json({ error: "registro_id no válido" }, 400);
    if (!(await articuloEnAlcance(c.env.DB, user, tabla, registroId))) {
      return c.json({ error: "Ese artículo no pertenece a tus centros" }, 403);
    }
    const periodo = leerPeriodo(c.req.query("desde"), c.req.query("hasta"));
    if ("error" in periodo) return c.json({ error: periodo.error }, 400);
    const res = await c.env.DB.prepare(
      `SELECT m.id, m.accion, m.cantidad, m.descripcion, m.motivo, m.created_at,
              u.nombre AS usuario_nombre, u.username,
              z.nombre AS zona_nombre, s.nombre AS subzona_nombre
       FROM movimientos m
       LEFT JOIN usuarios u ON u.id = m.usuario_id
       LEFT JOIN estaciones e ON e.id = m.estacion_id
       LEFT JOIN zonas z ON z.id = e.zona_id
       LEFT JOIN subzonas s ON s.id = e.subzona_id
       WHERE m.tabla = ? AND m.registro_id = ?${periodo.sql}
       ORDER BY m.created_at DESC, m.id DESC LIMIT 100`,
    ).bind(tabla, registroId, ...periodo.binds).all();
    return c.json({ tabla, registro_id: registroId, desde: periodo.desde, hasta: periodo.hasta, movimientos: res.results });
  })
  .post("/ajuste", async (c) => {
    const user = c.get("user");
    if (user.rol === "usuario") return c.json({ error: "Requiere permisos de administrador" }, 403);
    let body: { recurso?: unknown; id?: unknown; tipo?: unknown; cantidad?: unknown; motivo?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const recurso = typeof body.recurso === "string" ? body.recurso : "";
    const target = STOCK[recurso];
    if (!target) return c.json({ error: "Recurso no válido" }, 400);
    const tipo = typeof body.tipo === "string" ? body.tipo : "";
    if (tipo !== "entrada" && tipo !== "salida" && tipo !== "ajuste") return c.json({ error: "Tipo de movimiento no válido" }, 400);
    const id = Number(body.id), cantidad = Number(body.cantidad);
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    if (!(await articuloEnAlcance(c.env.DB, user, target.tabla, id))) {
      return c.json({ error: "Ese artículo no pertenece a tus centros" }, 403);
    }
    if (!Number.isInteger(cantidad) || cantidad < 0 || (tipo !== "ajuste" && cantidad < 1)) return c.json({ error: "La cantidad debe ser un número entero válido" }, 400);
    const motivo = typeof body.motivo === "string" && body.motivo.trim() ? body.motivo.trim().slice(0, 300) : null;
    // Cada tabla de stock tiene su propia columna de nombre (p. ej. «prenda» en ropa de trabajo).
    const item = await c.env.DB.prepare(`SELECT ${target.columnaNombre} AS nombre FROM ${target.tabla} WHERE id = ?`).bind(id).first();
    if (!item) return c.json({ error: "Registro no encontrado" }, 404);
    if (tipo === "ajuste") {
      await c.env.DB.prepare(`UPDATE ${target.tabla} SET ${target.columna} = ?, updated_at = datetime('now') WHERE id = ?`).bind(cantidad, id).run();
    } else {
      const signo = tipo === "entrada" ? "+" : "-";
      const upd = await c.env.DB.prepare(
        `UPDATE ${target.tabla} SET ${target.columna} = ${target.columna} ${signo} ?, updated_at = datetime('now') WHERE id = ?${tipo === "salida" ? ` AND ${target.columna} >= ?` : ""}`,
      ).bind(...(tipo === "salida" ? [cantidad, id, cantidad] : [cantidad, id])).run();
      if (tipo === "salida" && Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
        return c.json({ error: "Stock insuficiente para la salida" }, 400);
      }
    }
    // En químicos el estado sigue al stock (es lo que filtra el consumo FEFO):
    // un ajuste o una entrada no pueden dejar «agotado» un lote con garrafas.
    if (target.tabla === "quimicos") {
      await c.env.DB.prepare(
        `UPDATE quimicos SET estado = CASE WHEN num_garrafas > 0 THEN 'activo' ELSE 'agotado' END
         WHERE id = ? AND ((num_garrafas > 0 AND estado <> 'activo') OR (num_garrafas <= 0 AND estado = 'activo'))`,
      ).bind(id).run();
    }
    const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(id).first();
    await logMovimiento(c.env.DB, c.get("user"), tipo, target.tabla, id, `${String(item.nombre)} (${target.nombre})`, tipo === "ajuste" ? null : cantidad, motivo, null);
    return c.json({ ok: true, stock: row?.stock ?? null, mensaje: `Movimiento registrado. Stock actual: ${Number(row?.stock ?? 0)}` });
  });
