import { Hono } from "hono";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import type { D1Database, D1Statement, Env } from "./d1";
import type { Variables } from "./types";
import { fechasDelMes, normalizar, parseFecha, parseFrecuencia, sumarIntervalo } from "./limpieza-plan";

// Plan de higiene: cada centro gestiona su propio calendario mensual y cada
// turno (día, tarde y noche) tiene sus faenas independientes. Las faenas se
// crean a mano, se les marcan los días del mes y cada operario va marcando las
// tareas que realiza. Los festivos pertenecen al centro y se muestran en sus
// tres turnos.
type Row = Record<string, unknown>;

const TURNOS = ["dia", "tarde", "noche"] as const;
type Turno = (typeof TURNOS)[number];
const ETIQUETA_TURNO: Record<Turno, string> = { dia: "Día", tarde: "Tarde", noche: "Noche" };

interface FaenaDb {
  id: number;
  centro_id: number;
  anio: number;
  mes: number;
  turno: Turno;
  zona: string;
  subzona: string | null;
  frecuencia_informativa: string | null;
  plan_id: number | null;
}

interface FaenaCalendario {
  id: number;
  zona: string;
  subzona: string | null;
  frecuencia_informativa: string | null;
  elemento: string | null;
  tipo_limpieza: string | null;
  dias: number[];
  registros: Array<{ dia: number; usuario_id: number; usuario: string; creado: string }>;
}

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

function esTurno(valor: unknown): valor is Turno {
  return valor === "dia" || valor === "tarde" || valor === "noche";
}

function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function fechaISO(anio: number, mes: number, dia: number): string {
  return `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

// Fecha de hoy en la zona horaria de los centros (España), para no bloquear el
// marcado de la tarea del día justo después de medianoche.
function hoyMadrid(): string {
  const partes = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const valor = (tipo: string) => partes.find((p) => p.type === tipo)?.value ?? "";
  return `${valor("year")}-${valor("month")}-${valor("day")}`;
}

function normalizarDias(valor: unknown, anio: number, mes: number): number[] | null {
  if (!Array.isArray(valor)) return null;
  const max = diasEnMes(anio, mes);
  const dias = new Set<number>();
  for (const raw of valor) {
    const dia = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(dia) || dia < 1 || dia > max) return null;
    dias.add(dia);
  }
  return [...dias].sort((a, b) => a - b);
}

async function leerCuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Row;
  } catch { /* JSON inválido */ }
  return {};
}

async function ejecutar(db: D1Database, statements: D1Statement[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
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
  const row = await db.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?")
    .bind(user.id, centroId).first();
  return Boolean(row);
}

async function puedeGestionarCentro(db: D1Database, user: SessionUser, centroId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  if (user.rol !== "admin_centros") return false;
  return puedeVerCentro(db, user, centroId);
}

async function cargarFaena(db: D1Database, id: number): Promise<FaenaDb | null> {
  return db.prepare(
    `SELECT id, centro_id, anio, mes, turno, zona, subzona, frecuencia_informativa, plan_id
     FROM limpieza_faenas WHERE id = ?`,
  ).bind(id).first<FaenaDb>();
}

function nombreFaena(zona: string, subzona: string | null): string {
  return subzona ? `${zona} / ${subzona}` : zona;
}

export const limpiezaRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
limpiezaRoutes.use("*", requireAuth);

// Centros a los que puede acceder el usuario. Un administrador ve todos; los
// demás perfiles, solo los que tengan asignados en `usuario_centros`.
limpiezaRoutes.get("/centros", async (c) => {
  const user = c.get("user");
  const centros = await centrosVisibles(c.env.DB, user);
  return c.json({
    centros,
    puede_gestionar: user.rol !== "usuario" && centros.length > 0,
    rol: user.rol,
  });
});

// Calendario de un centro, mes y turno. Devuelve las faenas con sus días
// programados y los registros de realización, además de los festivos y las
// zonas/subzonas del centro para ayudar a rellenar el formulario.
limpiezaRoutes.get("/calendario", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centroId = entero(c.req.query("centro_id"));
  const anio = entero(c.req.query("anio"));
  const mes = entero(c.req.query("mes"));
  const turno = c.req.query("turno") ?? "";
  if (!centroId || !anio || !mes || !esTurno(turno)) {
    return c.json({ error: "Indica centro, año, mes y turno válidos" }, 400);
  }
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) {
    return c.json({ error: "El año o el mes no son válidos" }, 400);
  }
  const centro = await db.prepare("SELECT id, nombre FROM centros WHERE id = ?").bind(centroId).first<{ id: number; nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeVerCentro(db, user, centroId))) {
    return c.json({ error: "No tienes acceso a este centro" }, 403);
  }

  const diasMes = diasEnMes(anio, mes);
  const desde = fechaISO(anio, mes, 1);
  const hasta = fechaISO(anio, mes, diasMes);
  const [filas, festivos, zonas, subzonas] = await Promise.all([
    db.prepare(
      `SELECT f.id, f.zona, f.subzona, f.frecuencia_informativa, p.elemento, p.tipo_limpieza,
              d.fecha, r.usuario_id, u.nombre AS usuario, r.created_at AS creado
       FROM limpieza_faenas f
       LEFT JOIN limpieza_plan p ON p.id = f.plan_id
       LEFT JOIN limpieza_dias d ON d.faena_id = f.id AND d.fecha BETWEEN ? AND ?
       LEFT JOIN limpieza_registros r ON r.faena_id = d.faena_id AND r.fecha = d.fecha
       LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE f.centro_id = ? AND f.anio = ? AND f.mes = ? AND f.turno = ?
       ORDER BY f.zona COLLATE NOCASE, f.subzona COLLATE NOCASE, f.id, d.fecha`,
    ).bind(desde, hasta, centroId, anio, mes, turno).all<{
      id: number; zona: string; subzona: string | null; frecuencia_informativa: string | null;
      elemento: string | null; tipo_limpieza: string | null;
      fecha: string | null; usuario_id: number | null; usuario: string | null; creado: string | null;
    }>(),
    db.prepare("SELECT fecha FROM limpieza_festivos WHERE centro_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha")
      .bind(centroId, desde, hasta).all<{ fecha: string }>(),
    db.prepare("SELECT nombre FROM zonas WHERE centro_id = ? ORDER BY nombre COLLATE NOCASE")
      .bind(centroId).all<{ nombre: string }>(),
    db.prepare(
      `SELECT z.nombre AS zona, s.nombre AS nombre
       FROM subzonas s JOIN zonas z ON z.id = s.zona_id
       WHERE z.centro_id = ? ORDER BY z.nombre COLLATE NOCASE, s.nombre COLLATE NOCASE`,
    ).bind(centroId).all<{ zona: string; nombre: string }>(),
  ]);

  const porFaena = new Map<number, FaenaCalendario>();
  for (const fila of filas.results) {
    const id = Number(fila.id);
    let faena = porFaena.get(id);
    if (!faena) {
      faena = {
        id,
        zona: String(fila.zona),
        subzona: fila.subzona ? String(fila.subzona) : null,
        frecuencia_informativa: fila.frecuencia_informativa ? String(fila.frecuencia_informativa) : null,
        elemento: fila.elemento ? String(fila.elemento) : null,
        tipo_limpieza: fila.tipo_limpieza ? String(fila.tipo_limpieza) : null,
        dias: [],
        registros: [],
      };
      porFaena.set(id, faena);
    }
    if (!fila.fecha) continue;
    const dia = Number(String(fila.fecha).slice(8, 10));
    if (faena.dias.includes(dia)) continue;
    faena.dias.push(dia);
    if (fila.usuario_id !== null && fila.usuario_id !== undefined) {
      faena.registros.push({
        dia,
        usuario_id: Number(fila.usuario_id),
        usuario: String(fila.usuario ?? ""),
        creado: String(fila.creado ?? ""),
      });
    }
  }

  return c.json({
    centro: { id: Number(centro.id), nombre: String(centro.nombre) },
    anio,
    mes,
    turno,
    dias_mes: diasMes,
    festivos: festivos.results.map((f) => String(f.fecha)),
    faenas: [...porFaena.values()],
    zonas: zonas.results.map((z) => String(z.nombre)),
    subzonas: subzonas.results.map((s) => ({ zona: String(s.zona), nombre: String(s.nombre) })),
    puede_gestionar: await puedeGestionarCentro(db, user, centroId),
  });
});

// Crear una faena manualmente en un turno del mes.
limpiezaRoutes.post("/faenas", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const centroId = entero(body.centro_id);
  const anio = entero(body.anio);
  const mes = entero(body.mes);
  const turno = body.turno;
  if (!centroId || !anio || !mes || !esTurno(turno)) {
    return c.json({ error: "Indica centro, año, mes y turno válidos" }, 400);
  }
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) {
    return c.json({ error: "El año o el mes no son válidos" }, 400);
  }
  const centro = await db.prepare("SELECT nombre FROM centros WHERE id = ?").bind(centroId).first<{ nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, centroId))) {
    return c.json({ error: "Solo los responsables del centro pueden crear faenas" }, 403);
  }
  const zona = texto(body.zona, 120);
  if (!zona) return c.json({ error: "La zona es obligatoria" }, 400);
  const subzona = texto(body.subzona, 120);
  const frecuencia = texto(body.frecuencia_informativa, 200);
  const dias = body.dias === undefined ? [] : normalizarDias(body.dias, anio, mes);
  if (dias === null) return c.json({ error: "Los días deben pertenecer al mes seleccionado" }, 400);

  const resultado = await db.prepare(
    `INSERT INTO limpieza_faenas (centro_id, anio, mes, turno, zona, subzona, frecuencia_informativa, creado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(centroId, anio, mes, turno, zona, subzona, frecuencia, user.id).run();
  const id = Number((resultado.meta as { last_row_id?: number }).last_row_id);
  if (!id) return c.json({ error: "No se pudo crear la faena" }, 500);

  await ejecutar(db, dias.map((dia) => db.prepare("INSERT OR IGNORE INTO limpieza_dias (faena_id, fecha) VALUES (?, ?)")
    .bind(id, fechaISO(anio, mes, dia))));
  await logMovimiento(
    db, user, "alta", "limpieza_faenas", id,
    `Faena «${nombreFaena(zona, subzona)}» creada en ${String(centro.nombre)}, turno ${ETIQUETA_TURNO[turno]}, ${String(mes).padStart(2, "0")}/${anio}`,
    null, null,
  );
  return c.json({ id, ok: true }, 201);
});

