import { Hono } from "hono";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import type { D1Database, Env } from "./d1";
import type { Variables } from "./types";
import { parseFecha, sumarIntervalo } from "./limpieza-plan";

// Formaciones, revisiones y carnets del personal: el catálogo define cuántos
// meses dura cada uno y cada operario tiene sus fechas. La caducidad se calcula
// siempre (fecha de realización + meses de validez) para que la matriz del
// centro y los avisos de 30 días usen el mismo dato.
type Row = Record<string, unknown>;

const TIPOS = ["formacion", "revision", "carnet"] as const;
export type TipoFormacion = (typeof TIPOS)[number];

function texto(valor: unknown, max: number): string | null {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function entero(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isInteger(valor) ? valor : null;
  if (typeof valor !== "string" || !valor.trim()) return null;
  const n = Number(valor);
  return Number.isInteger(n) ? n : null;
}

async function leerCuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Row;
  } catch { /* JSON inválido */ }
  return {};
}

async function centrosVisibles(db: D1Database, user: SessionUser): Promise<Array<{ id: number; nombre: string }>> {
  if (user.rol === "admin") {
    const res = await db.prepare("SELECT id, nombre FROM centros ORDER BY nombre COLLATE NOCASE").all<{ id: number; nombre: string }>();
    return res.results.map((c) => ({ id: Number(c.id), nombre: String(c.nombre) }));
  }
  return centrosDeUsuario(db, user.id);
}

async function puedeGestionar(db: D1Database, user: SessionUser, centroId: number | null): Promise<boolean> {
  if (user.rol === "admin") return true;
  if (user.rol !== "admin_centros") return false;
  if (!centroId) return false;
  const row = await db.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?")
    .bind(user.id, centroId).first();
  return Boolean(row);
}

/** Caducidad a partir de la fecha y los meses de validez del catálogo. */
function calcularCaducidad(fecha: string, meses: number): string | null {
  return meses > 0 ? sumarIntervalo(fecha, { unidad: "meses", valor: meses }) : null;
}

export const formacionesRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
formacionesRoutes.use("*", requireAuth);

// Matriz del centro: operarios, catálogo y la última titulación de cada uno.
// Sin `centro_id` (solo administradores) se listan todos los operarios activos.
formacionesRoutes.get("/matriz", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centros = await centrosVisibles(db, user);
  const centroId = entero(c.req.query("centro_id"));
  if (centroId !== null && !centros.some((x) => x.id === centroId)) {
    return c.json({ error: "No tienes acceso a ese centro" }, 403);
  }

  const usuarios = centroId
    ? await db.prepare(
      `SELECT u.id, u.nombre, u.username, u.activo FROM usuarios u
       JOIN usuario_centros uc ON uc.usuario_id = u.id
       WHERE uc.centro_id = ? AND u.activo = 1 ORDER BY u.nombre COLLATE NOCASE`,
    ).bind(centroId).all<Row>()
    : await db.prepare(
      `SELECT DISTINCT u.id, u.nombre, u.username, u.activo FROM usuarios u
       JOIN usuario_centros uc ON uc.usuario_id = u.id
       WHERE u.activo = 1 ORDER BY u.nombre COLLATE NOCASE`,
    ).all<Row>();

  const catalogo = await db.prepare(
    "SELECT id, nombre, tipo, meses_validez, notas FROM formaciones WHERE activo = 1 ORDER BY tipo, nombre COLLATE NOCASE",
  ).all<Row>();

  const asignaciones = await db.prepare(
    `SELECT of.id, of.usuario_id, of.formacion_id, of.centro_id, of.fecha, of.caducidad, of.notas,
            CAST(julianday(of.caducidad) - julianday('now') AS INTEGER) AS dias
     FROM operario_formaciones of
     WHERE of.usuario_id IN (SELECT id FROM usuarios)
     ORDER BY of.usuario_id, of.formacion_id, of.fecha DESC`,
  ).all<Row>();

  // Solo la titulación más reciente de cada operario y formación.
  const ultima = new Map<string, Row>();
  for (const fila of asignaciones.results) {
    const clave = `${String(fila.usuario_id)}|${String(fila.formacion_id)}`;
    if (!ultima.has(clave)) ultima.set(clave, fila);
  }

  const resumen = { vencidas: 0, proximas: 0, sin_caducidad: 0, asignadas: 0 };
  for (const fila of ultima.values()) {
    resumen.asignadas++;
    if (!fila.caducidad) { resumen.sin_caducidad++; continue; }
    const dias = Number(fila.dias);
    if (dias < 0) resumen.vencidas++;
    else if (dias <= 30) resumen.proximas++;
  }

  return c.json({
    centro: centroId ? centros.find((x) => x.id === centroId) ?? null : null,
    centros,
    usuarios: usuarios.results,
    catalogo: catalogo.results,
    asignaciones: [...ultima.values()],
    resumen,
    puede_gestionar: centroId ? await puedeGestionar(db, user, centroId) : user.rol === "admin",
  });
});

