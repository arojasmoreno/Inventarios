import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth, type SessionUser } from "./auth";
import { allowed } from "./crud";
import { logMovimiento } from "./audit";

// Entrega de equipación a operarios (ropa de trabajo y EPIs) desde el
// inventario: cada línea referencia un artículo del catálogo con su cantidad.
// Al guardar se descuenta el stock del artículo y queda como salida en la
// auditoría; al borrar la entrega, el stock se reintegra.
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

const EQUIPO: Record<string, { tabla: string; columna: string; columnaNombre: string }> = {
  ropa_trabajo: { tabla: "ropa_trabajo", columna: "stock", columnaNombre: "prenda" },
  epis: { tabla: "epis", columna: "stock", columnaNombre: "descripcion" },
};

// El rol «administrador de centros» solo puede dar de alta y borrar entregas en
// sus centros asignados; el administrador, en todos.
async function alcanceCentro(c: Ctx, user: SessionUser, centroId: number): Promise<string | null> {
  if (user.rol !== "admin_centros") return null;
  const own = await c.env.DB.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?")
    .bind(user.id, centroId).first();
  return own ? null : "Solo puedes gestionar entregas en los centros asignados a tu usuario";
}

interface Linea {
  tipo: string;
  id: number;
  cantidad: number;
  nombre: string;
  talla: string | null;
  color: string | null;
}

