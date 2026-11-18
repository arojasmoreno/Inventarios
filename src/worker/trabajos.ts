import { Hono } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";

type Row = Record<string, unknown>;

// Órdenes de trabajo: limpieza, mantenimiento e incidencias de cada centro con
// su zona, operario asignado, prioridad, fechas y horas.
const TIPOS = ["limpieza", "mantenimiento", "incidencia", "otro"] as const;
const PRIORIDADES = ["baja", "normal", "alta", "urgente"] as const;
const ESTADOS = ["abierto", "en_curso", "pausado", "cerrado"] as const;
type Estado = (typeof ESTADOS)[number];

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
function decimal(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}
async function leerCuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Row;
  } catch { /* JSON inválido */ }
  return {};
}
function unoDe<T extends readonly string[]>(lista: T, valor: unknown, defecto: T[number]): T[number] {
  return typeof valor === "string" && (lista as readonly string[]).includes(valor) ? (valor as T[number]) : defecto;
}
async function centrosVisibles(db: D1Database, user: SessionUser): Promise<Array<{ id: number; nombre: string }>> {
  if (user.rol === "admin") {
    const res = await db.prepare("SELECT id, nombre FROM centros ORDER BY nombre COLLATE NOCASE").all<{ id: number; nombre: string }>();
    return res.results.map((c) => ({ id: Number(c.id), nombre: String(c.nombre) }));
  }
  return centrosDeUsuario(db, user.id);
}
async function puedeVerCentro(db: D1Database, user: SessionUser, centroId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  return Boolean(await db.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?").bind(user.id, centroId).first());
}
async function puedeGestionarCentro(db: D1Database, user: SessionUser, centroId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  if (user.rol !== "admin_centros") return false;
  return puedeVerCentro(db, user, centroId);
}

const SELECT_TRABAJO = `SELECT t.id, t.centro_id, t.zona_id, t.subzona_id, t.titulo, t.descripcion,
  t.tipo, t.prioridad, t.estado, t.operario_id, t.fecha_apertura, t.fecha_prevista,
  t.fecha_cierre, t.horas, t.material, t.notas, t.created_at, t.updated_at,
  c.nombre AS centro_nombre, z.nombre AS zona_nombre, s.nombre AS subzona_nombre,
  u.nombre AS operario_nombre,
  CASE WHEN t.estado <> 'cerrado' AND t.fecha_prevista IS NOT NULL
         AND date(t.fecha_prevista) < date('now') THEN 1 ELSE 0 END AS vencido,
  CASE WHEN t.estado <> 'cerrado' AND t.fecha_prevista IS NOT NULL
         AND date(t.fecha_prevista) < date('now')
       THEN CAST(julianday('now') - julianday(t.fecha_prevista) AS INTEGER) ELSE 0 END AS dias_retraso
  FROM trabajos t
  LEFT JOIN centros c ON c.id = t.centro_id
  LEFT JOIN zonas z ON z.id = t.zona_id
  LEFT JOIN subzonas s ON s.id = t.subzona_id
  LEFT JOIN usuarios u ON u.id = t.operario_id`;

async function validar(db: D1Database, user: SessionUser, body: Row, existente?: Row): Promise<{ datos: Row } | { error: string }> {
  const centroId = body.centro_id === undefined && existente ? Number(existente.centro_id) : entero(body.centro_id);
  if (!centroId) return { error: "Indica el centro del trabajo" };
  if (!(await puedeGestionarCentro(db, user, centroId))) return { error: "Solo los responsables del centro pueden gestionar sus trabajos" };
  const centro = await db.prepare("SELECT id FROM centros WHERE id = ?").bind(centroId).first();
  if (!centro) return { error: "El centro no existe" };
  const titulo = body.titulo === undefined && existente ? texto(existente.titulo, 160) : texto(body.titulo, 160);
  if (!titulo) return { error: "El título del trabajo es obligatorio" };
  const zonaId = body.zona_id === undefined ? (existente?.zona_id ?? null) : entero(body.zona_id);
  if (zonaId) {
    const zona = await db.prepare("SELECT id FROM zonas WHERE id = ? AND centro_id = ?").bind(zonaId, centroId).first();
    if (!zona) return { error: "La zona no pertenece al centro del trabajo" };
  }
  const subzonaId = body.subzona_id === undefined ? (existente?.subzona_id ?? null) : entero(body.subzona_id);
  if (subzonaId) {
    // La subzona debe colgar de la zona del trabajo (o, si no hay zona, ser del
    // mismo centro): sin esto se podían guardar subzonas de otra planta.
    const subzona = zonaId
      ? await db.prepare("SELECT id FROM subzonas WHERE id = ? AND zona_id = ?").bind(subzonaId, zonaId).first()
      : await db.prepare(
        "SELECT s.id FROM subzonas s JOIN zonas z ON z.id = s.zona_id WHERE s.id = ? AND z.centro_id = ?",
      ).bind(subzonaId, centroId).first();
    if (!subzona) return { error: "La subzona no pertenece a la zona del trabajo" };
  }
  const operarioId = body.operario_id === undefined ? (existente?.operario_id ?? null) : entero(body.operario_id);
  if (operarioId) {
    const u = await db.prepare("SELECT id FROM usuarios WHERE id = ?").bind(operarioId).first();
    if (!u) return { error: "El operario asignado no existe" };
  }
  const fechaPrevista = body.fecha_prevista === undefined
    ? texto(existente?.fecha_prevista, 10)
    : texto(body.fecha_prevista, 10);
  if (fechaPrevista && !/^\d{4}-\d{2}-\d{2}$/.test(fechaPrevista)) return { error: "La fecha prevista no es válida" };
  return {
    datos: {
      centro_id: centroId,
      zona_id: zonaId,
      subzona_id: subzonaId,
      titulo,
      descripcion: body.descripcion === undefined ? (existente?.descripcion ?? null) : texto(body.descripcion, 2000),
      tipo: body.tipo === undefined && existente ? String(existente.tipo) : unoDe(TIPOS, body.tipo, "limpieza"),
      prioridad: body.prioridad === undefined && existente ? String(existente.prioridad) : unoDe(PRIORIDADES, body.prioridad, "normal"),
      estado: body.estado === undefined && existente ? String(existente.estado) : unoDe(ESTADOS, body.estado, "abierto"),
      operario_id: operarioId,
      fecha_prevista: fechaPrevista,
      horas: body.horas === undefined ? (existente?.horas ?? null) : decimal(body.horas),
      material: body.material === undefined ? (existente?.material ?? null) : texto(body.material, 500),
      notas: body.notas === undefined ? (existente?.notas ?? null) : texto(body.notas, 2000),
    },
  };
}

export const trabajosRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
trabajosRoutes.use("*", requireAuth);

trabajosRoutes.get("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const visibles = await centrosVisibles(db, user);
  const centroId = entero(c.req.query("centro_id"));
  if (centroId && !visibles.some((x) => x.id === centroId)) return c.json({ error: "No tienes acceso a ese centro" }, 403);
  const ids = centroId ? [centroId] : visibles.map((x) => x.id);
  if (!ids.length) return c.json({ items: [], centros: visibles, puede_gestionar: false });
  const where = [`t.centro_id IN (${ids.map(() => "?").join(", ")})`];
  const params: unknown[] = [...ids];
  const estado = c.req.query("estado") ?? "";
  if ((ESTADOS as readonly string[]).includes(estado)) { where.push("t.estado = ?"); params.push(estado); }
  const q = (c.req.query("q") ?? "").trim();
  if (q) {
    where.push("(t.titulo LIKE ? OR t.descripcion LIKE ? OR u.nombre LIKE ? OR z.nombre LIKE ?)");
    for (let i = 0; i < 4; i++) params.push(`%${q}%`);
  }
  const res = await db.prepare(`${SELECT_TRABAJO} WHERE ${where.join(" AND ")} ORDER BY
    CASE t.prioridad WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
    CASE t.estado WHEN 'abierto' THEN 0 WHEN 'en_curso' THEN 1 WHEN 'pausado' THEN 2 ELSE 3 END,
    t.fecha_prevista IS NULL, t.fecha_prevista, t.id DESC`).bind(...params).all<Row>();
  return c.json({
    items: res.results,
    centros: visibles,
    puede_gestionar: user.rol !== "usuario" && visibles.length > 0,
    rol: user.rol,
  });
});

