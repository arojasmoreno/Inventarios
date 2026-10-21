import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth, type SessionUser } from "./auth";
import { allowed, createCrud, ValidationError, type CrudSpec } from "./crud";
import { logMovimiento } from "./audit";

type Ctx = Context<{ Bindings: Env; Variables: Variables }>;

// ---------------------------------------------------------------- Tipos de ficha
// Catálogo gestionado: Ficha de seguridad, Ficha técnica, Manual de maquinaria,
// Instrucción de trabajo… se pueden añadir tipos nuevos desde el formulario.
export const documentosTiposSpec: CrudSpec = {
  table: "documento_tipos", orderBy: "id",
  read: "all", create: "centros", update: "centros", delete: "centros",
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true, unique: true, maxLength: 80 },
  ],
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM documentos WHERE tipo_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} fichas usan este tipo`;
    return null;
  },
};
export const documentosTipos = createCrud(documentosTiposSpec);

// ---------------------------------------------------------------- Fichas
const URL_RE = /^https?:\/\/\S+$/i;

// Escape de comodines LIKE (SQLite acepta ESCAPE '\' con el patrón escapado).
const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// Centros asignados a un usuario: centro habitual + multiasignación.
async function centrosDeUsuario(db: D1Database, userId: number): Promise<number[]> {
  const rows = (await db.prepare(
    `SELECT centro_id FROM usuario_centros WHERE usuario_id = ?
     UNION SELECT centro_id FROM usuarios WHERE id = ? AND centro_id IS NOT NULL`,
  ).bind(userId, userId).all()).results as Array<{ centro_id: number }>;
  return rows.map((r) => Number(r.centro_id));
}

// SELECT de listado/ficha con tipo y centros agregados (sin JOIN que duplique).
const SELECT_FICHA = `SELECT d.id, d.nombre, d.url, d.descripcion, d.fabricante, d.created_at, d.updated_at,
  t.id AS tipo_id, t.nombre AS tipo_nombre,
  (SELECT GROUP_CONCAT(c2.nombre) FROM documento_centros dc2 JOIN centros c2 ON c2.id = dc2.centro_id WHERE dc2.documento_id = d.id) AS centros_nombre,
  (SELECT GROUP_CONCAT(dc3.centro_id) FROM documento_centros dc3 WHERE dc3.documento_id = d.id) AS centros_ids
  FROM documentos d LEFT JOIN documento_tipos t ON t.id = d.tipo_id`;

async function cargarFicha(db: D1Database, id: number): Promise<Record<string, unknown> | null> {
  return db.prepare(`${SELECT_FICHA} WHERE d.id = ?`).bind(id).first();
}

interface FichaBody {
  nombre: string;
  tipoId: number;
  url: string;
  descripcion: string | null;
  fabricante: string | null;
  centros: number[];
}

// Valida el cuerpo de una ficha (alta o edición) y comprueba el alcance del rol.
async function parseFicha(c: Ctx, user: SessionUser, raw: Record<string, unknown>, mode: "insert" | "update"): Promise<FichaBody> {
  const nombre = typeof raw.nombre === "string" ? raw.nombre.trim().slice(0, 200) : "";
  if (!nombre) throw new ValidationError("El nombre de la ficha es obligatorio");
  const tipoId = Number(raw.tipo_id);
  if (!Number.isInteger(tipoId) || tipoId < 1) throw new ValidationError("Elige el tipo de ficha");
  const tipo = await c.env.DB.prepare("SELECT id FROM documento_tipos WHERE id = ?").bind(tipoId).first();
  if (!tipo) throw new ValidationError("El tipo de ficha seleccionado no existe");
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!URL_RE.test(url)) throw new ValidationError("La URL del documento debe empezar por http:// o https://");
  if (url.length > 500) throw new ValidationError("La URL es demasiado larga (máx. 500 caracteres)");
  const descripcion = typeof raw.descripcion === "string" && raw.descripcion.trim() ? raw.descripcion.trim().slice(0, 300) : null;
  const fabricante = typeof raw.fabricante === "string" && raw.fabricante.trim() ? raw.fabricante.trim().slice(0, 120) : null;
  const centros = [...new Set((Array.isArray(raw.centros) ? raw.centros : []).map((n) => Number(n)))]
    .filter((n) => Number.isInteger(n) && n >= 1);
  if (!centros.length) throw new ValidationError("Marca al menos un centro donde se usa la ficha");
  for (const centroId of centros) {
    const ce = await c.env.DB.prepare("SELECT id FROM centros WHERE id = ?").bind(centroId).first();
    if (!ce) throw new ValidationError(`El centro ${centroId} no existe`);
  }
  // El «administrador de centros» solo puede asignar fichas a sus centros.
  if (user.rol === "admin_centros") {
    const own = new Set(await centrosDeUsuario(c.env.DB, user.id));
    if (!centros.every((id) => own.has(id))) throw new ValidationError("Solo puedes asignar fichas a los centros asignados a tu usuario");
    // Y solo puede editar/borrar fichas que pertenezcan enteramente a sus centros.
    if (mode === "update") {
      const actuales = (await c.env.DB.prepare("SELECT centro_id FROM documento_centros WHERE documento_id = ?").bind(Number(raw.id)).all()).results as Array<{ centro_id: number }>;
      if (!actuales.every((r) => own.has(Number(r.centro_id)))) throw new ValidationError("Esa ficha pertenece a centros que no gestionas");
    }
  }
  return { nombre, tipoId, url, descripcion, fabricante, centros };
}

async function guardarCentros(db: D1Database, docId: number, centros: number[]): Promise<void> {
  await db.prepare("DELETE FROM documento_centros WHERE documento_id = ?").bind(docId).run();
  const ins = db.prepare("INSERT INTO documento_centros (documento_id, centro_id) VALUES (?, ?)");
  for (const centroId of centros) await ins.bind(docId, centroId).run();
}

export const documentos: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // Listado con filtro por tipo/centro y búsqueda profunda en todos los campos.
  .get("/", async (c) => {
    const user = c.get("user");
    const where: string[] = [], params: unknown[] = [];
    const tipoId = Number(c.req.query("tipo_id"));
    if (Number.isInteger(tipoId) && tipoId >= 1) { where.push("d.tipo_id = ?"); params.push(tipoId); }
    const centroId = Number(c.req.query("centro_id"));
    if (Number.isInteger(centroId) && centroId >= 1) {
      where.push("EXISTS (SELECT 1 FROM documento_centros dc WHERE dc.documento_id = d.id AND dc.centro_id = ?)");
      params.push(centroId);
    }
    const q = (c.req.query("q") ?? "").trim();
    if (q) {
      const like = `%${esc(q)}%`;
      where.push(`(d.nombre LIKE ? ESCAPE '\\' OR d.descripcion LIKE ? ESCAPE '\\' OR d.fabricante LIKE ? ESCAPE '\\'
        OR d.url LIKE ? ESCAPE '\\' OR t.nombre LIKE ? ESCAPE '\\'
        OR EXISTS (SELECT 1 FROM documento_centros dc2 JOIN centros c2 ON c2.id = dc2.centro_id
                   WHERE dc2.documento_id = d.id AND c2.nombre LIKE ? ESCAPE '\\'))`);
      for (let i = 0; i < 6; i++) params.push(like);
    }
    // Visibilidad: solo administradores ven todas las fichas; el resto ve las
    // fichas de sus centros («Cada persona verá esta ficha si su centro está marcado»).
    if (user.rol !== "admin") {
      const cs = await centrosDeUsuario(c.env.DB, user.id);
      if (!cs.length) where.push("1 = 0");
      else {
        where.push(`EXISTS (SELECT 1 FROM documento_centros dc3 WHERE dc3.documento_id = d.id AND dc3.centro_id IN (${cs.map(() => "?").join(",")}))`);
        params.push(...cs);
      }
    }
    const sql = `${SELECT_FICHA}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(d.updated_at, d.created_at) DESC, d.id DESC`;
    const res = await c.env.DB.prepare(sql).bind(...params).all();
    return c.json({ items: res.results });
  })
  .get("/:id", async (c) => {
    const row = await cargarFicha(c.env.DB, Number(c.req.param("id")));
    if (!row) return c.json({ error: "Ficha no encontrada" }, 404);
    return c.json({ item: row });
  })
  .post("/", async (c) => {
    const user = c.get("user");
    if (!allowed(user, "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const f = await parseFicha(c, user, body, "insert");
    const res = await c.env.DB.prepare(
      "INSERT INTO documentos (nombre, tipo_id, url, descripcion, fabricante) VALUES (?, ?, ?, ?, ?)",
    ).bind(f.nombre, f.tipoId, f.url, f.descripcion, f.fabricante).run();
    const newId = Number((res.meta as { last_row_id?: number }).last_row_id);
    await guardarCentros(c.env.DB, newId, f.centros);
    const row = await cargarFicha(c.env.DB, newId);
    await logMovimiento(c.env.DB, user, "alta", "documentos", newId, `Ficha «${f.nombre}»`, null, null);
    return c.json({ item: row }, 201);
  })
  .put("/:id", async (c) => {
    const user = c.get("user");
    if (!allowed(user, "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    const existing = await c.env.DB.prepare("SELECT id FROM documentos WHERE id = ?").bind(id).first();
    if (!existing) return c.json({ error: "Ficha no encontrada" }, 404);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    body.id = id;
    const f = await parseFicha(c, user, body, "update");
    await c.env.DB.prepare(
      "UPDATE documentos SET nombre = ?, tipo_id = ?, url = ?, descripcion = ?, fabricante = ?, updated_at = datetime('now') WHERE id = ?",
    ).bind(f.nombre, f.tipoId, f.url, f.descripcion, f.fabricante, id).run();
    await guardarCentros(c.env.DB, id, f.centros);
    const row = await cargarFicha(c.env.DB, id);
    await logMovimiento(c.env.DB, user, "edicion", "documentos", id, `Ficha «${f.nombre}»`, null, null);
    return c.json({ item: row });
  })
  .delete("/:id", async (c) => {
    const user = c.get("user");
    if (!allowed(user, "centros")) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    const row = await c.env.DB.prepare("SELECT id, nombre FROM documentos WHERE id = ?").bind(id).first();
    if (!row) return c.json({ error: "Ficha no encontrada" }, 404);
    if (user.rol === "admin_centros") {
      const own = new Set(await centrosDeUsuario(c.env.DB, user.id));
      const actuales = (await c.env.DB.prepare("SELECT centro_id FROM documento_centros WHERE documento_id = ?").bind(id).all()).results as Array<{ centro_id: number }>;
      if (!actuales.every((r) => own.has(Number(r.centro_id)))) return c.json({ error: "Esa ficha pertenece a centros que no gestionas" }, 403);
    }
    await c.env.DB.prepare("DELETE FROM documento_centros WHERE documento_id = ?").bind(id).run();
    await c.env.DB.prepare("DELETE FROM documentos WHERE id = ?").bind(id).run();
    await logMovimiento(c.env.DB, user, "borrado", "documentos", id, `Ficha «${String(row.nombre)}»`, null, null);
    return c.json({ ok: true });
  });