// Próximas a caducar (por defecto 30 días) y ya vencidas.
formacionesRoutes.get("/alertas", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const dias = entero(c.req.query("dias"));
  const limite = dias && dias > 0 ? dias : 30;
  const centros = await centrosVisibles(db, user);
  const ids = centros.map((x) => x.id);
  if (!ids.length) return c.json({ items: [], total: 0 });
  const marcas = ids.map(() => "?").join(", ");
  const res = await db.prepare(
    `SELECT of.id, of.usuario_id, of.formacion_id, of.caducidad, of.centro_id,
            u.nombre AS usuario, f.nombre AS formacion, f.tipo, c.nombre AS centro_nombre,
            CAST(julianday(of.caducidad) - julianday('now') AS INTEGER) AS dias
     FROM operario_formaciones of
     JOIN usuarios u ON u.id = of.usuario_id
     JOIN formaciones f ON f.id = of.formacion_id
     LEFT JOIN centros c ON c.id = of.centro_id
     WHERE of.caducidad IS NOT NULL
       AND of.caducidad <= date('now', '+' || ? || ' day')
       AND (of.centro_id IS NULL OR of.centro_id IN (${marcas}))
       AND NOT EXISTS (
         SELECT 1 FROM operario_formaciones o2
         WHERE o2.usuario_id = of.usuario_id AND o2.formacion_id = of.formacion_id AND o2.fecha > of.fecha)
     ORDER BY of.caducidad LIMIT 200`,
  ).bind(limite, ...ids).all<Row>();
  return c.json({ items: res.results, total: res.results.length, dias: limite });
});

// Asignar una formación/carnet/revisión a un operario. Repetir la misma fecha
// actualiza la ficha en lugar de duplicarla.
formacionesRoutes.post("/asignaciones", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const usuarioId = entero(body.usuario_id);
  const formacionId = entero(body.formacion_id);
  if (!usuarioId || !formacionId) return c.json({ error: "Indica el operario y la formación" }, 400);
  const usuario = await db.prepare("SELECT id, nombre FROM usuarios WHERE id = ?").bind(usuarioId).first<{ id: number; nombre: string }>();
  if (!usuario) return c.json({ error: "Operario no encontrado" }, 404);
  const formacion = await db.prepare("SELECT id, nombre, tipo, meses_validez FROM formaciones WHERE id = ?")
    .bind(formacionId).first<{ id: number; nombre: string; tipo: TipoFormacion; meses_validez: number }>();
  if (!formacion) return c.json({ error: "Formación no encontrada" }, 404);
  const fecha = parseFecha(body.fecha);
  if (!fecha) return c.json({ error: "Indica una fecha válida" }, 400);

  const centroId = entero(body.centro_id);
  if (centroId !== null && !(await puedeGestionar(db, user, centroId))) {
    return c.json({ error: "No puedes registrar formaciones en ese centro" }, 403);
  }
  if (!(await puedeGestionar(db, user, centroId))) {
    return c.json({ error: "Solo los responsables del centro pueden registrar formaciones" }, 403);
  }

  const caducidad = calcularCaducidad(fecha, Number(formacion.meses_validez ?? 0));
  const notas = texto(body.notas, 500);
  await db.prepare(
    `INSERT INTO operario_formaciones (usuario_id, formacion_id, centro_id, fecha, caducidad, notas)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(usuario_id, formacion_id, fecha) DO UPDATE SET
       caducidad = excluded.caducidad, centro_id = COALESCE(excluded.centro_id, operario_formaciones.centro_id),
       notas = COALESCE(excluded.notas, operario_formaciones.notas), updated_at = datetime('now')`,
  ).bind(usuarioId, formacionId, centroId, fecha, caducidad, notas).run();
  const fila = await db.prepare(
    "SELECT id FROM operario_formaciones WHERE usuario_id = ? AND formacion_id = ? AND fecha = ?",
  ).bind(usuarioId, formacionId, fecha).first<{ id: number }>();

  await logMovimiento(db, user, "alta", "operario_formaciones", fila ? Number(fila.id) : null,
    `Formación «${formacion.nombre}» de ${usuario.nombre}: ${fecha}${caducidad ? ` (caduca ${caducidad})` : " (sin caducidad)"}`, null, null);
  return c.json({ ok: true, id: fila ? Number(fila.id) : null, caducidad }, 201);
});

