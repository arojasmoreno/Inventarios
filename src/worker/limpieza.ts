import { Hono } from "hono";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import type { D1Database, D1Statement, Env } from "./d1";
import type { Variables } from "./types";

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
}

interface FaenaCalendario {
  id: number;
  zona: string;
  subzona: string | null;
  frecuencia_informativa: string | null;
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
    `SELECT id, centro_id, anio, mes, turno, zona, subzona, frecuencia_informativa
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
      `SELECT f.id, f.zona, f.subzona, f.frecuencia_informativa,
              d.fecha, r.usuario_id, u.nombre AS usuario, r.created_at AS creado
       FROM limpieza_faenas f
       LEFT JOIN limpieza_dias d ON d.faena_id = f.id AND d.fecha BETWEEN ? AND ?
       LEFT JOIN limpieza_registros r ON r.faena_id = d.faena_id AND r.fecha = d.fecha
       LEFT JOIN usuarios u ON u.id = r.usuario_id
       WHERE f.centro_id = ? AND f.anio = ? AND f.mes = ? AND f.turno = ?
       ORDER BY f.zona COLLATE NOCASE, f.subzona COLLATE NOCASE, f.id, d.fecha`,
    ).bind(desde, hasta, centroId, anio, mes, turno).all<{
      id: number; zona: string; subzona: string | null; frecuencia_informativa: string | null;
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
  return c.json({
    hecho: true,
    usuario_id: user.id,
    usuario: user.nombre,
    creado,
  });
});