// Editar una faena y su plan de días. Al quitar un día también se borra la
// marca de realización de ese día, para no dejar registros huérfanos.
limpiezaRoutes.put("/faenas/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Faena no válida" }, 400);
  const faena = await cargarFaena(db, id);
  if (!faena) return c.json({ error: "Faena no encontrada" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(faena.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden editar faenas" }, 403);
  }
  const body = await leerCuerpo(c);
  const zona = body.zona === undefined ? faena.zona : texto(body.zona, 120);
  if (!zona) return c.json({ error: "La zona es obligatoria" }, 400);
  const subzona = body.subzona === undefined ? faena.subzona : texto(body.subzona, 120);
  const frecuencia = body.frecuencia_informativa === undefined
    ? faena.frecuencia_informativa
    : texto(body.frecuencia_informativa, 200);

  const existentes = await db.prepare("SELECT fecha FROM limpieza_dias WHERE faena_id = ?")
    .bind(id).all<{ fecha: string }>();
  const fechasExistentes = existentes.results.map((d) => String(d.fecha));
  let dias: number[];
  if (body.dias === undefined) {
    dias = fechasExistentes.map((fecha) => Number(fecha.slice(8, 10)));
  } else {
    const normalizados = normalizarDias(body.dias, Number(faena.anio), Number(faena.mes));
    if (normalizados === null) return c.json({ error: "Los días deben pertenecer al mes seleccionado" }, 400);
    dias = normalizados;
  }
  const nuevas = new Set(dias.map((dia) => fechaISO(Number(faena.anio), Number(faena.mes), dia)));
  const anteriores = new Set(fechasExistentes);
  const quitadas = [...anteriores].filter((fecha) => !nuevas.has(fecha));
  const anadidas = [...nuevas].filter((fecha) => !anteriores.has(fecha));

  const statements: D1Statement[] = [
    db.prepare(
      "UPDATE limpieza_faenas SET zona = ?, subzona = ?, frecuencia_informativa = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(zona, subzona, frecuencia, id),
  ];
  for (const fecha of quitadas) {
    statements.push(db.prepare("DELETE FROM limpieza_registros WHERE faena_id = ? AND fecha = ?").bind(id, fecha));
    statements.push(db.prepare("DELETE FROM limpieza_dias WHERE faena_id = ? AND fecha = ?").bind(id, fecha));
  }
  for (const fecha of anadidas) {
    statements.push(db.prepare("INSERT OR IGNORE INTO limpieza_dias (faena_id, fecha) VALUES (?, ?)").bind(id, fecha));
  }
  await ejecutar(db, statements);
  await logMovimiento(
    db, user, "edicion", "limpieza_faenas", id,
    `Faena «${nombreFaena(zona, subzona)}» actualizada (${dias.length} días programados)`,
    null, null,
  );
  return c.json({ ok: true, id });
});

// Marcar o desmarcar un único día desde la celda del calendario.
limpiezaRoutes.post("/faenas/:id/dias", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Faena no válida" }, 400);
  const faena = await cargarFaena(db, id);
  if (!faena) return c.json({ error: "Faena no encontrada" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(faena.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden planificar días" }, 403);
  }
  const body = await leerCuerpo(c);
  const dia = entero(body.dia);
  if (!dia || dia < 1 || dia > diasEnMes(Number(faena.anio), Number(faena.mes))) {
    return c.json({ error: "Día no válido para este mes" }, 400);
  }
  if (typeof body.activo !== "boolean") return c.json({ error: "Indica si el día queda activo" }, 400);
  const fecha = fechaISO(Number(faena.anio), Number(faena.mes), dia);
  if (body.activo) {
    await db.prepare("INSERT OR IGNORE INTO limpieza_dias (faena_id, fecha) VALUES (?, ?)").bind(id, fecha).run();
  } else {
    await ejecutar(db, [
      db.prepare("DELETE FROM limpieza_registros WHERE faena_id = ? AND fecha = ?").bind(id, fecha),
      db.prepare("DELETE FROM limpieza_dias WHERE faena_id = ? AND fecha = ?").bind(id, fecha),
    ]);
  }
  return c.json({ ok: true, dia, activo: body.activo });
});

// Borrar una faena completa (sus días y marcas se eliminan con ella).
limpiezaRoutes.delete("/faenas/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Faena no válida" }, 400);
  const faena = await cargarFaena(db, id);
  if (!faena) return c.json({ error: "Faena no encontrada" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(faena.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden borrar faenas" }, 403);
  }
  await ejecutar(db, [
    db.prepare("DELETE FROM limpieza_registros WHERE faena_id = ?").bind(id),
    db.prepare("DELETE FROM limpieza_dias WHERE faena_id = ?").bind(id),
    db.prepare("DELETE FROM limpieza_faenas WHERE id = ?").bind(id),
  ]);
  await logMovimiento(
    db, user, "borrado", "limpieza_faenas", id,
    `Faena «${nombreFaena(faena.zona, faena.subzona)}» eliminada (turno ${ETIQUETA_TURNO[faena.turno]}, ${String(faena.mes).padStart(2, "0")}/${faena.anio})`,
    null, null,
  );
  return c.json({ ok: true });
});

// Guardar los festivos del mes de un centro. Se envía la lista completa y se
// reemplaza la del mes, así el ajuste es idempotente.
limpiezaRoutes.put("/festivos", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const centroId = entero(body.centro_id);
  const anio = entero(body.anio);
  const mes = entero(body.mes);
  if (!centroId || !anio || !mes) return c.json({ error: "Indica centro, año y mes" }, 400);
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) {
    return c.json({ error: "El año o el mes no son válidos" }, 400);
  }
  const centro = await db.prepare("SELECT nombre FROM centros WHERE id = ?").bind(centroId).first<{ nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, centroId))) {
    return c.json({ error: "Solo los responsables del centro pueden cambiar los festivos" }, 403);
  }
  if (!Array.isArray(body.fechas) || body.fechas.length > 31) {
    return c.json({ error: "La lista de festivos no es válida" }, 400);
  }
  const max = diasEnMes(anio, mes);
  const prefijo = `${String(anio).padStart(4, "0")}-${String(mes).padStart(2, "0")}-`;
  const fechas = [...new Set(body.fechas.map((f) => String(f)))].sort();
  for (const fecha of fechas) {
    if (!fecha.startsWith(prefijo)) return c.json({ error: "Hay un festivo fuera del mes seleccionado" }, 400);
    const dia = Number(fecha.slice(8, 10));
    if (!Number.isInteger(dia) || dia < 1 || dia > max) {
      return c.json({ error: "Hay un festivo con una fecha no válida" }, 400);
    }
  }

  const desde = fechaISO(anio, mes, 1);
  const hasta = fechaISO(anio, mes, max);
  const statements: D1Statement[] = [
    db.prepare("DELETE FROM limpieza_festivos WHERE centro_id = ? AND fecha BETWEEN ? AND ?").bind(centroId, desde, hasta),
  ];
  for (const fecha of fechas) {
    statements.push(db.prepare("INSERT INTO limpieza_festivos (centro_id, fecha) VALUES (?, ?)").bind(centroId, fecha));
  }
  await ejecutar(db, statements);
  await logMovimiento(
    db, user, "edicion", "limpieza_festivos", null,
    `Festivos de ${String(centro.nombre)} (${String(mes).padStart(2, "0")}/${anio}): ${fechas.length}`,
    null, null,
  );
  return c.json({ ok: true, festivos: fechas });
});

