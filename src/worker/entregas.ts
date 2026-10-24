import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth, type SessionUser } from "./auth";
import { allowed } from "./crud";
import { logMovimiento } from "./audit";

// Entrega de ropa por operario (centro → trabajador → tabla de prendas).
// Cada fila guarda talla, alta visibilidad, auxiliar de servicios, manga larga
// y color. Sin costes: solo importa el equipamiento entregado.
export const PRENDAS = [
  "Camiseta", "Pantalón", "Zapatos seguridad", "Botas de agua", "Guantes anticorte",
  "Casaca", "Pantalón casaca", "Chaqueton", "Polar", "Chaleco",
] as const;

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// El rol «administrador de centros» solo puede dar de alta y borrar entregas en
// sus centros asignados; el administrador, en todos.
async function alcanceCentro(c: Ctx, user: SessionUser, centroId: number): Promise<string | null> {
  if (user.rol !== "admin_centros") return null;
  const own = await c.env.DB.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?")
    .bind(user.id, centroId).first();
  return own ? null : "Solo puedes gestionar entregas en los centros asignados a tu usuario";
}

const flag = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v) === 1 ? 1 : 0);
const texto = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 40) : null);

export const entregasRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // Listado (para la vista tabulada por operario), con filtros opcionales.
  .get("/", async (c) => {
    const where: string[] = [];
    const binds: number[] = [];
    const centroId = Number(c.req.query("centro_id"));
    const usuarioId = Number(c.req.query("usuario_id"));
    if (Number.isInteger(centroId) && centroId >= 1) { where.push("e.centro_id = ?"); binds.push(centroId); }
    if (Number.isInteger(usuarioId) && usuarioId >= 1) { where.push("e.usuario_id = ?"); binds.push(usuarioId); }
    const rows = await c.env.DB.prepare(
      `SELECT e.id, e.usuario_id, e.centro_id, e.fecha, e.prenda, e.talla, e.alta_visibilidad,
              e.auxiliar_servicios, e.manga_larga, e.color, e.created_at, e.updated_at,
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
  // Alta/edición: recibe las prendas rellenadas y hace upsert por
  // (operario, prenda, fecha) para poder corregir una entrega del mismo día.
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
    if (!Array.isArray(body.lineas) || body.lineas.length > PRENDAS.length) return c.json({ error: "Prendas no válidas" }, 400);
    const lineas: Array<{ prenda: string; talla: string | null; av: number | null; aux: number | null; manga: number | null; color: string | null }> = [];
    for (const raw of body.lineas) {
      if (!raw || typeof raw !== "object") return c.json({ error: "Prenda no válida" }, 400);
      const l = raw as Record<string, unknown>;
      const prenda = typeof l.prenda === "string" ? l.prenda.trim() : "";
      if (!(PRENDAS as readonly string[]).includes(prenda)) return c.json({ error: `Prenda no reconocida: «${prenda || "?"}»` }, 400);
      const linea = {
        prenda,
        talla: texto(l.talla),
        av: flag(l.alta_visibilidad),
        aux: flag(l.auxiliar_servicios),
        manga: flag(l.manga_larga),
        color: texto(l.color),
      };
      // Las filas totalmente vacías se ignoran.
      if (linea.talla || linea.color || linea.av !== null || linea.aux !== null || linea.manga !== null) lineas.push(linea);
    }
    if (!lineas.length) return c.json({ error: "Rellena los datos de al menos una prenda" }, 400);
    let creadas = 0, actualizadas = 0;
    for (const l of lineas) {
      const exist = await c.env.DB.prepare("SELECT id FROM ropa_entregas WHERE usuario_id = ? AND prenda = ? AND fecha = ?")
        .bind(usuarioId, l.prenda, fecha).first();
      if (exist) {
        await c.env.DB.prepare(
          `UPDATE ropa_entregas SET centro_id = ?, talla = ?, alta_visibilidad = ?, auxiliar_servicios = ?, manga_larga = ?, color = ?, updated_at = datetime('now') WHERE id = ?`,
        ).bind(centroId, l.talla, l.av, l.aux, l.manga, l.color, Number(exist.id)).run();
        actualizadas++;
      } else {
        await c.env.DB.prepare(
          `INSERT INTO ropa_entregas (usuario_id, centro_id, fecha, prenda, talla, alta_visibilidad, auxiliar_servicios, manga_larga, color) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(usuarioId, centroId, fecha, l.prenda, l.talla, l.av, l.aux, l.manga, l.color).run();
        creadas++;
      }
    }
    await logMovimiento(c.env.DB, c.get("user"), creadas ? "alta" : "edicion", "ropa_entregas", null,
      `Entrega de ropa → ${String(trab.nombre)}: ${lineas.length} prenda${lineas.length === 1 ? "" : "s"} (${fecha})`, null, null);
    return c.json({ ok: true, creadas, actualizadas });
  })
  .delete("/:id", async (c) => {
    if (!allowed(c.get("user"), "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    const row = await c.env.DB.prepare(
      `SELECT e.id, e.prenda, e.centro_id, u.nombre AS usuario_nombre FROM ropa_entregas e
       LEFT JOIN usuarios u ON u.id = e.usuario_id WHERE e.id = ?`,
    ).bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    const fuera = await alcanceCentro(c, c.get("user"), Number(row.centro_id));
    if (fuera) return c.json({ error: fuera }, 403);
    await c.env.DB.prepare("DELETE FROM ropa_entregas WHERE id = ?").bind(id).run();
    await logMovimiento(c.env.DB, c.get("user"), "borrado", "ropa_entregas", id,
      `Entrega de ropa «${String(row.prenda)}» → ${String(row.usuario_nombre ?? "operario")}`, null, null);
    return c.json({ ok: true });
  });