trabajosRoutes.get("/resumen", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const visibles = await centrosVisibles(db, user);
  if (!visibles.length) return c.json({ total: 0, por_estado: {}, vencidos: 0, cerrados_mes: 0, horas_mes: 0, por_centro: [] });
  const marcas = visibles.map(() => "?").join(", ");
  const ids = visibles.map((x) => x.id);
  const [estados, vencidos, cerrados, porCentro] = await Promise.all([
    db.prepare(`SELECT estado, COUNT(*) AS n FROM trabajos WHERE centro_id IN (${marcas}) GROUP BY estado`).bind(...ids).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM trabajos WHERE centro_id IN (${marcas}) AND estado <> 'cerrado'
      AND fecha_prevista IS NOT NULL AND date(fecha_prevista) < date('now')`).bind(...ids).first<Row>(),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(horas), 0) AS horas FROM trabajos
      WHERE centro_id IN (${marcas}) AND estado = 'cerrado' AND strftime('%Y-%m', fecha_cierre) = strftime('%Y-%m', 'now')`).bind(...ids).first<Row>(),
    db.prepare(`SELECT c.id, c.nombre,
        COUNT(t.id) AS total,
        COALESCE(SUM(CASE WHEN t.estado <> 'cerrado' THEN 1 ELSE 0 END), 0) AS abiertos,
        COALESCE(SUM(CASE WHEN t.estado <> 'cerrado' AND t.fecha_prevista IS NOT NULL
          AND date(t.fecha_prevista) < date('now') THEN 1 ELSE 0 END), 0) AS vencidos
      FROM centros c LEFT JOIN trabajos t ON t.centro_id = c.id
      WHERE c.id IN (${marcas}) GROUP BY c.id ORDER BY c.nombre COLLATE NOCASE`).bind(...ids).all<Row>(),
  ]);
  const porEstado: Record<string, number> = {};
  for (const e of estados.results) porEstado[String(e.estado)] = Number(e.n);
  return c.json({
    total: estados.results.reduce((n, e) => n + Number(e.n), 0),
    por_estado: porEstado,
    vencidos: Number(vencidos?.n ?? 0),
    cerrados_mes: Number(cerrados?.n ?? 0),
    horas_mes: Number(cerrados?.horas ?? 0),
    por_centro: porCentro.results,
  });
});