export const entregasRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // Listado (vista tabulada por operario), con filtros opcionales.
  .get("/", async (c) => {
    const where: string[] = [];
    const binds: number[] = [];
    const centroId = Number(c.req.query("centro_id"));
    const usuarioId = Number(c.req.query("usuario_id"));
    if (Number.isInteger(centroId) && centroId >= 1) { where.push("e.centro_id = ?"); binds.push(centroId); }
    if (Number.isInteger(usuarioId) && usuarioId >= 1) { where.push("e.usuario_id = ?"); binds.push(usuarioId); }
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.usuario_id, e.centro_id, e.fecha, e.prenda, e.articulo_tipo, e.articulo_id, e.cantidad,
              e.talla, e.alta_visibilidad, e.auxiliar_servicios, e.manga_larga, e.color, e.created_at, e.updated_at,
              u.nombre AS usuario_nombre, u.username AS usuario_username, c.nombre AS centro_nombre
       FROM ropa_entregas e
       LEFT JOIN usuarios u ON u.id = e.usuario_id
       LEFT JOIN centros c ON c.id = e.centro_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY u.nombre, e.fecha DESC, e.id`,
    ).bind(...binds).all();
    return c.json({ items: rows.results });
  })
  // Trabajadores activos asignados a un centro.
  .get("/trabajadores", async (c) => {
    const centroId = Number(c.req.query("centro_id"));
    if (!Number.isInteger(centroId) || centroId < 1) return c.json({ error: "Falta el centro de trabajo" }, 400);
    const rows = await c.env.DB.prepare(
      `SELECT id, nombre, username FROM usuarios
       WHERE activo = 1 AND id IN (SELECT usuario_id FROM usuario_centros WHERE centro_id = ?)
       ORDER BY nombre`,
    ).bind(centroId).all();
    return c.json({ items: rows.results });
  })
  // Alta: líneas del inventario (artículo + cantidad) con descuento de stock.
  .post("/", async (c) => {
    if (!allowed(c.get("user"), "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    let body: { centro_id?: unknown; usuario_id?: unknown; fecha?: unknown; lineas?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const centroId = Number(body.centro_id), usuarioId = Number(body.usuario_id);
    if (!Number.isInteger(centroId) || centroId < 1) return c.json({ error: "Elige el centro de trabajo" }, 400);
    if (!Number.isInteger(usuarioId) || usuarioId < 1) return c.json({ error: "Elige el trabajador" }, 400);
    const fuera = await alcanceCentro(c, c.get("user"), centroId);
    if (fuera) return c.json({ error: fuera }, 403);
    const centro = await c.env.DB.prepare("SELECT id FROM centros WHERE id = ?").bind(centroId).first();
    if (!centro) return c.json({ error: "El centro seleccionado no existe" }, 400);
    const trab = await c.env.DB.prepare("SELECT id, nombre FROM usuarios WHERE id = ? AND activo = 1").bind(usuarioId).first();
    if (!trab) return c.json({ error: "El trabajador seleccionado no existe o está desactivado" }, 400);
    // El trabajador debe estar asignado al centro elegido.
    const pertenece = await c.env.DB.prepare(
      `SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?`,
    ).bind(usuarioId, centroId).first();
    if (!pertenece) return c.json({ error: "El trabajador seleccionado no pertenece a ese centro de trabajo" }, 400);
    const fecha = typeof body.fecha === "string" && body.fecha ? body.fecha : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return c.json({ error: "La fecha no es válida" }, 400);
    if (!Array.isArray(body.lineas) || !body.lineas.length || body.lineas.length > 50) {
      return c.json({ error: "Añade al menos un artículo del inventario" }, 400);
    }
    // Valida cada línea contra el catálogo y acumula lo pedido por artículo.
    const lineas: Linea[] = [];
    const pedido = new Map<string, number>();
    for (const raw of body.lineas) {
      if (!raw || typeof raw !== "object") return c.json({ error: "Línea no válida" }, 400);
      const l = raw as Record<string, unknown>;
      const tipo = String(l.articulo_tipo ?? "");
      const cfg = EQUIPO[tipo];
      if (!cfg) return c.json({ error: "Tipo de artículo no válido (solo ropa de trabajo o EPIs)" }, 400);
      const id = Number(l.articulo_id), cantidad = Number(l.cantidad);
      if (!Number.isInteger(id) || id < 1) return c.json({ error: "Artículo no válido" }, 400);
      if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 999) return c.json({ error: "La cantidad debe ser un entero entre 1 y 999" }, 400);
      const art = await c.env.DB.prepare(
        `SELECT id, stock, ${cfg.columnaNombre} AS nombre, talla, color FROM ${cfg.tabla} WHERE id = ?`,
      ).bind(id).first();
      if (!art) return c.json({ error: "Uno de los artículos seleccionados ya no existe" }, 400);
      const key = `${tipo}:${id}`;
      const total = (pedido.get(key) ?? 0) + cantidad;
      if (total > Number(art.stock ?? 0)) {
        return c.json({ error: `Stock insuficiente para «${String(art.nombre)}»: hay ${Number(art.stock ?? 0)} y se piden ${total}` }, 400);
      }
      pedido.set(key, total);
      lineas.push({
        tipo, id, cantidad,
        nombre: String(art.nombre ?? `#${id}`),
        talla: art.talla == null ? null : String(art.talla),
        color: art.color == null ? null : String(art.color),
      });
    }
    // 1) Descuenta el stock (con guarda); si algo falla, se reintegra lo ya
    //    descontado para no dejar el inventario a medias.
    const aplicadas: Linea[] = [];
    for (const l of lineas) {
      const cfg = EQUIPO[l.tipo];
      const upd = await c.env.DB.prepare(
        `UPDATE ${cfg.tabla} SET ${cfg.columna} = ${cfg.columna} - ?, updated_at = datetime('now') WHERE id = ? AND ${cfg.columna} >= ?`,
      ).bind(l.cantidad, l.id, l.cantidad).run();
      if (Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
        for (const done of aplicadas) {
          const c2 = EQUIPO[done.tipo];
          await c.env.DB.prepare(`UPDATE ${c2.tabla} SET ${c2.columna} = ${c2.columna} + ? WHERE id = ?`)
            .bind(done.cantidad, done.id).run();
        }
        return c.json({ error: `Stock insuficiente para «${l.nombre}»` }, 400);
      }
      aplicadas.push(l);
    }
    // 2) Registra la entrega de cada línea.
    for (const l of lineas) {
      await c.env.DB.prepare(
        `INSERT INTO ropa_entregas (usuario_id, centro_id, fecha, prenda, articulo_tipo, articulo_id, cantidad, talla, color)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(usuarioId, centroId, fecha, l.nombre, l.tipo, l.id, l.cantidad, l.talla, l.color).run();
    }
    // 3) Auditoría: una salida por artículo entregado.
    for (const l of lineas) {
      await logMovimiento(c.env.DB, c.get("user"), "salida", l.tipo, l.id,
        `${l.nombre} entregado a ${String(trab.nombre)}`, l.cantidad, `Entrega de equipación ${fecha}`);
    }
    return c.json({ ok: true, creadas: lineas.length });
  })
  .delete("/:id", async (c) => {
    if (!allowed(c.get("user"), "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    const row = await c.env.DB.prepare(
      `SELECT e.id, e.prenda, e.centro_id, e.articulo_tipo, e.articulo_id, e.cantidad,
              u.nombre AS usuario_nombre
       FROM ropa_entregas e LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = ?`,
    ).bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    const fuera = await alcanceCentro(c, c.get("user"), Number(row.centro_id));
    if (fuera) return c.json({ error: fuera }, 403);
    const tipo = row.articulo_tipo == null ? "" : String(row.articulo_tipo);
    const cfg = EQUIPO[tipo];
    if (cfg && row.articulo_id != null && row.cantidad != null) {
      // Entrega del inventario: se reintegra el stock y se audita.
      await c.env.DB.prepare(`UPDATE ${cfg.tabla} SET ${cfg.columna} = ${cfg.columna} + ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(Number(row.cantidad), Number(row.articulo_id)).run();
      await logMovimiento(c.env.DB, c.get("user"), "entrada", tipo, Number(row.articulo_id),
        `Reintegro: «${String(row.prenda)}» de ${String(row.usuario_nombre ?? "operario")} (entrega eliminada)`,
        Number(row.cantidad), null);
    } else {
      // Filas antiguas (lista de prendas fijas): solo auditoría de borrado.
      await logMovimiento(c.env.DB, c.get("user"), "borrado", "ropa_entregas", id,
        `Entrega de ropa «${String(row.prenda)}» → ${String(row.usuario_nombre ?? "operario")}`, null, null);
    }
    await c.env.DB.prepare("DELETE FROM ropa_entregas WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  });
