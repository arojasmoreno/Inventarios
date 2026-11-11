import { Hono } from "hono";
import type { CrudSpec } from "./crud";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth, requireAdmin } from "./auth";
import { logMovimiento } from "./audit";
import { leerPeriodo } from "./periodo";

// Auditoría: quién consumió o ajustó qué, cuándo y con qué cantidad.
// (Sin costes: solo interesa la cantidad de producto consumida.)
export { logMovimiento };
export const movimientosSpec: CrudSpec = {
  table: "movimientos", orderBy: "id", refUsuario: true, noAudit: true,
  extraSelect: ["t.accion", "t.tabla", "t.registro_id", "t.estacion_id", "t.descripcion", "t.cantidad", "t.motivo"],
  extraSearchCols: ["t.accion", "t.descripcion", "t.motivo"],
  read: "all", create: "admin", update: "admin", delete: "admin",
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

// Entradas, salidas y ajustes de stock (solo administradores).
export const movimientosRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // Historial de movimientos de un artículo concreto (entradas, salidas,
  // consumos y ajustes) con su fecha, usuario, motivo y estación.
  .get("/historial", requireAdmin, async (c) => {
    const tabla = (c.req.query("tabla") ?? "").trim();
    const registroId = Number(c.req.query("registro_id"));
    if (!Object.values(STOCK).some((t) => t.tabla === tabla)) return c.json({ error: "tabla no válida" }, 400);
    if (!Number.isInteger(registroId) || registroId < 1) return c.json({ error: "registro_id no válido" }, 400);
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
  .post("/ajuste", requireAdmin, async (c) => {
    let body: { recurso?: unknown; id?: unknown; tipo?: unknown; cantidad?: unknown; motivo?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const recurso = typeof body.recurso === "string" ? body.recurso : "";
    const target = STOCK[recurso];
    if (!target) return c.json({ error: "Recurso no válido" }, 400);
    const tipo = typeof body.tipo === "string" ? body.tipo : "";
    if (tipo !== "entrada" && tipo !== "salida" && tipo !== "ajuste") return c.json({ error: "Tipo de movimiento no válido" }, 400);
    const id = Number(body.id), cantidad = Number(body.cantidad);
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
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
    const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(id).first();
    await logMovimiento(c.env.DB, c.get("user"), tipo, target.tabla, id, `${String(item.nombre)} (${target.nombre})`, tipo === "ajuste" ? null : cantidad, motivo, null);
    return c.json({ ok: true, stock: row?.stock ?? null, mensaje: `Movimiento registrado. Stock actual: ${Number(row?.stock ?? 0)}` });
  });
