import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { allowed } from "./crud";
import { logMovimiento } from "./audit";

type Row = Record<string, unknown>;

export const tallas: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const user = c.get("user");
    if (!allowed(user, "admin")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const where: string[] = [];
    const binds: unknown[] = [];
    const usuarioId = Number(c.req.query("usuario_id"));
    if (Number.isInteger(usuarioId) && usuarioId >= 1) { where.push("t.usuario_id = ?"); binds.push(usuarioId); }
    const rows = await c.env.DB.prepare(
      `SELECT t.id, t.usuario_id, u.nombre AS usuario_nombre, u.username AS usuario_username,
              t.prenda, t.talla, t.notas, t.fecha, t.created_at, t.updated_at
       FROM tallas_operarios t
       LEFT JOIN usuarios u ON u.id = t.usuario_id
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY t.usuario_id, t.fecha DESC, t.id`
    ).bind(...binds).all<Row>();
    return c.json({ items: rows.results });
  })
  .post("/", async (c) => {
    if (!allowed(c.get("user"), "admin")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    let body: Row;
    try { body = await c.req.json<Row>(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const usuarioId = Number(body.usuario_id);
    if (!Number.isInteger(usuarioId) || usuarioId < 1) return c.json({ error: "Elige un operario" }, 400);
    const persona = await c.env.DB.prepare("SELECT id, nombre FROM usuarios WHERE id = ?").bind(usuarioId).first();
    if (!persona) return c.json({ error: "El operario no existe" }, 400);
    const prenda = (typeof body.prenda === "string" && body.prenda.trim()) ? body.prenda.trim() : null;
    if (!prenda) return c.json({ error: "La prenda es obligatoria" }, 400);
    const fecha = (typeof body.fecha === "string" && body.fecha.trim()) ? body.fecha.trim() : new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return c.json({ error: "La fecha no es válida" }, 400);
    if (body.id && Number(body.id) > 0) {
      await c.env.DB.prepare(`UPDATE tallas_operarios SET usuario_id = ?, prenda = ?, talla = ?, notas = ?, fecha = ?, updated_at = datetime('now') WHERE id = ?`)
        .bind(usuarioId, prenda, body.talla ?? null, body.notas ?? null, fecha, Number(body.id)).run();
      await logMovimiento(c.env.DB, c.get("user"), "edicion", "tallas_operarios", Number(body.id), `Talla «${prenda}» actualizada`, null, null);
    } else {
      await c.env.DB.prepare(`INSERT INTO tallas_operarios (usuario_id, prenda, talla, notas, fecha) VALUES (?, ?, ?, ?, ?)`)
        .bind(usuarioId, prenda, body.talla ?? null, body.notas ?? null, fecha).run();
      const id = await c.env.DB.prepare("SELECT last_insert_rowid() AS id").first();
      await logMovimiento(c.env.DB, c.get("user"), "alta", "tallas_operarios", Number(id?.id), `Talla «${prenda}» creada`, null, null);
    }
    return c.json({ ok: true });
  })
  // Importación masiva desde CSV: una fila por talla de operario. Los errores
  // de una fila no detienen el resto (se devuelven acumulados).
  .post("/import", async (c) => {
    if (!allowed(c.get("user"), "admin")) return c.json({ error: "No tienes permiso para importar registros" }, 403);
    let body: { rows?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    if (!Array.isArray(body.rows)) return c.json({ error: "Falta la lista de filas" }, 400);
    if (body.rows.length > 500) return c.json({ error: "Máximo 500 registros por importación" }, 400);
    let creados = 0;
    const errores: string[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      const raw = body.rows[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { if (errores.length < 8) errores.push(`Fila ${i + 1}: no es un registro válido`); continue; }
      const fila = raw as Row;
      const usuarioId = Number(fila.usuario_id);
      const prenda = typeof fila.prenda === "string" ? fila.prenda.trim() : "";
      const talla = typeof fila.talla === "string" ? fila.talla.trim() : "";
      if (!Number.isInteger(usuarioId) || usuarioId < 1) { if (errores.length < 8) errores.push(`Fila ${i + 1}: el operario no es válido`); continue; }
      if (!prenda) { if (errores.length < 8) errores.push(`Fila ${i + 1}: la prenda es obligatoria`); continue; }
      if (!talla) { if (errores.length < 8) errores.push(`Fila ${i + 1}: la talla es obligatoria`); continue; }
      const persona = await c.env.DB.prepare("SELECT id FROM usuarios WHERE id = ?").bind(usuarioId).first();
      if (!persona) { if (errores.length < 8) errores.push(`Fila ${i + 1}: el operario ${usuarioId} no existe`); continue; }
      const hoy = new Date().toISOString().slice(0, 10);
      const fecha = typeof fila.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fila.fecha) ? fila.fecha : hoy;
      await c.env.DB.prepare("INSERT INTO tallas_operarios (usuario_id, prenda, talla, notas, fecha) VALUES (?, ?, ?, ?, ?)")
        .bind(usuarioId, prenda, talla, typeof fila.notas === "string" && fila.notas.trim() ? fila.notas.trim() : null, fecha).run();
      creados++;
    }
    if (!creados && errores.length) return c.json({ error: errores[0], errores }, 400);
    await logMovimiento(c.env.DB, c.get("user"), "alta", "tallas_operarios", null, `Importación de tallas: ${creados} registro(s)`, null, null);
    return c.json({ creados, actualizados: 0, errores });
  })
  .put("/:id", async (c) => {
    if (!allowed(c.get("user"), "admin")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    let body: Row;
    try { body = await c.req.json<Row>(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const prev = await c.env.DB.prepare("SELECT * FROM tallas_operarios WHERE id = ?").bind(id).first();
    if (!prev) return c.json({ error: "Registro no encontrado" }, 404);
    const prenda = (typeof body.prenda === "string" && body.prenda.trim()) ? body.prenda.trim() : (prev.prenda == null ? null : String(prev.prenda));
    await c.env.DB.prepare(`UPDATE tallas_operarios SET usuario_id = ?, prenda = ?, talla = ?, notas = ?, fecha = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(Number(body.usuario_id) || Number(prev.usuario_id), prenda, body.talla ?? prev.talla, body.notas ?? prev.notas, body.fecha ?? prev.fecha, id).run();
    await logMovimiento(c.env.DB, c.get("user"), "edicion", "tallas_operarios", id, `Talla «${prenda}» actualizada`, null, null);
    return c.json({ ok: true });
  })
  .delete("/:id", async (c) => {
    if (!allowed(c.get("user"), "admin")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    const row = await c.env.DB.prepare("SELECT prenda FROM tallas_operarios WHERE id = ?").bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    await c.env.DB.prepare("DELETE FROM tallas_operarios WHERE id = ?").bind(id).run();
    await logMovimiento(c.env.DB, c.get("user"), "borrado", "tallas_operarios", id, `Talla «${String(row.prenda)}» eliminada`, null, null);
    return c.json({ ok: true });
  });
