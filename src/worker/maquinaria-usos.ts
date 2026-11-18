import { Hono } from "hono";
import type { D1Database, Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import { centrosPermitidos, marcas } from "./alcance";

// Registro de uso de la maquinaria: cada vez que alguien coge una máquina queda
// apuntado quién es, cuándo, cómo la ha recogido y, al devolverla, cómo la deja.
// Cada máquina tiene su propio cuestionario breve (sí/no o puntuación 1-5) y
// las respuestas se guardan como foto del momento para que el histórico siga
// siendo legible aunque después cambien las preguntas.

export type CheckTipo = "booleano" | "escala";

export interface CheckItem {
  id: number;
  maquina_id: number;
  texto: string;
  tipo: CheckTipo;
  orden: number;
  activo: number;
}

export interface Respuesta {
  item_id: number;
  texto: string;
  tipo: CheckTipo;
  valor: boolean | number;
}

/** Cuestionario con el que nace cada máquina (luego se puede personalizar). */
export const CHECKLIST_DEFECTO: Array<{ texto: string; tipo: CheckTipo }> = [
  { texto: "Batería o combustible suficiente para el turno", tipo: "booleano" },
  { texto: "Depósitos vaciados y máquina limpia", tipo: "booleano" },
  { texto: "Accesorios, cepillos y cables completos", tipo: "booleano" },
  { texto: "Estado general de la máquina", tipo: "escala" },
];

const MAX_PREGUNTAS = 20;
const MAX_TEXTO = 120;

function tipoValido(v: unknown): CheckTipo | null {
  const t = String(v ?? "").trim().toLowerCase();
  if (["booleano", "si_no", "sí/no", "si-no", "check"].includes(t)) return "booleano";
  if (["escala", "1-5", "puntuacion", "puntuación"].includes(t)) return "escala";
  return null;
}

async function itemsDe(db: D1Database, maquinaId: number): Promise<CheckItem[]> {
  const res = await db.prepare(
    "SELECT id, maquina_id, texto, tipo, orden, activo FROM maquinaria_check_items WHERE maquina_id = ? AND activo = 1 ORDER BY orden, id",
  ).bind(maquinaId).all<CheckItem>();
  return res.results.map((r) => ({ ...r, id: Number(r.id), maquina_id: Number(r.maquina_id), orden: Number(r.orden), tipo: r.tipo === "escala" ? "escala" : "booleano" }));
}

async function crearChecklistDefecto(db: D1Database, maquinaId: number): Promise<void> {
  const ins = db.prepare("INSERT INTO maquinaria_check_items (maquina_id, texto, tipo, orden) VALUES (?, ?, ?, ?)");
  for (const [i, it] of CHECKLIST_DEFECTO.entries()) {
    await ins.bind(maquinaId, it.texto, it.tipo, i + 1).run();
  }
}

/** Cuestionario activo de la máquina; si no tiene, se le crea el de defecto. */
export async function asegurarChecklist(db: D1Database, maquinaId: number): Promise<CheckItem[]> {
  const items = await itemsDe(db, maquinaId);
  if (items.length) return items;
  await crearChecklistDefecto(db, maquinaId);
  return itemsDe(db, maquinaId);
}

interface Maquina {
  id: number;
  nombre: string;
  numero_serie: string | null;
  tipo: string;
  centro_id: number | null;
}

/** Carga la máquina comprobando que está entre los centros del usuario. */
async function cargarMaquina(
  db: D1Database, user: SessionUser, maquinaId: number,
): Promise<{ maquina?: Maquina; error?: { mensaje: string; status: 403 | 404 } }> {
  const maquina = await db.prepare(
    "SELECT id, nombre, numero_serie, tipo, centro_id FROM maquinaria WHERE id = ?",
  ).bind(maquinaId).first<Maquina>();
  if (!maquina) return { error: { mensaje: "Máquina no encontrada", status: 404 } };
  const permitidos = await centrosPermitidos(db, user);
  if (permitidos) {
    const centro = maquina.centro_id == null ? null : Number(maquina.centro_id);
    if (centro === null || !permitidos.includes(centro)) {
      return { error: { mensaje: "Esa máquina no pertenece a tus centros", status: 403 } };
    }
  }
  return { maquina: { ...maquina, id: Number(maquina.id), centro_id: maquina.centro_id == null ? null : Number(maquina.centro_id) } };
}

/** Comprueba las respuestas contra el cuestionario activo de la máquina. */
export function validarRespuestas(items: CheckItem[], raw: unknown): { respuestas?: Respuesta[]; error?: string } {
  if (!Array.isArray(raw)) return { error: "Responde el cuestionario de la máquina" };
  const porId = new Map(items.map((i) => [Number(i.id), i]));
  const respuestas: Respuesta[] = [];
  const vistos = new Set<number>();
  for (const fila of raw as Array<Record<string, unknown>>) {
    const id = Number(fila?.item_id);
    const item = porId.get(id);
    if (!item || vistos.has(id)) continue;
    vistos.add(id);
    if (item.tipo === "escala") {
      const v = Number(fila?.valor);
      if (!Number.isInteger(v) || v < 1 || v > 5) return { error: `Puntúa de 1 a 5: «${item.texto}»` };
      respuestas.push({ item_id: id, texto: item.texto, tipo: "escala", valor: v });
    } else {
      const v = fila?.valor;
      if (typeof v !== "boolean") return { error: `Responde sí o no: «${item.texto}»` };
      respuestas.push({ item_id: id, texto: item.texto, tipo: "booleano", valor: v });
    }
  }
  const faltan = items.filter((i) => !vistos.has(Number(i.id))).map((i) => i.texto);
  if (faltan.length) {
    return { error: `Faltan respuestas: ${faltan.slice(0, 3).join(", ")}${faltan.length > 3 ? "…" : ""}` };
  }
  // Se guardan en el orden del cuestionario.
  respuestas.sort((a, b) => (porId.get(a.item_id)!.orden - porId.get(b.item_id)!.orden));
  return { respuestas };
}

async function usoAbierto(db: D1Database, maquinaId: number) {
  return db.prepare(
    `SELECT us.id, us.usuario_id, us.fecha_recogida, u.nombre AS usuario_nombre
     FROM maquinaria_usos us JOIN usuarios u ON u.id = us.usuario_id
     WHERE us.maquina_id = ? AND us.estado = 'en_uso' ORDER BY us.id DESC LIMIT 1`,
  ).bind(maquinaId).first<{ id: number; usuario_id: number; fecha_recogida: string; usuario_nombre: string }>();
}

const fechaHumana = (v: string | null): string => {
  if (!v) return "";
  const [f, h] = String(v).replace("T", " ").split(" ");
  const [y, m, d] = f.slice(0, 10).split("-");
  return `${d}/${m}/${y}${h ? ` ${h.slice(0, 5)}` : ""}`;
};

export const maquinariaUsos = new Hono<{ Bindings: Env; Variables: Variables }>();
maquinariaUsos.use("*", requireAuth);

// Cuestionario de una máquina (se crea con el de defecto la primera vez).
maquinariaUsos.get("/checklist/:maquinaId", async (c) => {
  const user = c.get("user");
  const maquinaId = Number(c.req.param("maquinaId"));
  if (!Number.isInteger(maquinaId) || maquinaId < 1) return c.json({ error: "Máquina no válida" }, 400);
  const { maquina, error } = await cargarMaquina(c.env.DB, user, maquinaId);
  if (error || !maquina) return c.json({ error: error!.mensaje }, error!.status);
  return c.json({ items: await asegurarChecklist(c.env.DB, maquinaId), maquina });
});

// Guardar el cuestionario de una máquina (administrador y administrador de
// centros): sustituye por completo la lista de preguntas activas.
maquinariaUsos.put("/checklist/:maquinaId", async (c) => {
  const user = c.get("user");
  if (user.rol === "usuario") return c.json({ error: "Solo los responsables pueden cambiar el cuestionario" }, 403);
  const maquinaId = Number(c.req.param("maquinaId"));
  if (!Number.isInteger(maquinaId) || maquinaId < 1) return c.json({ error: "Máquina no válida" }, 400);
  const { maquina, error } = await cargarMaquina(c.env.DB, user, maquinaId);
  if (error || !maquina) return c.json({ error: error!.mensaje }, error!.status);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  const raw = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : null;
  if (!raw || raw.length < 1) return c.json({ error: "Añade al menos una pregunta al cuestionario" }, 400);
  if (raw.length > MAX_PREGUNTAS) return c.json({ error: `El cuestionario admite como máximo ${MAX_PREGUNTAS} preguntas` }, 400);
  const items: Array<{ texto: string; tipo: CheckTipo }> = [];
  for (const [i, fila] of raw.entries()) {
    const texto = String(fila?.texto ?? "").trim();
    if (texto.length < 3) return c.json({ error: `La pregunta ${i + 1} necesita al menos 3 caracteres` }, 400);
    if (texto.length > MAX_TEXTO) return c.json({ error: `La pregunta ${i + 1} supera los ${MAX_TEXTO} caracteres` }, 400);
    const tipo = tipoValido(fila?.tipo) ?? "booleano";
    items.push({ texto, tipo });
  }
  await c.env.DB.prepare("DELETE FROM maquinaria_check_items WHERE maquina_id = ?").bind(maquinaId).run();
  const ins = c.env.DB.prepare("INSERT INTO maquinaria_check_items (maquina_id, texto, tipo, orden) VALUES (?, ?, ?, ?)");
  for (const [i, it] of items.entries()) {
    await ins.bind(maquinaId, it.texto, it.tipo, i + 1).run();
  }
  await logMovimiento(c.env.DB, user, "cuestionario", "maquinaria", maquinaId,
    `Cuestionario de uso de «${maquina.nombre}» actualizado (${items.length} preguntas)`, null);
  return c.json({ ok: true, items: await itemsDe(c.env.DB, maquinaId) });
});

// Registro de uso: listado (acotado a los centros del usuario).
maquinariaUsos.get("/", async (c) => {
  const user = c.get("user");
  const permitidos = await centrosPermitidos(c.env.DB, user);
  const filtros: string[] = [];
  const valores: unknown[] = [];
  if (permitidos) {
    if (!permitidos.length) return c.json({ items: [] });
    filtros.push(`m.centro_id IN (${marcas(permitidos.length)})`);
    valores.push(...permitidos);
  }
  const maquinaId = Number(c.req.query("maquina_id"));
  if (Number.isInteger(maquinaId) && maquinaId >= 1) { filtros.push("u.maquina_id = ?"); valores.push(maquinaId); }
  const centroId = Number(c.req.query("centro_id"));
  if (Number.isInteger(centroId) && centroId >= 1) { filtros.push("u.centro_id = ?"); valores.push(centroId); }
  const usuarioId = Number(c.req.query("usuario_id"));
  if (Number.isInteger(usuarioId) && usuarioId >= 1) { filtros.push("u.usuario_id = ?"); valores.push(usuarioId); }
  const estado = c.req.query("estado");
  if (estado === "en_uso" || estado === "devuelta") { filtros.push("u.estado = ?"); valores.push(estado); }
  const desde = c.req.query("desde");
  if (desde && /^\d{4}-\d{2}-\d{2}$/.test(desde)) { filtros.push("date(u.fecha_recogida) >= ?"); valores.push(desde); }
  const hasta = c.req.query("hasta");
  if (hasta && /^\d{4}-\d{2}-\d{2}$/.test(hasta)) { filtros.push("date(u.fecha_recogida) <= ?"); valores.push(hasta); }
  const limiteRaw = Number(c.req.query("limit"));
  const limite = Number.isInteger(limiteRaw) && limiteRaw >= 1 && limiteRaw <= 1000 ? limiteRaw : 300;
  const res = await c.env.DB.prepare(
    `SELECT u.id, u.maquina_id, u.usuario_id, u.centro_id, u.fecha_recogida,
            u.respuestas_recogida, u.notas_recogida, u.fecha_devolucion,
            u.respuestas_devolucion, u.notas_devolucion, u.estado,
            m.nombre AS maquina_nombre, m.numero_serie, m.tipo,
            us.nombre AS usuario_nombre, us.username,
            ce.nombre AS centro_nombre
     FROM maquinaria_usos u
     JOIN maquinaria m ON m.id = u.maquina_id
     JOIN usuarios us ON us.id = u.usuario_id
     LEFT JOIN centros ce ON ce.id = u.centro_id
     ${filtros.length ? `WHERE ${filtros.join(" AND ")}` : ""}
     ORDER BY u.fecha_recogida DESC, u.id DESC LIMIT ?`,
  ).bind(...valores, limite).all();
  return c.json({ items: res.results });
});

// Recoger una máquina: abre el registro con quién la coge y el cuestionario de
// recogida. Una máquina solo puede estar en manos de una persona a la vez.
maquinariaUsos.post("/", async (c) => {
  const user = c.get("user");
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  const maquinaId = Number(body.maquina_id);
  if (!Number.isInteger(maquinaId) || maquinaId < 1) return c.json({ error: "Elige la máquina que vas a usar" }, 400);
  const { maquina, error } = await cargarMaquina(c.env.DB, user, maquinaId);
  if (error || !maquina) return c.json({ error: error!.mensaje }, error!.status);
  const abierto = await usoAbierto(c.env.DB, maquinaId);
  if (abierto) {
    const desde = fechaHumana(abierto.fecha_recogida);
    return c.json({
      error: Number(abierto.usuario_id) === user.id
        ? `Ya tienes «${maquina.nombre}» en uso desde el ${desde}. Devuélvela antes de volver a cogerla.`
        : `«${maquina.nombre}» está en uso por ${abierto.usuario_nombre} desde el ${desde}.`,
      uso_abierto_id: Number(abierto.id),
    }, 409);
  }
  const items = await asegurarChecklist(c.env.DB, maquinaId);
  const validado = validarRespuestas(items, body.respuestas);
  if (validado.error || !validado.respuestas) return c.json({ error: validado.error }, 400);
  const notas = typeof body.notas === "string" && body.notas.trim() ? body.notas.trim().slice(0, 1000) : null;
  const res = await c.env.DB.prepare(
    `INSERT INTO maquinaria_usos (maquina_id, usuario_id, centro_id, respuestas_recogida, notas_recogida, estado)
     VALUES (?, ?, ?, ?, ?, 'en_uso')`,
  ).bind(maquinaId, user.id, maquina.centro_id ?? null, JSON.stringify(validado.respuestas), notas).run();
  const id = Number(res.meta.last_row_id);
  await logMovimiento(c.env.DB, user, "uso", "maquinaria", maquinaId,
    `Máquina «${maquina.nombre}» recogida por ${user.nombre}`, null);
  return c.json({ ok: true, id, fecha_recogida: new Date().toISOString() }, 201);
});

// Devolver una máquina: cierra el registro con el cuestionario de devolución.
maquinariaUsos.post("/:id/devolucion", async (c) => {
  const user = c.get("user");
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
  const uso = await c.env.DB.prepare(
    `SELECT us.id, us.maquina_id, us.usuario_id, us.estado, m.nombre AS maquina_nombre
     FROM maquinaria_usos us JOIN maquinaria m ON m.id = us.maquina_id WHERE us.id = ?`,
  ).bind(id).first<{ id: number; maquina_id: number; usuario_id: number; estado: string; maquina_nombre: string }>();
  if (!uso) return c.json({ error: "Registro de uso no encontrado" }, 404);
  const { maquina, error } = await cargarMaquina(c.env.DB, user, Number(uso.maquina_id));
  if (error || !maquina) return c.json({ error: error!.mensaje }, error!.status);
  const esMio = Number(uso.usuario_id) === user.id;
  if (!esMio && user.rol === "usuario") return c.json({ error: "Solo puedes devolver las máquinas que has cogido tú" }, 403);
  if (uso.estado === "devuelta") return c.json({ error: "Ese uso ya está cerrado" }, 400);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  const items = await asegurarChecklist(c.env.DB, Number(uso.maquina_id));
  const validado = validarRespuestas(items, body.respuestas);
  if (validado.error || !validado.respuestas) return c.json({ error: validado.error }, 400);
  const notas = typeof body.notas === "string" && body.notas.trim() ? body.notas.trim().slice(0, 1000) : null;
  await c.env.DB.prepare(
    `UPDATE maquinaria_usos SET fecha_devolucion = datetime('now'), respuestas_devolucion = ?, notas_devolucion = ?,
       estado = 'devuelta', updated_at = datetime('now') WHERE id = ?`,
  ).bind(JSON.stringify(validado.respuestas), notas, id).run();
  await logMovimiento(c.env.DB, user, "devolucion", "maquinaria", Number(uso.maquina_id),
    esMio
      ? `Máquina «${maquina.nombre}» devuelta por ${user.nombre}`
      : `Máquina «${maquina.nombre}» devuelta por ${user.nombre} (en nombre del usuario del registro)`, null);
  return c.json({ ok: true });
});

// Importación CSV del cuestionario: la primera fila de cada máquina sustituye su
// cuestionario y el resto añade preguntas; si la pregunta ya existe se actualiza.
maquinariaUsos.post("/import", async (c) => {
  const user = c.get("user");
  if (user.rol === "usuario") return c.json({ error: "Solo los responsables pueden importar cuestionarios" }, 403);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  const filas = Array.isArray(body.rows) ? (body.rows as Array<Record<string, unknown>>) : [];
  if (!filas.length) return c.json({ error: "No hay filas que importar" }, 400);
  if (filas.length > 500) return c.json({ error: "Máximo 500 filas por importación" }, 400);
  const yaLimpiada = new Set<number>();
  let creados = 0, actualizados = 0;
  const errores: string[] = [];
  for (const [i, fila] of filas.entries()) {
    const n = i + 2;
    const maquinaId = Number(fila?.maquina_id);
    const texto = String(fila?.texto ?? "").trim();
    if (!Number.isInteger(maquinaId) || maquinaId < 1) { errores.push(`Fila ${n}: falta la máquina`); continue; }
    if (texto.length < 3 || texto.length > MAX_TEXTO) { errores.push(`Fila ${n}: la pregunta debe tener entre 3 y ${MAX_TEXTO} caracteres`); continue; }
    const tipo = tipoValido(fila?.tipo) ?? "booleano";
    const ordenRaw = Number(fila?.orden);
    const orden = Number.isFinite(ordenRaw) ? ordenRaw : i + 1;
    const { maquina, error } = await cargarMaquina(c.env.DB, user, maquinaId);
    if (error || !maquina) { errores.push(`Fila ${n}: ${error!.mensaje.toLowerCase()}`); continue; }
    if (!yaLimpiada.has(maquinaId)) {
      await c.env.DB.prepare("DELETE FROM maquinaria_check_items WHERE maquina_id = ?").bind(maquinaId).run();
      yaLimpiada.add(maquinaId);
    }
    const existe = await c.env.DB.prepare(
      "SELECT id FROM maquinaria_check_items WHERE maquina_id = ? AND lower(trim(texto)) = lower(trim(?))",
    ).bind(maquinaId, texto).first<{ id: number }>();
    if (existe) {
      await c.env.DB.prepare("UPDATE maquinaria_check_items SET tipo = ?, orden = ?, activo = 1, updated_at = datetime('now') WHERE id = ?")
        .bind(tipo, orden, Number(existe.id)).run();
      actualizados++;
    } else {
      await c.env.DB.prepare("INSERT INTO maquinaria_check_items (maquina_id, texto, tipo, orden) VALUES (?, ?, ?, ?)")
        .bind(maquinaId, texto, tipo, orden).run();
      creados++;
    }
  }
  return c.json({ ok: true, creados, actualizados, errores });
});