// Corregir la fecha o las notas de una ficha ya registrada.
formacionesRoutes.put("/asignaciones/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
  const fila = await db.prepare(
    `SELECT of.id, of.usuario_id, of.formacion_id, of.centro_id, of.fecha, f.meses_validez, f.nombre AS formacion,
            u.nombre AS usuario
     FROM operario_formaciones of JOIN formaciones f ON f.id = of.formacion_id JOIN usuarios u ON u.id = of.usuario_id
     WHERE of.id = ?`,
  ).bind(id).first<Row>();
  if (!fila) return c.json({ error: "Registro no encontrado" }, 404);
  if (!(await puedeGestionar(db, user, entero(fila.centro_id)))) {
    return c.json({ error: "No puedes editar este registro" }, 403);
  }
  const body = await leerCuerpo(c);
  const fecha = body.fecha === undefined ? String(fila.fecha) : parseFecha(body.fecha);
  if (!fecha) return c.json({ error: "Indica una fecha válida" }, 400);
  const caducidad = calcularCaducidad(fecha, Number(fila.meses_validez ?? 0));
  const notas = body.notas === undefined ? texto(fila.notas, 500) : texto(body.notas, 500);
  await db.prepare(
    "UPDATE operario_formaciones SET fecha = ?, caducidad = ?, notas = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(fecha, caducidad, notas, id).run();
  await logMovimiento(db, user, "edicion", "operario_formaciones", id,
    `Formación «${String(fila.formacion)}» de ${String(fila.usuario)} actualizada: ${fecha}${caducidad ? ` (caduca ${caducidad})` : ""}`, null, null);
  return c.json({ ok: true, fecha, caducidad });
});

formacionesRoutes.delete("/asignaciones/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
  const fila = await db.prepare(
    `SELECT of.id, of.centro_id, f.nombre AS formacion, u.nombre AS usuario
     FROM operario_formaciones of JOIN formaciones f ON f.id = of.formacion_id JOIN usuarios u ON u.id = of.usuario_id
     WHERE of.id = ?`,
  ).bind(id).first<Row>();
  if (!fila) return c.json({ error: "Registro no encontrado" }, 404);
  if (!(await puedeGestionar(db, user, entero(fila.centro_id)))) {
    return c.json({ error: "No puedes borrar este registro" }, 403);
  }
  await db.prepare("DELETE FROM operario_formaciones WHERE id = ?").bind(id).run();
  await logMovimiento(db, user, "borrado", "operario_formaciones", id,
    `Formación «${String(fila.formacion)}» de ${String(fila.usuario)} eliminada`, null, null);
  return c.json({ ok: true });
});

// Operarios y catálogo para el alta rápida.
formacionesRoutes.get("/opciones", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centros = await centrosVisibles(db, user);
  const ids = centros.map((x) => x.id);
  const usuarios = ids.length
    ? await db.prepare(
      `SELECT DISTINCT u.id, u.nombre, u.username FROM usuarios u
       JOIN usuario_centros uc ON uc.usuario_id = u.id
       WHERE u.activo = 1 AND uc.centro_id IN (${ids.map(() => "?").join(", ")})
       ORDER BY u.nombre COLLATE NOCASE`,
    ).bind(...ids).all<Row>()
    : await db.prepare("SELECT id, nombre, username FROM usuarios WHERE activo = 1 ORDER BY nombre COLLATE NOCASE").all<Row>();
  const catalogo = await db.prepare(
    "SELECT id, nombre, tipo, meses_validez FROM formaciones WHERE activo = 1 ORDER BY tipo, nombre COLLATE NOCASE",
  ).all<Row>();
  return c.json({ centros, usuarios: usuarios.results, catalogo: catalogo.results, tipos: TIPOS });
});