trabajosRoutes.post("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  if (user.rol === "usuario") return c.json({ error: "No tienes permiso para crear trabajos" }, 403);
  const body = await leerCuerpo(c);
  const r = await validar(db, user, body);
  if ("error" in r) return c.json({ error: r.error }, 400);
  const d = r.datos;
  const res = await db.prepare(
    `INSERT INTO trabajos (centro_id, zona_id, subzona_id, titulo, descripcion, tipo, prioridad, estado,
       operario_id, fecha_prevista, horas, material, notas, creado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(d.centro_id, d.zona_id, d.subzona_id, d.titulo, d.descripcion, d.tipo, d.prioridad, d.estado,
    d.operario_id, d.fecha_prevista, d.horas, d.material, d.notas, user.id).run();
  const id = Number((res.meta as { last_row_id?: number }).last_row_id);
  await logMovimiento(db, user, "alta", "trabajos", id, `Trabajo «${String(d.titulo)}» creado`, null, null);
  return c.json({ id, ok: true }, 201);
});

trabajosRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Trabajo no válido" }, 400);
  const existente = await db.prepare("SELECT * FROM trabajos WHERE id = ?").bind(id).first<Row>();
  if (!existente) return c.json({ error: "Trabajo no encontrado" }, 404);
  if (user.rol === "usuario" || !(await puedeGestionarCentro(db, user, Number(existente.centro_id)))) {
    return c.json({ error: "No tienes permiso para editar este trabajo" }, 403);
  }
  const body = await leerCuerpo(c);
  const r = await validar(db, user, body, existente);
  if ("error" in r) return c.json({ error: r.error }, 400);
  const d = r.datos;
  const cerrado = d.estado === "cerrado";
  const fechaCierre = cerrado ? (existente.fecha_cierre ?? new Date().toISOString().slice(0, 10)) : null;
  await db.prepare(
    `UPDATE trabajos SET centro_id = ?, zona_id = ?, subzona_id = ?, titulo = ?, descripcion = ?,
       tipo = ?, prioridad = ?, estado = ?, operario_id = ?, fecha_prevista = ?, fecha_cierre = ?,
       horas = ?, material = ?, notas = ?, updated_at = datetime('now') WHERE id = ?`,
  ).bind(d.centro_id, d.zona_id, d.subzona_id, d.titulo, d.descripcion, d.tipo, d.prioridad, d.estado,
    d.operario_id, d.fecha_prevista, fechaCierre, d.horas, d.material, d.notas, id).run();
  await logMovimiento(db, user, "edicion", "trabajos", id, `Trabajo «${String(d.titulo)}» actualizado`, null, null);
  return c.json({ ok: true });
});

// Cambio rápido de estado (abrir, en curso, pausar, cerrar).
trabajosRoutes.post("/:id/estado", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Trabajo no válido" }, 400);
  const trabajo = await db.prepare("SELECT * FROM trabajos WHERE id = ?").bind(id).first<Row>();
  if (!trabajo) return c.json({ error: "Trabajo no encontrado" }, 404);
  if (user.rol === "usuario" || !(await puedeGestionarCentro(db, user, Number(trabajo.centro_id)))) {
    return c.json({ error: "No tienes permiso para cambiar este trabajo" }, 403);
  }
  const body = await leerCuerpo(c);
  const estado = unoDe(ESTADOS, body.estado, "abierto") as Estado;
  if (body.estado !== estado) return c.json({ error: "Estado no válido" }, 400);
  const fechaCierre = estado === "cerrado" ? new Date().toISOString().slice(0, 10) : null;
  await db.prepare("UPDATE trabajos SET estado = ?, fecha_cierre = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(estado, fechaCierre, id).run();
  await logMovimiento(db, user, "edicion", "trabajos", id, `Trabajo «${String(trabajo.titulo)}» → ${estado}`, null, null);
  return c.json({ ok: true, estado });
});

trabajosRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Trabajo no válido" }, 400);
  const trabajo = await db.prepare("SELECT * FROM trabajos WHERE id = ?").bind(id).first<Row>();
  if (!trabajo) return c.json({ error: "Trabajo no encontrado" }, 404);
  if (user.rol !== "admin" && !(await puedeGestionarCentro(db, user, Number(trabajo.centro_id)))) {
    return c.json({ error: "No tienes permiso para borrar este trabajo" }, 403);
  }
  await db.prepare("DELETE FROM trabajos WHERE id = ?").bind(id).run();
  await logMovimiento(db, user, "borrado", "trabajos", id, `Trabajo «${String(trabajo.titulo)}» eliminado`, null, null);
  return c.json({ ok: true });
});

// Importación CSV de trabajos (una fila por trabajo).
trabajosRoutes.post("/import", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  if (user.rol === "usuario") return c.json({ error: "No tienes permiso para importar trabajos" }, 403);
  const body = await leerCuerpo(c);
  if (!Array.isArray(body.rows)) return c.json({ error: "Falta la lista de filas" }, 400);
  if (body.rows.length > 500) return c.json({ error: "Máximo 500 registros por importación" }, 400);
  let creados = 0;
  let actualizados = 0;
  const errores: string[] = [];
  for (let i = 0; i < body.rows.length; i++) {
    const raw = body.rows[i];
    if (!raw || typeof raw !== "object") { if (errores.length < 8) errores.push(`Fila ${i + 1}: no es un registro válido`); continue; }
    const fila = raw as Row;
    const centroId = entero(fila.centro_id);
    if (!centroId) { if (errores.length < 8) errores.push(`Fila ${i + 1}: falta el centro`); continue; }
    if (!(await puedeGestionarCentro(db, user, centroId))) { if (errores.length < 8) errores.push(`Fila ${i + 1}: no puedes gestionar ese centro`); continue; }
    const titulo = texto(fila.titulo, 160);
    if (!titulo) { if (errores.length < 8) errores.push(`Fila ${i + 1}: falta el título`); continue; }
    const fechaPrevista = texto(fila.fecha_prevista, 10);
    if (fechaPrevista && !/^\d{4}-\d{2}-\d{2}$/.test(fechaPrevista)) { if (errores.length < 8) errores.push(`Fila ${i + 1}: fecha prevista no válida`); continue; }
    const zonaId = entero(fila.zona_id);
    if (zonaId) {
      const zona = await db.prepare("SELECT id FROM zonas WHERE id = ? AND centro_id = ?").bind(zonaId, centroId).first();
      if (!zona) { if (errores.length < 8) errores.push(`Fila ${i + 1}: la zona no pertenece al centro`); continue; }
    }
    const subzonaId = entero(fila.subzona_id);
    if (subzonaId) {
      const subzona = zonaId
        ? await db.prepare("SELECT id FROM subzonas WHERE id = ? AND zona_id = ?").bind(subzonaId, zonaId).first()
        : await db.prepare(
          "SELECT s.id FROM subzonas s JOIN zonas z ON z.id = s.zona_id WHERE s.id = ? AND z.centro_id = ?",
        ).bind(subzonaId, centroId).first();
      if (!subzona) { if (errores.length < 8) errores.push(`Fila ${i + 1}: la subzona no pertenece a la zona`); continue; }
    }
    const datos = [
      zonaId, subzonaId, texto(fila.descripcion, 2000),
      unoDe(TIPOS, fila.tipo, "limpieza"), unoDe(PRIORIDADES, fila.prioridad, "normal"),
      unoDe(ESTADOS, fila.estado, "abierto"), entero(fila.operario_id), fechaPrevista,
      decimal(fila.horas), texto(fila.material, 500), texto(fila.notas, 2000),
    ];
    // Reimportar el mismo listado no crea trabajos repetidos: el trabajo se
    // identifica por centro + título (sin distinguir mayúsculas).
    const existente = await db.prepare(
      "SELECT id FROM trabajos WHERE centro_id = ? AND TRIM(UPPER(titulo)) = TRIM(UPPER(?)) LIMIT 1",
    ).bind(centroId, titulo).first<{ id: number }>();
    if (existente) {
      await db.prepare(
        `UPDATE trabajos SET zona_id = ?, subzona_id = ?, descripcion = ?, tipo = ?, prioridad = ?, estado = ?,
           operario_id = ?, fecha_prevista = ?, horas = ?, material = ?, notas = ?, updated_at = datetime('now')
         WHERE id = ?`,
      ).bind(...datos, Number(existente.id)).run();
      actualizados++;
    } else {
      await db.prepare(
        `INSERT INTO trabajos (zona_id, subzona_id, descripcion, tipo, prioridad, estado,
           operario_id, fecha_prevista, horas, material, notas, centro_id, titulo, creado_por)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(...datos, centroId, titulo, user.id).run();
      creados++;
    }
  }
  if (!creados && !actualizados && errores.length) return c.json({ error: errores[0], errores }, 400);
  await logMovimiento(db, user, "alta", "trabajos", null,
    `Importación de trabajos: ${creados} nuevo(s), ${actualizados} actualizado(s)`, null, null);
  return c.json({ creados, actualizados, errores });
});
