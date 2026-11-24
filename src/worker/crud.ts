import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth, hashPassword, toHex, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import { centrosPermitidos, marcas } from "./alcance";
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
export class ValidationError extends Error {}
export type FieldType = "text" | "textarea" | "number" | "integer" | "date" | "boolean" | "enum" | "password";
export interface FieldSpec { name: string; label: string; type: FieldType; required?: boolean; enumValues?: string[]; min?: number; unique?: boolean; writeOnly?: boolean; maxLength?: number; placeholder?: string; }
export type PermLevel = "all" | "admin" | "centros";
export interface CrudSpec {
  table: string; orderBy: string; fields: FieldSpec[]; refCentro?: boolean; refUsuario?: boolean; refProveedor?: boolean; computed?: string;
  extraJoins?: string[]; extraSelect?: string[]; extraSearchCols?: string[];
  read: PermLevel; create: PermLevel; update: PermLevel; delete: PermLevel;
  // Columna con el centro de cada fila (p. ej. «t.centro_id»). Cuando se indica,
  // los usuarios de centro solo ven y modifican filas de sus centros.
  scopeCentro?: string;
  // La tabla de auditoría no genera registros de auditoría (evita bucles).
  noAudit?: boolean;
  // `opts.importando` avisa de que la fila viene de una importación masiva:
  // las comprobaciones de unicidad ya las hace el índice en memoria, así que
  // no hace falta una consulta por fila (D1 limita las consultas por petición).
  beforeWrite?: (db: D1Database, data: Record<string, unknown>, mode: "insert" | "update", existing?: Record<string, unknown>, opts?: { importando?: boolean }) => Promise<Record<string, unknown>>;
  beforeDelete?: (db: D1Database, user: SessionUser, row: Record<string, unknown>) => Promise<string | null>;
  afterWrite?: (db: D1Database, user: SessionUser, row: Record<string, unknown>, mode: "insert" | "update") => Promise<void>;
  afterDelete?: (db: D1Database, user: SessionUser, row: Record<string, unknown>) => Promise<void>;
}
export function allowed(user: SessionUser, level: PermLevel): boolean {
  if (level === "all") return true;
  if (level === "admin") return user.rol === "admin";
  // Nivel «centros»: administrador o administrador de centros.
  return user.rol === "admin" || user.rol === "admin_centros";
}
// Centro al que pertenece una fila: la propia columna o, en las subzonas, el de
// la zona a la que cuelgan.
async function centroDeFila(db: D1Database, table: string, row: Record<string, unknown>): Promise<number | null> {
  // En la propia tabla de centros el «centro» de la fila es su id.
  if (table === "centros") return row.id == null ? null : Number(row.id);
  if (table === "subzonas") {
    const zona = await db.prepare("SELECT centro_id FROM zonas WHERE id = ?").bind(Number(row.zona_id)).first();
    return zona ? Number(zona.centro_id) : null;
  }
  return row.centro_id == null ? null : Number(row.centro_id);
}
// Comprueba que el centro de una fila está entre los asignados al usuario.
// Devuelve el error a mostrar o null si puede gestionarla.
async function revisarCentro(db: D1Database, spec: CrudSpec, row: Record<string, unknown>, permitidos: number[] | null): Promise<string | null> {
  if (!spec.scopeCentro || !permitidos) return null;
  // Un centro nuevo se le asigna al administrador que lo crea (ver POST).
  if (spec.table === "centros" && row.id == null) return null;
  const centro = await centroDeFila(db, spec.table, row);
  if (centro !== null && permitidos.includes(centro)) return null;
  return "Solo puedes gestionar los datos de los centros que tienes asignados";
}
const TABLA_NOMBRE: Record<string, string> = {
  centros: "Centro", usuarios: "Usuario", quimicos: "Químico", material_limpieza: "Material de limpieza",
  maquinaria: "Maquinaria", epis: "EPI", ropa_trabajo: "Ropa de trabajo", tallas_operarios: "Talla de operario",
  tipos_maquinaria: "Tipo de maquinaria", zonas: "Zona", subzonas: "Subzona", estaciones: "Estación",
  situaciones: "Situación", tipos_equipo: "Tipo de equipo",
  soportes: "Soporte", consumibles_tipos: "Tipo de consumible",
  productos_disponibles: "Producto disponible", pedidos_material: "Línea de pedido",
  proveedores: "Proveedor", pedidos: "Pedido", pedido_lineas: "Línea de pedido",
  formaciones: "Formación", operario_formaciones: "Formación de operario",
};
function nombreDe(spec: CrudSpec, row: Record<string, unknown>): string {
  const n = row.nombre ?? row.username ?? row.codigo ?? row.prenda ?? row.email;
  const label = n != null && String(n) !== "" ? `«${String(n)}»` : `#${String(row.id)}`;
  return `${TABLA_NOMBRE[spec.table] ?? spec.table} ${label}`;
}
// Auditoría genérica de altas, ediciones y borrados de cada sección.
// En ediciones se añaden los campos cambiados con su valor anterior → nuevo.
async function audit(c: Ctx, spec: CrudSpec, accion: "alta" | "edicion" | "borrado", row: Record<string, unknown>, before?: Record<string, unknown>): Promise<void> {
  if (spec.noAudit) return;
  let descripcion = nombreDe(spec, row);
  if (accion === "edicion" && before) {
    const cambios: string[] = [];
    for (const f of spec.fields) {
      if (f.writeOnly || f.type === "password" || f.name === "foto") continue;
      const a = before[f.name] ?? null, b = row[f.name] ?? null;
      if (String(a ?? "") === String(b ?? "")) continue;
      cambios.push(`${f.label}: «${String(a ?? "—")}» → «${String(b ?? "—")}»`);
      if (cambios.length >= 8) break;
    }
    if (cambios.length) descripcion += ` · ${cambios.join("; ")}`;
  }
  await logMovimiento(c.env.DB, c.get("user"), accion, spec.table, Number(row.id) || null, descripcion, null, null);
}
// Alcance del rol «administrador de centros»: solo puede editar y borrar los
// centros que tiene asignados (un centro nuevo creado por él se le asigna solo).
async function centroScope(c: Ctx, user: SessionUser, id: number, _mode: "update" | "delete"): Promise<string | null> {
  if (user.rol !== "admin_centros") return null;
  const own = await c.env.DB.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?").bind(user.id, id).first();
  return own ? null : "Solo puedes modificar los centros asignados a tu usuario";
}
// Fecha local (ISO, YYYY-MM-DD) para las fechas que se rellenan solas.
export function hoyISO(): string {
  const d = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 10);
}
function parseValue(f: FieldSpec, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  if (raw === null) return { ok: true, value: null };
  switch (f.type) {
    case "text": case "textarea": {
      if (typeof raw !== "string") return { ok: false, error: `${f.label}: texto no válido` };
      const v = raw.trim(); if (f.maxLength && v.length > f.maxLength) return { ok: false, error: `${f.label}: máximo ${f.maxLength} caracteres` };
      return { ok: true, value: v === "" ? null : v };
    }
    case "number": case "integer": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(",", "."));
      if (!Number.isFinite(n)) return { ok: false, error: `${f.label}: debe ser un número` };
      if (f.type === "integer" && !Number.isInteger(n)) return { ok: false, error: `${f.label}: debe ser un número entero` };
      if (f.min !== undefined && n < f.min) return { ok: false, error: `${f.label}: mínimo ${f.min}` };
      return { ok: true, value: n };
    }
    case "date": {
      if (typeof raw !== "string" || raw.length !== 10 || raw[4] !== "-" || raw[7] !== "-") return { ok: false, error: `${f.label}: fecha no válida` };
      const digits = `${raw.slice(0, 4)}${raw.slice(5, 7)}${raw.slice(8, 10)}`;
      if ([...digits].some((char) => char < "0" || char > "9")) return { ok: false, error: `${f.label}: fecha no válida` };
      const date = new Date(`${raw}T00:00:00Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return { ok: false, error: `${f.label}: fecha no válida` };
      return { ok: true, value: raw };
    }
    case "boolean":
      if (typeof raw === "boolean") return { ok: true, value: raw ? 1 : 0 };
      if (raw === 1 || raw === "1" || raw === "true") return { ok: true, value: 1 };
      if (raw === 0 || raw === "0" || raw === "false") return { ok: true, value: 0 };
      return { ok: false, error: `${f.label}: valor no válido` };
    case "enum": {
      const v = typeof raw === "string" ? raw.trim() : "";
      if (!f.enumValues || !f.enumValues.includes(v)) return { ok: false, error: `${f.label}: opción no válida` };
      return { ok: true, value: v };
    }
    case "password":
      if (typeof raw !== "string") return { ok: false, error: `${f.label}: no válida` };
      return { ok: true, value: raw };
  }
}
export function validate(spec: CrudSpec, body: Record<string, unknown>, mode: "insert" | "update"): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const f of spec.fields) {
    if (!Object.prototype.hasOwnProperty.call(body, f.name)) { if (mode === "insert" && f.required && f.type !== "password") throw new ValidationError(`${f.label} es obligatorio`); continue; }
    const raw = body[f.name];
    if (raw === null || raw === undefined || raw === "") { if (f.required && f.type !== "password") throw new ValidationError(`${f.label} es obligatorio`); data[f.name] = null; continue; }
    const parsed = parseValue(f, raw); if (!parsed.ok) throw new ValidationError(parsed.error); data[f.name] = parsed.value;
  }
  if (mode === "insert") for (const f of spec.fields) if (f.required && f.type !== "password" && (data[f.name] === undefined || data[f.name] === null)) throw new ValidationError(`${f.label} es obligatorio`);
  return data;
}
// Los campos de texto únicos (códigos y nombres) se comparan sin distinguir
// mayúsculas ni espacios sobrantes: «M-004» y «m-004» son el mismo producto.
export function claveUnica(f: FieldSpec, valor: unknown): string {
  return f.type === "text" ? String(valor).trim().toUpperCase() : String(valor);
}
export async function checkUnique(db: D1Database, spec: CrudSpec, data: Record<string, unknown>, excludeId: number | null): Promise<void> {
  for (const f of spec.fields) {
    if (!f.unique || data[f.name] === undefined || data[f.name] === null) continue;
    const columna = f.type === "text" ? `TRIM(UPPER(${f.name}))` : f.name;
    const valor = f.type === "text" ? String(data[f.name]).trim().toUpperCase() : data[f.name];
    const row = await db.prepare(`SELECT id FROM ${spec.table} WHERE ${columna} = ?${excludeId ? " AND id != ?" : ""}`).bind(...(excludeId ? [valor, excludeId] : [valor])).first();
    if (row) throw new ValidationError(`Ya existe un registro con ${f.label} = ${String(data[f.name])}`);
  }
}
// Mensajes de SQLite traducidos a algo accionable: «UNIQUE constraint failed:
// productos_disponibles.codigo» no le dice nada a quien importa un catálogo.
function mensajeDeError(e: unknown): string {
  const bruto = e instanceof Error ? e.message : String(e ?? "");
  const unico = /UNIQUE constraint failed: [\w]+\.(\w+)/i.exec(bruto);
  if (unico) return `ya existe otro registro con el mismo valor en «${unico[1]}»`;
  if (/FOREIGN KEY constraint failed/i.test(bruto)) return "hace referencia a un registro que no existe";
  const obligatorio = /NOT NULL constraint failed: [\w]+\.(\w+)/i.exec(bruto);
  if (obligatorio) return `falta el campo «${obligatorio[1]}»`;
  return bruto || "no se pudo guardar";
}
export function createCrud(spec: CrudSpec): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>(); app.use("*", requireAuth);
  const selectCols = ["t.id", ...spec.fields.filter(f => !f.writeOnly).map(f => `t.${f.name}`), "t.created_at", "t.updated_at"];
  if (spec.refCentro) selectCols.push("c.nombre AS centro_nombre");
  if (spec.refUsuario) selectCols.push("u.nombre AS usuario_nombre", "u.username AS usuario_username");
  if (spec.refProveedor) selectCols.push("p.codigo AS proveedor_codigo", "p.nombre AS proveedor_nombre");
  if (spec.fields.some(f => f.name === "foto")) selectCols.push("t.foto IS NOT NULL AS tiene_foto");
  if (spec.computed) selectCols.push(spec.computed);
  if (spec.extraSelect) selectCols.push(...spec.extraSelect);
  const joins: string[] = [];
  if (spec.refCentro) joins.push(" LEFT JOIN centros c ON c.id = t.centro_id");
  if (spec.refUsuario) joins.push(" LEFT JOIN usuarios u ON u.id = t.usuario_id");
  if (spec.refProveedor) joins.push(" LEFT JOIN proveedores p ON p.id = t.proveedor_id");
  if (spec.extraJoins) joins.push(...spec.extraJoins);
  const baseSql = `SELECT ${selectCols.join(", ")} FROM ${spec.table} t${joins.join("")}`;
  const searchCols = [...spec.fields.filter(f => f.type === "text" || f.type === "textarea").map(f => `t.${f.name}`), ...(spec.extraSearchCols ?? [])];
  app.get("/", async c => {
    const user = c.get("user"); if (!allowed(user, spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const where: string[] = [], params: unknown[] = [], centroId = c.req.query("centro_id"), proveedorId = c.req.query("proveedor_id");
    if (centroId && centroId !== "all") { const id = Number(centroId); if (!Number.isInteger(id) || id < 1) return c.json({ error: "centro_id no válido" }, 400); where.push("t.centro_id = ?"); params.push(id); }
    if (spec.refProveedor && proveedorId && proveedorId !== "all") { const id = Number(proveedorId); if (!Number.isInteger(id) || id < 1) return c.json({ error: "proveedor_id no válido" }, 400); where.push("t.proveedor_id = ?"); params.push(id); }
    const q = (c.req.query("q") ?? "").trim(); if (q && searchCols.length) { where.push(`(${searchCols.map(col => `${col} LIKE ?`).join(" OR ")})`); for (let i=0;i<searchCols.length;i++) params.push(`%${q}%`); }
    // Alcance por centro: los usuarios de centro solo ven sus propios datos.
    const permitidos = spec.scopeCentro ? await centrosPermitidos(c.env.DB, user) : null;
    if (spec.scopeCentro && permitidos) {
      if (!permitidos.length) return c.json({ items: [] });
      where.push(`${spec.scopeCentro} IN (${marcas(permitidos.length)})`); params.push(...permitidos);
    }
    const sql = `${baseSql}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY t.${spec.orderBy} DESC`;
    return c.json({ items: (await c.env.DB.prepare(sql).bind(...params).all()).results });
  });
  app.get("/:id", async c => {
    if (!allowed(c.get("user"), spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(Number(c.req.param("id"))).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    if (spec.scopeCentro) {
      const err = await revisarCentro(c.env.DB, spec, row, await centrosPermitidos(c.env.DB, c.get("user")));
      if (err) return c.json({ error: err }, 403);
    }
    return c.json({ item: row });
  });
  app.post("/", async c => {
    if (!allowed(c.get("user"), spec.create)) return c.json({ error: "No tienes permiso para crear registros" }, 403);
    const body = await readBody(c); let data = validate(spec, body, "insert"); await checkUnique(c.env.DB, spec, data, null);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "insert");
    if (spec.scopeCentro) {
      const err = await revisarCentro(c.env.DB, spec, data, await centrosPermitidos(c.env.DB, c.get("user")));
      if (err) return c.json({ error: err }, 403);
    }
    const keys = Object.keys(data); if (!keys.length) throw new ValidationError("No hay datos que guardar");
    const result = await c.env.DB.prepare(`INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map(k => data[k])).run();
    const newId = Number((result.meta as { last_row_id?: number }).last_row_id);
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(newId).first();
    if (spec.afterWrite) await spec.afterWrite(c.env.DB, c.get("user"), row ?? data, "insert");
    // El «administrador de centros» pasa a gestionar el centro que acaba de crear.
    if (spec.table === "centros" && c.get("user").rol === "admin_centros") {
      await c.env.DB.prepare("INSERT OR IGNORE INTO usuario_centros (usuario_id, centro_id) VALUES (?, ?)").bind(c.get("user").id, newId).run();
    }
    await audit(c, spec, "alta", row ?? { ...data, id: newId });
    return c.json({ item: row }, 201);
  });
  app.put("/:id", async (c: Ctx): Promise<Response> => {
    if (!allowed(c.get("user"), spec.update)) return c.json({ error: "No tienes permiso para editar registros" }, 403);
    const id = Number(c.req.param("id")), existing = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!existing) return c.json({ error: "Registro no encontrado" }, 404);
    if (spec.table === "centros") { const err = await centroScope(c, c.get("user"), id, "update"); if (err) return c.json({ error: err }, 403); }
    const body = await readBody(c); let data = validate(spec, body, "update"); await checkUnique(c.env.DB, spec, data, id);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "update", existing); const keys = Object.keys(data); if (!keys.length) return c.json({ item: existing });
    if (spec.scopeCentro) {
      const permitidos = await centrosPermitidos(c.env.DB, c.get("user"));
      const err = await revisarCentro(c.env.DB, spec, existing, permitidos)
        ?? await revisarCentro(c.env.DB, spec, { ...existing, ...data }, permitidos);
      if (err) return c.json({ error: err }, 403);
    }
    const sets = [...keys.map(k => `${k} = ?`), "updated_at = datetime('now')"];
    await c.env.DB.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map(k => data[k]), id).run();
    const updated = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(id).first();
    if (spec.afterWrite) await spec.afterWrite(c.env.DB, c.get("user"), updated ?? existing, "update");
    await audit(c, spec, "edicion", updated ?? existing, existing);
    return c.json({ item: updated });
  });
  app.delete("/:id", async c => {
    const user = c.get("user"); if (!allowed(user, spec.delete)) return c.json({ error: "No tienes permiso para borrar registros" }, 403);
    const id = Number(c.req.param("id")), row = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    if (spec.table === "centros") { const err = await centroScope(c, user, id, "delete"); if (err) return c.json({ error: err }, 403); }
    if (spec.scopeCentro) {
      const err = await revisarCentro(c.env.DB, spec, row, await centrosPermitidos(c.env.DB, user));
      if (err) return c.json({ error: err }, 403);
    }
    if (spec.beforeDelete) { const error = await spec.beforeDelete(c.env.DB, user, row); if (error) return c.json({ error }, 400); }
    await c.env.DB.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).bind(id).run();
    if (spec.afterDelete) await spec.afterDelete(c.env.DB, user, row);
    await audit(c, spec, "borrado", row);
    return c.json({ ok: true });
  });
  // Importación masiva (CSV/Excel): upsert por el campo único (código/username).
  // Cada fila se valida con las mismas reglas que el alta individual; los fallos
  // de una fila no detienen el resto (se devuelven acumulados).
  //
  // D1 limita a 1.000 las consultas por invocación del Worker y un catálogo de
  // miles de filas agotaba el cupo haciendo una consulta por fila (el error
  // «too many API requests by single worker invocation» cortaba la importación
  // a las pocas centenas de registros). Las escrituras se acumulan y se mandan
  // con `db.batch`, que cuenta como UNA sola consulta.
  const importarFilas = async (c: Ctx) => {
    if (!allowed(c.get("user"), spec.create)) return c.json({ error: "No tienes permiso para importar registros" }, 403);
    let body: { rows?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    if (!Array.isArray(body.rows)) return c.json({ error: "Falta la lista de filas" }, 400);
    // Tope por petición: cada fila cuesta al menos una consulta y D1 corta a
    // las 1.000 por invocación del Worker.
    if (body.rows.length > 200) return c.json({ error: "Máximo 200 registros por importación" }, 400);
    const db = c.env.DB;
    // Índice de los registros existentes por CADA campo único: una fila puede
    // identificar el registro por cualquiera de ellos (p. ej. un proveedor por
    // su «codigo» aunque el ID sea otro), y el cotejo de texto ignora caja.
    const unicos = spec.fields.filter(f => f.unique);
    const uniqueField = unicos[0];
    const existentesPor = new Map<string, Map<string, Record<string, unknown>>>();
    if (unicos.length) {
      // Se traen las filas completas: así las validaciones de cada fila no
      // necesitan ir a la base de datos otra vez (1 consulta en total).
      const rows = (await db.prepare(`SELECT * FROM ${spec.table}`).all()).results as Record<string, unknown>[];
      for (const f of unicos) {
        const indice = new Map<string, Record<string, unknown>>();
        for (const r of rows) {
          const valor = r[f.name];
          if (valor === null || valor === undefined || String(valor).trim() === "") continue;
          indice.set(claveUnica(f, valor), r);
        }
        existentesPor.set(f.name, indice);
      }
    }
    let creados = 0, actualizados = 0;
    // Errores agrupados por causa: con un catálogo de 14.000 filas, devolver
    // solo ocho mensajes sueltos ocultaba el motivo real (un proveedor que no
    // existe, un código repetido…) y no decía cuántas filas habían fallado.
    const MAX_MENSAJES = 100;
    const errores: string[] = [];
    const causas = new Map<string, { filas: number; ejemplos: number[] }>();
    let fallos = 0;
    const fallo = (fila: number, mensaje: string) => {
      fallos++;
      const causa = causas.get(mensaje) ?? { filas: 0, ejemplos: [] };
      causa.filas++;
      if (causa.ejemplos.length < 5) causa.ejemplos.push(fila);
      causas.set(mensaje, causa);
      if (errores.length < MAX_MENSAJES) errores.push(`Fila ${fila}: ${mensaje}`);
    };
    // Claves ya planificadas en esta petición: dos filas con el mismo código en
    // el mismo archivo se avisan en vez de chocar contra el índice único.
    const planificadas = new Map<string, number>();
    type Tarea = { sql: string; valores: unknown[]; modo: "insert" | "update"; fila: number };
    let tareas: Tarea[] = [];
    const TANDA = 200;

    const volcar = async (): Promise<void> => {
      if (!tareas.length) return;
      const lote = tareas; tareas = [];
      if (db.batch) {
        try {
          await db.batch(lote.map(t => db.prepare(t.sql).bind(...t.valores)));
          for (const t of lote) { if (t.modo === "insert") creados++; else actualizados++; }
          return;
        } catch { /* alguna sentencia falla: se reintenta una a una para saber cuál */ }
      }
      for (const t of lote) {
        try {
          await db.prepare(t.sql).bind(...t.valores).run();
          if (t.modo === "insert") creados++; else actualizados++;
        } catch (e) {
          fallo(t.fila, mensajeDeError(e));
        }
      }
    };

    for (let i = 0; i < body.rows.length; i++) {
      let raw = body.rows[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { fallo(i + 1, "no es un registro válido"); continue; }
      // Comodidad: una columna «id» de texto se interpreta como el código/clave única.
      if (uniqueField && (raw as Record<string, unknown>)[uniqueField.name] === undefined && typeof (raw as Record<string, unknown>).id === "string" && (raw as Record<string, unknown>).id !== "") {
        raw = { ...(raw as Record<string, unknown>), [uniqueField.name]: (raw as Record<string, unknown>).id };
      }
      try {
        let data = validate(spec, raw as Record<string, unknown>, "insert");
        let mode: "insert" | "update" = "insert";
        let existingId: number | undefined;
        let existing: Record<string, unknown> | undefined;
        for (const f of unicos) {
          const valor = data[f.name];
          if (valor === undefined || valor === null || String(valor).trim() === "") continue;
          if (spec.table === "productos_disponibles" && f.name === "codigo") {
            const codigos = existentesPor.get("codigo");
            const entry = codigos?.get(claveUnica(f, valor));
            existingId = entry && "id" in entry ? (entry.id as number | undefined) : undefined;
            if (existingId != null) {
              mode = "update";
            }
            break;
          }
          const found = existentesPor.get(f.name)?.get(claveUnica(f, valor));
          if (!found) continue;
          mode = "update";
          // La fila completa ya viene del índice (SELECT *), sin consulta extra.
          existing = found;
          break;
        }
        // Si es un producto que ya existe, se alimenta `existing` con su id para
        // que el motor de upsert pueda hacer UPDATE; pero no se vuelve a validar
        // su proveedor porque el producto ya existe y su proveedor no cambia en
        // esta importación (solo se puede actualizar código/precio).
        if (spec.table === "productos_disponibles" && existingId != null) {
          existing = { id: existingId } as Record<string, unknown>;
          // El producto ya existe: saltamos la comprobación de proveedor del
          // beforeWrite (el producto ya tiene proveedor asignado).
          if (spec.beforeWrite) await spec.beforeWrite(db, data, mode, undefined, { importando: true });
        } else if (spec.beforeWrite) {
          await spec.beforeWrite(db, data, mode, existing, { importando: true });
        }
        if (spec.scopeCentro) {
          const permitidos = await centrosPermitidos(db, c.get("user"));
          const err = await revisarCentro(db, spec, mode === "update" ? (existing ?? data) : data, permitidos);
          if (err) { fallo(i + 1, err); continue; }
        }
        const keys = Object.keys(data); if (!keys.length) { fallo(i + 1, "sin datos que guardar"); continue; }

        if (mode === "insert") {
          const repetida = uniqueField && data[uniqueField.name] !== undefined && data[uniqueField.name] !== null
            ? planificadas.get(claveUnica(uniqueField, data[uniqueField.name]))
            : undefined;
          if (repetida !== undefined) {
            fallo(i + 1, `${uniqueField.label} «${String(data[uniqueField.name])}» ya aparece en la fila ${repetida} del archivo`);
            continue;
          }
        }

        // Las tablas con afterWrite necesitan el id recién creado (p. ej. la
        // maquinaria siembra su histórico): esas filas se guardan al momento.
        if (spec.afterWrite) {
          let rowId: number;
          if (mode === "insert") {
            const res = await db.prepare(`INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map(k => data[k])).run();
            rowId = Number((res.meta as { last_row_id?: number }).last_row_id);
            creados++;
          } else {
            const sets = [...keys.map(k => `${k} = ?`), "updated_at = datetime('now')"];
            await db.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map(k => data[k]), Number(existing?.id)).run();
            rowId = Number(existing?.id);
            actualizados++;
          }
          const row = { ...data, id: rowId };
          await spec.afterWrite(db, c.get("user"), row, mode);
          await audit(c, spec, mode === "insert" ? "alta" : "edicion", row, mode === "update" ? existing : undefined);
          if (spec.table === "centros" && mode === "insert" && c.get("user").rol === "admin_centros") {
            await db.prepare("INSERT OR IGNORE INTO usuario_centros (usuario_id, centro_id) VALUES (?, ?)").bind(c.get("user").id, rowId).run();
          }
          continue;
        }

        if (mode === "insert") {
          tareas.push({
            sql: `INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`,
            valores: keys.map(k => data[k]), modo: mode, fila: i + 1,
          });
          if (uniqueField && data[uniqueField.name] !== undefined && data[uniqueField.name] !== null) {
            planificadas.set(claveUnica(uniqueField, data[uniqueField.name]), i + 1);
          }
        } else {
          const sets = [...keys.map(k => `${k} = ?`), "updated_at = datetime('now')"];
          tareas.push({ sql: `UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`, valores: [...keys.map(k => data[k]), Number(existing?.id)], modo: mode, fila: i + 1 });
        }
        if (tareas.length >= TANDA) await volcar();
      } catch (e) {
        fallo(i + 1, mensajeDeError(e));
      }
    }
    await volcar();
    // Un solo movimiento de auditoría por importación: 14.000 altas
    // individuales llenaban el histórico sin aportar nada.
    if (creados || actualizados) {
      await logMovimiento(db, c.get("user"), "importacion", spec.table, null,
        `Importación masiva: ${creados} creados, ${actualizados} actualizados`, null);
    }
    // Resumen por causa, de la más frecuente a la menos: es lo que se muestra
    // en pantalla y lo que se puede descargar como informe de errores.
    const resumen = [...causas.entries()]
      .map(([mensaje, c]) => ({ mensaje, filas: c.filas, ejemplos: c.ejemplos }))
      .sort((a, b) => b.filas - a.filas);
    // Siempre 200 con el resumen: devolver 400 cuando no se guardó nada hacía
    // que el cliente reintentara el lote entero y solo mostrara un mensaje.
    return c.json({ creados, actualizados, errores, fallos, total: body.rows.length, causas: resumen });
  };
  app.post("/import", async c => {
    // Cualquier fallo inesperado se devuelve con su causa: «Error interno del
    // servidor» no decía nada al importar un catálogo grande.
    try {
      return await importarFilas(c);
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : "error inesperado";
      return c.json({ error: `No se pudo importar: ${mensaje}` }, 500);
    }
  });
  // Foto del artículo (base64) sin cargarla en el listado.
  if (spec.fields.some(f => f.name === "foto")) {
    app.get("/:id/foto", async c => {
      if (!allowed(c.get("user"), spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
      const row = await c.env.DB.prepare(`SELECT foto FROM ${spec.table} WHERE id = ?`).bind(Number(c.req.param("id"))).first();
      if (!row || !row.foto || typeof row.foto !== "string") return c.json({ error: "Foto no disponible" }, 404);
      const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(row.foto);
      if (!m) return c.json({ error: "Foto no válida" }, 500);
      const bin = Uint8Array.from(atob(m[2]), ch => ch.charCodeAt(0));
      return new Response(bin, { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=300" } });
    });
  }
  return app;
}
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try { const body: unknown = await c.req.json(); if (body && typeof body === "object") return body as Record<string, unknown>; } catch { /* JSON inválido */ }
  throw new ValidationError("Petición inválida");
}
export async function hashPasswordField(data: Record<string, unknown>): Promise<void> {
  const password = data.password;
  if (typeof password === "string" && password.length > 0) { const salt = toHex(crypto.getRandomValues(new Uint8Array(16))); data.salt = salt; data.password_hash = await hashPassword(password, salt); }
  delete data.password;
}