// --------------------------------------------------------------- Plan de higiene
// El plan de higiene llega en Excel (una fila por tarea y centro) y se guarda
// aparte del calendario. De él se generan las faenas de cada mes usando
// proxima_fecha = última realización + frecuencia_calculo.

interface PlanDb {
  id: number;
  zona: string;
  subzona: string | null;
  tipo_limpieza: string | null;
  elemento: string | null;
  frecuencia_calculo: string;
  frecuencia_informativa: string | null;
  turno: string;
  fecha_inicio: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
}

interface PlanImportada {
  fila: number;
  centro_id: number;
  tipo_limpieza: string | null;
  zona: string;
  subzona: string | null;
  tipo_zona: string | null;
  elemento: string | null;
  frecuencia_calculo: string;
  frecuencia_informativa: string | null;
  tiempo: number | null;
  factor: number | null;
  horas_semana: number | null;
  turno: Turno;
  auditable: number;
  fecha_inicio: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
}

/** Número de una celda de Excel (admite coma decimal). */
function decimal(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor !== "string" || !valor.trim()) return null;
  const n = Number(valor.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** Casilla «auditable»: admite sí/no, x, true/false y 1/0. */
function booleano(valor: unknown): number {
  if (typeof valor === "boolean") return valor ? 1 : 0;
  if (typeof valor === "number") return valor ? 1 : 0;
  const t = normalizar(String(valor ?? ""));
  return t === "si" || t === "x" || t === "true" || t === "1" || t === "yes" ? 1 : 0;
}

/** Identifica una tarea del plan: al reimportar se actualiza la existente en
 *  lugar de duplicarla. */
function clavePlan(t: { zona: string; subzona: string | null; elemento: string | null; tipo_limpieza: string | null; turno: string }): string {
  return [t.zona, t.subzona, t.elemento, t.tipo_limpieza, t.turno].map((v) => normalizar(v ?? "")).join("|");
}

async function ejecutarLotes(db: D1Database, statements: D1Statement[], tam = 80): Promise<void> {
  for (let i = 0; i < statements.length; i += tam) await ejecutar(db, statements.slice(i, i + tam));
}

/** Al marcar una tarea como realizada, la próxima fecha del plan avanza. */
async function avanzarPlan(db: D1Database, planId: number, fecha: string): Promise<void> {
  const plan = await db.prepare("SELECT frecuencia_calculo FROM limpieza_plan WHERE id = ?")
    .bind(planId).first<{ frecuencia_calculo: string }>();
  if (!plan) return;
  const intervalo = parseFrecuencia(plan.frecuencia_calculo);
  await db.prepare(
    "UPDATE limpieza_plan SET ultima_realizacion = ?, proxima_fecha = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(fecha, intervalo ? sumarIntervalo(fecha, intervalo) : null, planId).run();
}

/** Al desmarcar una tarea del plan, la próxima fecha vuelve a calcularse: se
 *  toma la última realización que quede marcada o, si no queda ninguna, el día
 *  que se acaba de desmarcar (vuelve a estar pendiente). */
async function recalcularProxima(db: D1Database, planId: number, fechaRetirada: string): Promise<void> {
  const plan = await db.prepare("SELECT frecuencia_calculo FROM limpieza_plan WHERE id = ?")
    .bind(planId).first<{ frecuencia_calculo: string }>();
  if (!plan) return;
  const restante = await db.prepare(
    `SELECT MAX(r.fecha) AS fecha FROM limpieza_registros r
     JOIN limpieza_faenas f ON f.id = r.faena_id WHERE f.plan_id = ?`,
  ).bind(planId).first<{ fecha: string | null }>();
  const ultima = restante?.fecha ? String(restante.fecha) : null;
  const intervalo = parseFrecuencia(plan.frecuencia_calculo);
  if (!ultima) {
    await db.prepare(
      "UPDATE limpieza_plan SET proxima_fecha = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(fechaRetirada, planId).run();
    return;
  }
  await db.prepare(
    "UPDATE limpieza_plan SET ultima_realizacion = ?, proxima_fecha = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(ultima, intervalo ? sumarIntervalo(ultima, intervalo) : null, planId).run();
}

// Tareas del plan de un centro (lo que se ha cargado desde Excel).
limpiezaRoutes.get("/plan", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centroId = entero(c.req.query("centro_id"));
  if (!centroId) return c.json({ error: "Indica el centro" }, 400);
  if (!(await puedeVerCentro(db, user, centroId))) return c.json({ error: "No tienes acceso a este centro" }, 403);
  const res = await db.prepare(
    `SELECT id, tipo_limpieza, zona, subzona, tipo_zona, elemento, frecuencia_calculo,
            frecuencia_informativa, tiempo, factor, horas_semana, turno, auditable,
            fecha_inicio, ultima_realizacion, proxima_fecha
     FROM limpieza_plan WHERE centro_id = ?
     ORDER BY turno, zona COLLATE NOCASE, subzona COLLATE NOCASE, elemento COLLATE NOCASE`,
  ).bind(centroId).all<PlanDb>();
  return c.json({
    centro_id: centroId,
    tareas: res.results,
    total: res.results.length,
    puede_gestionar: await puedeGestionarCentro(db, user, centroId),
  });
});

// Carga masiva del plan desde el Excel: reemplaza lo que había de cada centro
// (actualiza las tareas que coinciden y borra las que ya no vienen).
limpiezaRoutes.post("/plan/importar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const filas = Array.isArray(body.filas) ? body.filas : [];
  if (!filas.length) return c.json({ error: "El archivo no contiene tareas que importar" }, 400);
  if (filas.length > 5000) return c.json({ error: "El plan admite hasta 5000 tareas por importación" }, 400);

  const errores: Array<{ fila: number; mensaje: string }> = [];
  const porCentro = new Map<number, PlanImportada[]>();
  const permisos = new Map<number, boolean>();

  for (let i = 0; i < filas.length; i++) {
    const datos = filas[i];
    if (!datos || typeof datos !== "object" || Array.isArray(datos)) continue;
    const fila = entero((datos as Row).fila) ?? i + 2;
    const centroId = entero((datos as Row).centro_id);
    if (!centroId) { errores.push({ fila, mensaje: "No se indica el centro (columna «cliente»)" }); continue; }
    if (!permisos.has(centroId)) permisos.set(centroId, await puedeGestionarCentro(db, user, centroId));
    if (!permisos.get(centroId)) { errores.push({ fila, mensaje: "No puedes cargar el plan de ese centro" }); continue; }
    const zona = texto((datos as Row).zona, 120);
    if (!zona) { errores.push({ fila, mensaje: "Falta la zona (columna «centro»)" }); continue; }
    const frecuenciaCalculo = texto((datos as Row).frecuencia_calculo, 200);
    if (!frecuenciaCalculo) { errores.push({ fila, mensaje: "Falta la frecuencia de cálculo" }); continue; }
    const inicio = parseFecha((datos as Row).fecha_inicio);
    const ultima = parseFecha((datos as Row).ultima_realizacion);
    const intervalo = parseFrecuencia(frecuenciaCalculo);
    const origen = ultima ?? inicio;
    const prevista = parseFecha((datos as Row).proxima_fecha)
      ?? (intervalo && origen ? sumarIntervalo(origen, intervalo) : null);
    const turnoCrudo = (datos as Row).turno;
    const turno: Turno = esTurno(turnoCrudo) ? turnoCrudo : "dia";
    const tarea: PlanImportada = {
      fila,
      centro_id: centroId,
      tipo_limpieza: texto((datos as Row).tipo_limpieza, 120),
      zona,
      subzona: texto((datos as Row).subzona, 120),
      tipo_zona: texto((datos as Row).tipo_zona, 120),
      elemento: texto((datos as Row).elemento, 160),
      frecuencia_calculo: frecuenciaCalculo,
      frecuencia_informativa: texto((datos as Row).frecuencia_informativa, 200),
      tiempo: decimal((datos as Row).tiempo),
      factor: decimal((datos as Row).factor),
      horas_semana: decimal((datos as Row).horas_semana),
      turno,
      auditable: booleano((datos as Row).auditable),
      fecha_inicio: inicio,
      ultima_realizacion: ultima,
      proxima_fecha: prevista,
    };
    const lista = porCentro.get(centroId) ?? [];
    lista.push(tarea);
    porCentro.set(centroId, lista);
  }

  let insertadas = 0;
  let actualizadas = 0;
  let eliminadas = 0;

  for (const [centroId, tareas] of porCentro) {
    const existentes = await db.prepare(
      "SELECT id, zona, subzona, elemento, tipo_limpieza, turno FROM limpieza_plan WHERE centro_id = ?",
    ).bind(centroId).all<{ id: number; zona: string; subzona: string | null; elemento: string | null; tipo_limpieza: string | null; turno: string }>();
    const porClave = new Map<string, number>();
    for (const fila of existentes.results) {
      porClave.set(clavePlan({ zona: String(fila.zona), subzona: fila.subzona, elemento: fila.elemento, tipo_limpieza: fila.tipo_limpieza, turno: String(fila.turno) }), Number(fila.id));
    }
    const conservadas = new Set<number>();
    const vistas = new Map<string, number>();
    const statements: D1Statement[] = [];

    for (const t of tareas) {
      const clave = clavePlan(t);
      const actual = porClave.get(clave);
      if (actual) conservadas.add(actual);
      if (vistas.has(clave)) {
        errores.push({ fila: t.fila, mensaje: `Tarea repetida: «${t.zona}${t.subzona ? ` / ${t.subzona}` : ""}» ya aparecía en la fila ${vistas.get(clave)}` });
        continue;
      }
      vistas.set(clave, t.fila);
      if (actual) {
        actualizadas++;
        statements.push(db.prepare(
          `UPDATE limpieza_plan SET tipo_limpieza = ?, tipo_zona = ?, elemento = ?, subzona = ?,
                  frecuencia_calculo = ?, frecuencia_informativa = ?, tiempo = ?, factor = ?, horas_semana = ?,
                  turno = ?, auditable = ?, fecha_inicio = ?, ultima_realizacion = ?, proxima_fecha = ?,
                  updated_at = datetime('now')
           WHERE id = ?`,
        ).bind(t.tipo_limpieza, t.tipo_zona, t.elemento, t.subzona, t.frecuencia_calculo, t.frecuencia_informativa,
          t.tiempo, t.factor, t.horas_semana, t.turno, t.auditable, t.fecha_inicio, t.ultima_realizacion, t.proxima_fecha, actual));
      } else {
        insertadas++;
        statements.push(db.prepare(
          `INSERT INTO limpieza_plan (centro_id, tipo_limpieza, zona, subzona, tipo_zona, elemento, frecuencia_calculo,
                                    frecuencia_informativa, tiempo, factor, horas_semana, turno, auditable,
                                    fecha_inicio, ultima_realizacion, proxima_fecha, creado_por)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(centroId, t.tipo_limpieza, t.zona, t.subzona, t.tipo_zona, t.elemento, t.frecuencia_calculo,
          t.frecuencia_informativa, t.tiempo, t.factor, t.horas_semana, t.turno, t.auditable,
          t.fecha_inicio, t.ultima_realizacion, t.proxima_fecha, user.id));
      }
    }

    const sobrantes = existentes.results.map((f) => Number(f.id)).filter((id) => !conservadas.has(id));
    // Se borran las tareas que ya no vienen en el archivo (por tandas: D1 admite
    // como máximo 100 parámetros por sentencia).
    for (let i = 0; i < sobrantes.length; i += 90) {
      const tanda = sobrantes.slice(i, i + 90);
      const marcas = tanda.map(() => "?").join(", ");
      statements.push(db.prepare(`UPDATE limpieza_faenas SET plan_id = NULL WHERE plan_id IN (${marcas})`).bind(...tanda));
      statements.push(db.prepare(`DELETE FROM limpieza_plan WHERE id IN (${marcas})`).bind(...tanda));
      eliminadas += tanda.length;
    }
    await ejecutarLotes(db, statements);
  }

  await logMovimiento(db, user, "alta", "limpieza_plan", null,
    `Plan de higiene importado: ${insertadas} tareas nuevas, ${actualizadas} actualizadas, ${eliminadas} quitadas`, null, null);
  return c.json({ ok: true, insertadas, actualizadas, eliminadas, centros: [...porCentro.keys()], errores });
});

// Genera el calendario de un mes a partir del plan: crea (o actualiza) las
// faenas del turno de cada tarea con los días que toca según su frecuencia.
limpiezaRoutes.post("/plan/generar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const centroId = entero(body.centro_id);
  const anio = entero(body.anio);
  const mes = entero(body.mes);
  if (!centroId || !anio || !mes) return c.json({ error: "Indica centro, año y mes" }, 400);
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) return c.json({ error: "El año o el mes no son válidos" }, 400);
  const centro = await db.prepare("SELECT nombre FROM centros WHERE id = ?").bind(centroId).first<{ nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, centroId))) {
    return c.json({ error: "Solo los responsables del centro pueden generar el calendario" }, 403);
  }
  const plan = await db.prepare(
    `SELECT id, zona, subzona, tipo_limpieza, elemento, frecuencia_calculo, frecuencia_informativa,
            turno, fecha_inicio, ultima_realizacion, proxima_fecha
     FROM limpieza_plan WHERE centro_id = ?
     ORDER BY turno, zona COLLATE NOCASE, subzona COLLATE NOCASE`,
  ).bind(centroId).all<PlanDb>();
  if (!plan.results.length) return c.json({ error: "El centro todavía no tiene plan de higiene cargado" }, 400);

  const existentes = await db.prepare(
    "SELECT id, plan_id FROM limpieza_faenas WHERE centro_id = ? AND anio = ? AND mes = ? AND plan_id IS NOT NULL",
  ).bind(centroId, anio, mes).all<{ id: number; plan_id: number }>();
  const faenaPorPlan = new Map<number, number>();
  for (const fila of existentes.results) faenaPorPlan.set(Number(fila.plan_id), Number(fila.id));

  let creadas = 0;
  let actualizadas = 0;
  let dias = 0;
  const omitidas: Array<{ zona: string; frecuencia_calculo: string }> = [];

  for (const tarea of plan.results) {
    const intervalo = parseFrecuencia(tarea.frecuencia_calculo);
    if (!intervalo) {
      omitidas.push({ zona: tarea.zona, frecuencia_calculo: tarea.frecuencia_calculo });
      continue;
    }
    const programados = fechasDelMes(tarea.proxima_fecha ?? tarea.fecha_inicio, intervalo, anio, mes);
    if (!programados.length) continue;
    const etiqueta = tarea.frecuencia_informativa ?? tarea.frecuencia_calculo;
    const turno: Turno = esTurno(tarea.turno) ? tarea.turno : "dia";
    let faenaId = faenaPorPlan.get(Number(tarea.id));
    if (faenaId) {
      actualizadas++;
      await db.prepare(
        "UPDATE limpieza_faenas SET zona = ?, subzona = ?, frecuencia_informativa = ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(tarea.zona, tarea.subzona, etiqueta, faenaId).run();
    } else {
      const res = await db.prepare(
        `INSERT INTO limpieza_faenas (centro_id, anio, mes, turno, zona, subzona, frecuencia_informativa, creado_por, plan_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(centroId, anio, mes, turno, tarea.zona, tarea.subzona, etiqueta, user.id, Number(tarea.id)).run();
      faenaId = Number((res.meta as { last_row_id?: number }).last_row_id);
      if (!faenaId) continue;
      faenaPorPlan.set(Number(tarea.id), faenaId);
      creadas++;
    }
    dias += programados.length;
    const id = faenaId;
    await ejecutarLotes(db, programados.map((dia) => db.prepare(
      "INSERT OR IGNORE INTO limpieza_dias (faena_id, fecha) VALUES (?, ?)",
    ).bind(id, fechaISO(anio, mes, dia))), 31);
  }

  await logMovimiento(db, user, "alta", "limpieza_faenas", null,
    `Plan de higiene generado en ${String(centro.nombre)}: ${creadas + actualizadas} faenas, ${dias} días (${String(mes).padStart(2, "0")}/${anio})`, null, null);
  return c.json({ ok: true, faenas_creadas: creadas, faenas_actualizadas: actualizadas, dias, omitidas });
});

// ------------------------------------------------------------------ Tablas del mes
// Lo que se imprime y se cuelga en el centro: las tareas del mes agrupadas por
// turno y por frecuencia (1, 2, 7, 14 y 31 días). Aparte van los «extras», las
// tareas del plan cuya frecuencia supera los 32 días: no salen todos los meses,
// así que se listan en el mes en que toca hacerlas.

const FRECUENCIAS_TABLA = [1, 2, 7, 14, 31] as const;

/** Frecuencia expresada en días; los meses se aproximan a 31 días. */
function frecuenciaEnDias(texto: string | null | undefined): number | null {
  const intervalo = parseFrecuencia(texto);
  if (!intervalo) return null;
  return intervalo.unidad === "dias" ? intervalo.valor : intervalo.valor * 31;
}

/** Bloque de la tabla al que pertenece una tarea: 1, 2, 7, 14, 31 o «extras».
 *  Las frecuencias intermedias se llevan al bloque más cercano. */
function bloqueFrecuencia(texto: string | null | undefined): number | "extras" | null {
  const dias = frecuenciaEnDias(texto);
  if (dias === null) return null;
  if (dias > 32) return "extras";
  let mejor: number = FRECUENCIAS_TABLA[0];
  for (const candidato of FRECUENCIAS_TABLA) {
    if (Math.abs(candidato - dias) < Math.abs(mejor - dias)) mejor = candidato;
  }
  return mejor;
}

function etiquetaBloque(dias: number | null): string {
  if (dias === null) return "Sin frecuencia definida";
  if (dias === 1) return "Diaria · cada 1 día";
  if (dias === 2) return "Cada 2 días";
  if (dias === 7) return "Semanal · cada 7 días";
  if (dias === 14) return "Quincenal · cada 14 días";
  return "Mensual · cada 31 días";
}

interface TareaTabla {
  faena_id: number;
  zona: string;
  subzona: string | null;
  elemento: string | null;
  tipo_limpieza: string | null;
  frecuencia_informativa: string | null;
  frecuencia_calculo: string | null;
  dias: number[];
  registros: Array<{ dia: number; usuario_id: number; usuario: string; creado: string }>;
}

interface ExtraTabla {
  plan_id: number;
  zona: string;
  subzona: string | null;
  elemento: string | null;
  frecuencia_calculo: string;
  frecuencia_informativa: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
  faena_id: number | null;
  dia: number | null;
  toca_este_mes: boolean;
  registro: { usuario_id: number; usuario: string; creado: string } | null;
}

// Tablas del mes de un centro: todos los turnos de golpe, agrupados por
// frecuencia, más los extras de más de 32 días.
limpiezaRoutes.get("/tablas", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centroId = entero(c.req.query("centro_id"));
  const anio = entero(c.req.query("anio"));
  const mes = entero(c.req.query("mes"));
  if (!centroId || !anio || !mes) return c.json({ error: "Indica centro, año y mes" }, 400);
  if (anio < 2020 || anio > 2100 || mes < 1 || mes > 12) {
    return c.json({ error: "El año o el mes no son válidos" }, 400);
  }
  const centro = await db.prepare("SELECT id, nombre FROM centros WHERE id = ?")
    .bind(centroId).first<{ id: number; nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeVerCentro(db, user, centroId))) {
    return c.json({ error: "No tienes acceso a este centro" }, 403);
  }

  const diasMes = diasEnMes(anio, mes);
  const desde = fechaISO(anio, mes, 1);
  const hasta = fechaISO(anio, mes, diasMes);
  const prefijoMes = `${desde.slice(0, 7)}`;

  const [filas, festivos, plan] = await Promise.all([
    db.prepare(
      `SELECT f.id, f.turno, f.zona, f.subzona, f.frecuencia_informativa,
              p.elemento, p.tipo_limpieza, p.frecuencia_calculo,
              d.fecha, r.usuario_id, u.nombre AS usuario, r.created_at AS creado
       FROM limpieza_faenas f
       LEFT JOIN limpieza_plan p ON p.id = f.plan_id
       LEFT JOIN limpieza_dias d ON d.faena_id = f.id AND d.fecha BETWEEN ? AND ?
       LEFT JOIN limpieza_registros r ON r.faena_id = d.faena_id AND r.fecha = d.fecha
       LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE f.centro_id = ? AND f.anio = ? AND f.mes = ?
       ORDER BY f.zona COLLATE NOCASE, f.subzona COLLATE NOCASE, f.id, d.fecha`,
    ).bind(desde, hasta, centroId, anio, mes).all<{
      id: number; turno: string; zona: string; subzona: string | null; frecuencia_informativa: string | null;
      elemento: string | null; tipo_limpieza: string | null; frecuencia_calculo: string | null;
      fecha: string | null; usuario_id: number | null; usuario: string | null; creado: string | null;
    }>(),
    db.prepare("SELECT fecha FROM limpieza_festivos WHERE centro_id = ? AND fecha BETWEEN ? AND ? ORDER BY fecha")
      .bind(centroId, desde, hasta).all<{ fecha: string }>(),
    db.prepare(
      `SELECT p.id, p.turno, p.zona, p.subzona, p.elemento, p.frecuencia_calculo, p.frecuencia_informativa,
              p.ultima_realizacion, p.proxima_fecha,
              f.id AS faena_id, d.fecha, r.usuario_id, u.nombre AS usuario, r.created_at AS creado
       FROM limpieza_plan p
       LEFT JOIN limpieza_faenas f ON f.plan_id = p.id AND f.centro_id = p.centro_id AND f.anio = ? AND f.mes = ?
       LEFT JOIN limpieza_dias d ON d.faena_id = f.id
       LEFT JOIN limpieza_registros r ON r.faena_id = f.id AND r.fecha = d.fecha
       LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE p.centro_id = ?
       ORDER BY p.zona COLLATE NOCASE, p.subzona COLLATE NOCASE, p.id`,
    ).bind(anio, mes, centroId).all<{
      id: number; turno: string; zona: string; subzona: string | null; elemento: string | null;
      frecuencia_calculo: string; frecuencia_informativa: string | null;
      ultima_realizacion: string | null; proxima_fecha: string | null;
      faena_id: number | null; fecha: string | null; usuario_id: number | null;
      usuario: string | null; creado: string | null;
    }>(),
  ]);

  const porTurno = new Map<Turno, Map<string, TareaTabla>>();

  for (const fila of filas.results) {
    const turno: Turno = esTurno(fila.turno) ? fila.turno : "dia";
    const id = Number(fila.id);
    let turnos = porTurno.get(turno);
    if (!turnos) { turnos = new Map(); porTurno.set(turno, turnos); }
    let tarea = turnos.get(String(id));
    if (!tarea) {
      tarea = {
        faena_id: id,
        zona: String(fila.zona),
        subzona: fila.subzona ? String(fila.subzona) : null,
        elemento: fila.elemento ? String(fila.elemento) : null,
        tipo_limpieza: fila.tipo_limpieza ? String(fila.tipo_limpieza) : null,
        frecuencia_informativa: fila.frecuencia_informativa ? String(fila.frecuencia_informativa) : null,
        frecuencia_calculo: fila.frecuencia_calculo ? String(fila.frecuencia_calculo) : null,
        dias: [],
        registros: [],
      };
      turnos.set(String(id), tarea);
    }
    if (!fila.fecha) continue;
    const dia = Number(String(fila.fecha).slice(8, 10));
    if (tarea.dias.includes(dia)) continue;
    tarea.dias.push(dia);
    if (fila.usuario_id !== null && fila.usuario_id !== undefined) {
      tarea.registros.push({ dia, usuario_id: Number(fila.usuario_id), usuario: String(fila.usuario ?? ""), creado: String(fila.creado ?? "") });
    }
  }

  // Extras: tareas del plan con frecuencia mayor de 32 días. Se muestran todas
  // las del turno, con la fecha en que tocan y la marca del mes si ya se hizo.
  const extrasPorTurno = new Map<Turno, ExtraTabla[]>();
  for (const fila of plan.results) {
    if (bloqueFrecuencia(fila.frecuencia_calculo) !== "extras") continue;
    const turno: Turno = esTurno(fila.turno) ? fila.turno : "dia";
    const lista = extrasPorTurno.get(turno) ?? [];
    const previa = lista.find((e) => e.plan_id === Number(fila.id));
    if (previa) {
      if (previa.dia === null && fila.fecha) previa.dia = Number(String(fila.fecha).slice(8, 10));
      continue;
    }
    const proxima = fila.proxima_fecha ? String(fila.proxima_fecha) : null;
    lista.push({
      plan_id: Number(fila.id),
      zona: String(fila.zona),
      subzona: fila.subzona ? String(fila.subzona) : null,
      elemento: fila.elemento ? String(fila.elemento) : null,
      frecuencia_calculo: String(fila.frecuencia_calculo),
      frecuencia_informativa: fila.frecuencia_informativa ? String(fila.frecuencia_informativa) : null,
      ultima_realizacion: fila.ultima_realizacion ? String(fila.ultima_realizacion) : null,
      proxima_fecha: proxima,
      faena_id: fila.faena_id === null || fila.faena_id === undefined ? null : Number(fila.faena_id),
      dia: fila.fecha ? Number(String(fila.fecha).slice(8, 10)) : null,
      toca_este_mes: Boolean(proxima && proxima.startsWith(prefijoMes)) || Boolean(fila.fecha),
      registro: fila.usuario_id === null || fila.usuario_id === undefined
        ? null
        : { usuario_id: Number(fila.usuario_id), usuario: String(fila.usuario ?? ""), creado: String(fila.creado ?? "") },
    });
    extrasPorTurno.set(turno, lista);
  }

  let totalTareas = 0;
  let totalProgramadas = 0;
  let totalHechas = 0;
  const turnos = TURNOS.map((turno) => {
    const tareas = [...(porTurno.get(turno)?.values() ?? [])].map((t) => ({
      ...t,
      dias: t.dias.sort((a, b) => a - b),
    }));
    const bloques = new Map<string, TareaTabla[]>();
    for (const tarea of tareas) {
      const bloque = bloqueFrecuencia(tarea.frecuencia_calculo ?? tarea.frecuencia_informativa);
      // Los extras (más de 32 días) van en su propia tabla, no en las de frecuencia.
      if (bloque === "extras") continue;
      const clave = bloque === null ? "sin" : String(bloque);
      const lista = bloques.get(clave) ?? [];
      lista.push(tarea);
      bloques.set(clave, lista);
    }
    const orden = [...FRECUENCIAS_TABLA.map(String), "sin"];
    const agrupados = orden
      .filter((clave) => bloques.has(clave))
      .map((clave) => {
        const dias = clave === "sin" ? null : Number(clave);
        return { dias, etiqueta: etiquetaBloque(dias), tareas: bloques.get(clave) ?? [] };
      });
    const extras = extrasPorTurno.get(turno) ?? [];
    for (const tarea of tareas) {
      totalTareas++;
      totalProgramadas += tarea.dias.length;
      totalHechas += tarea.registros.length;
    }
    return { turno, etiqueta: ETIQUETA_TURNO[turno], bloques: agrupados, extras };
  });

  return c.json({
    centro: { id: Number(centro.id), nombre: String(centro.nombre) },
    anio,
    mes,
    dias_mes: diasMes,
    fecha_hoy: hoyMadrid(),
    festivos: festivos.results.map((f) => String(f.fecha)),
    turnos,
    puede_gestionar: await puedeGestionarCentro(db, user, centroId),
    resumen: {
      tareas: totalTareas,
      programadas: totalProgramadas,
      hechas: totalHechas,
      extras: turnos.reduce((n, t) => n + t.extras.filter((e) => e.toca_este_mes).length, 0),
    },
  });
});

// Marcar o desmarcar una tarea en un día concreto. Puede hacerlo cualquier
// persona con acceso al centro; deshacer la marca de otro operario queda
// reservado a los responsables del centro.
limpiezaRoutes.post("/registros", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const faenaId = entero(body.faena_id);
  const dia = entero(body.dia);
  if (!faenaId || !dia || typeof body.hecho !== "boolean") {
    return c.json({ error: "Indica la faena, el día y si está realizada" }, 400);
  }
  const faena = await cargarFaena(db, faenaId);
  if (!faena) return c.json({ error: "Faena no encontrada" }, 404);
  if (!(await puedeVerCentro(db, user, Number(faena.centro_id)))) {
    return c.json({ error: "No tienes acceso a este centro" }, 403);
  }
  if (dia < 1 || dia > diasEnMes(Number(faena.anio), Number(faena.mes))) {
    return c.json({ error: "Día no válido para este mes" }, 400);
  }
  const fecha = fechaISO(Number(faena.anio), Number(faena.mes), dia);
  const programada = await db.prepare("SELECT 1 AS x FROM limpieza_dias WHERE faena_id = ? AND fecha = ?")
    .bind(faenaId, fecha).first();
  if (!programada) return c.json({ error: "Ese día no está programado para esta faena" }, 400);

  const actual = await db.prepare(
    `SELECT r.usuario_id, u.nombre AS usuario, r.created_at AS creado
     FROM limpieza_registros r JOIN usuarios u ON u.id = r.usuario_id
     WHERE r.faena_id = ? AND r.fecha = ?`,
  ).bind(faenaId, fecha).first<{ usuario_id: number; usuario: string; creado: string }>();

  if (!body.hecho) {
    if (!actual) return c.json({ hecho: false });
    if (Number(actual.usuario_id) !== user.id && user.rol === "usuario") {
      return c.json({ error: "Solo quien marcó la tarea o un responsable puede desmarcarla" }, 403);
    }
    await db.prepare("DELETE FROM limpieza_registros WHERE faena_id = ? AND fecha = ?").bind(faenaId, fecha).run();
    if (faena.plan_id) await recalcularProxima(db, Number(faena.plan_id), fecha);
    return c.json({ hecho: false });
  }

  if (fecha > hoyMadrid()) return c.json({ error: "Todavía no puedes marcar un día futuro" }, 400);
  if (actual) {
    return c.json({
      hecho: true,
      ya_estaba: true,
      usuario_id: Number(actual.usuario_id),
      usuario: String(actual.usuario),
      creado: String(actual.creado),
    });
  }
  const creado = new Date().toISOString().slice(0, 19).replace("T", " ");
  await db.prepare(
    "INSERT INTO limpieza_registros (faena_id, fecha, usuario_id, created_at) VALUES (?, ?, ?, ?)",
  ).bind(faenaId, fecha, user.id, creado).run();
  // La tarea realizada hace avanzar el plan: próxima = esta fecha + frecuencia.
  if (faena.plan_id) await avanzarPlan(db, Number(faena.plan_id), fecha);
  return c.json({
    hecho: true,
    usuario_id: user.id,
    usuario: user.nombre,
    creado,
  });
});
