import { Hono } from "hono";
import type { D1Database, Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { logMovimiento } from "./audit";

// El estado actual de una máquina es su último registro del histórico; la
// columna `maquinaria.estado` se mantiene sincronizada para informes y panel.
export async function sincronizarEstado(db: D1Database, maquinaId: number): Promise<void> {
  const last = await db.prepare(
    `SELECT st.nombre AS nombre FROM maquinaria_historial h
     JOIN situaciones st ON st.id = h.situacion_id
     WHERE h.maquina_id = ? ORDER BY h.fecha DESC, h.id DESC LIMIT 1`,
  ).bind(maquinaId).first<{ nombre: string }>();
  if (last) {
    await db.prepare("UPDATE maquinaria SET estado = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(last.nombre, maquinaId).run();
  }
}

// Toda máquina creada nace con su primer registro: «Operativo» (o la primera
// situación disponible) con la marca, modelo y centro del momento.
export async function seedHistorial(db: D1Database, row: Record<string, unknown>): Promise<void> {
  const id = Number(row.id);
  if (!Number.isInteger(id) || id < 1) return;
  const existe = await db.prepare("SELECT 1 AS x FROM maquinaria_historial WHERE maquina_id = ?").bind(id).first();
  if (existe) return;
  const sit = await db.prepare("SELECT id FROM situaciones WHERE nombre = 'Operativo'").first()
    ?? await db.prepare("SELECT id FROM situaciones ORDER BY id LIMIT 1").first();
  if (!sit) return;
  await db.prepare(
    "INSERT INTO maquinaria_historial (maquina_id, fecha, situacion_id, marca, modelo, centro_id) VALUES (?, date('now'), ?, ?, ?, ?)",
  ).bind(id, Number(sit.id), row.marca ?? null, row.modelo ?? null, row.centro_id ?? null).run();
  await sincronizarEstado(db, id);
}

export const maquinariaHistorial = new Hono<{ Bindings: Env; Variables: Variables }>();
maquinariaHistorial.use("*", requireAuth);

// Histórico completo (o el de una máquina con ?maquina_id=).
maquinariaHistorial.get("/", async (c) => {
  const raw = Number(c.req.query("maquina_id"));
  const filtrar = Number.isInteger(raw) && raw >= 1;
  const res = await c.env.DB.prepare(
    `SELECT h.id, h.maquina_id, h.fecha, h.situacion_id, st.nombre AS situacion_nombre,
            h.marca, h.modelo, h.centro_id, c.nombre AS centro_nombre,
            m.nombre AS maquina_nombre, m.numero_serie, m.tipo
     FROM maquinaria_historial h
     JOIN situaciones st ON st.id = h.situacion_id
     LEFT JOIN maquinaria m ON m.id = h.maquina_id
     LEFT JOIN centros c ON c.id = h.centro_id
     ${filtrar ? "WHERE h.maquina_id = ?" : ""}
     ORDER BY h.fecha DESC, h.id DESC`,
  ).bind(...(filtrar ? [raw] : [])).all();
  return c.json({ items: res.results });
});

// Registrar una situación de una máquina: fecha, situación, marca, modelo y
// centro (por defecto, los de la máquina) y pasa a ser su estado actual.
maquinariaHistorial.post("/", async (c) => {
  const user = c.get("user");
  if (user.rol !== "admin") return c.json({ error: "Solo los administradores pueden registrar situaciones" }, 403);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  const maquinaId = Number(body.maquina_id);
  if (!Number.isInteger(maquinaId) || maquinaId < 1) return c.json({ error: "La máquina es obligatoria" }, 400);
  const maquina = await c.env.DB.prepare("SELECT id, nombre, marca, modelo, centro_id FROM maquinaria WHERE id = ?").bind(maquinaId).first();
  if (!maquina) return c.json({ error: "Máquina no encontrada" }, 404);
  const situacionId = Number(body.situacion_id);
  if (!Number.isInteger(situacionId) || situacionId < 1) return c.json({ error: "La situación es obligatoria" }, 400);
  const sit = await c.env.DB.prepare("SELECT id, nombre FROM situaciones WHERE id = ?").bind(situacionId).first();
  if (!sit) return c.json({ error: "La situación seleccionada no existe" }, 400);
  const fecha = typeof body.fecha === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.fecha) ? body.fecha : null;
  const marca = typeof body.marca === "string" && body.marca.trim() ? body.marca.trim() : (maquina.marca ?? null);
  const modelo = typeof body.modelo === "string" && body.modelo.trim() ? body.modelo.trim() : (maquina.modelo ?? null);
  const centroRaw = Number(body.centro_id);
  const centroId = Number.isInteger(centroRaw) && centroRaw >= 1 ? centroRaw : (maquina.centro_id ?? null);
  if (centroId !== null) {
    const ce = await c.env.DB.prepare("SELECT id FROM centros WHERE id = ?").bind(Number(centroId)).first();
    if (!ce) return c.json({ error: "El centro seleccionado no existe" }, 400);
  }
  await c.env.DB.prepare(
    "INSERT INTO maquinaria_historial (maquina_id, fecha, situacion_id, marca, modelo, centro_id) VALUES (?, COALESCE(?, date('now')), ?, ?, ?, ?)",
  ).bind(maquinaId, fecha, situacionId, marca, modelo, centroId).run();
  await sincronizarEstado(c.env.DB, maquinaId);
  await logMovimiento(c.env.DB, user, "situacion", "maquinaria", maquinaId,
    `Situación «${String(sit.nombre)}» registrada en «${String(maquina.nombre)}»`, null);
  return c.json({ ok: true }, 201);
});

// Borrar un registro (se recalcula el estado con el registro anterior).
maquinariaHistorial.delete("/:id", async (c) => {
  const user = c.get("user");
  if (user.rol !== "admin") return c.json({ error: "Solo los administradores pueden borrar registros" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
  const row = await c.env.DB.prepare(
    `SELECT h.id, h.maquina_id, st.nombre AS situacion_nombre, m.nombre AS maquina_nombre
     FROM maquinaria_historial h
     JOIN situaciones st ON st.id = h.situacion_id
     LEFT JOIN maquinaria m ON m.id = h.maquina_id
     WHERE h.id = ?`,
  ).bind(id).first();
  if (!row) return c.json({ error: "Registro no encontrado" }, 404);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM maquinaria_historial WHERE maquina_id = ?").bind(Number(row.maquina_id)).first();
  if (n && Number(n.n) <= 1) {
    return c.json({ error: "Es el único registro de la máquina: registra otra situación antes de borrarlo" }, 400);
  }
  await c.env.DB.prepare("DELETE FROM maquinaria_historial WHERE id = ?").bind(id).run();
  await sincronizarEstado(c.env.DB, Number(row.maquina_id));
  await logMovimiento(c.env.DB, user, "situacion", "maquinaria", Number(row.maquina_id),
    `Registro «${String(row.situacion_nombre)}» eliminado de «${String(row.maquina_nombre ?? `máquina #${String(row.maquina_id)}`)}»`, null);
  return c.json({ ok: true });
});
