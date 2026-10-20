import { Hono } from "hono";
import type { Context } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth, hashPassword, toHex, type SessionUser } from "./auth";
type Ctx = Context<{ Bindings: Env; Variables: Variables }>;
export class ValidationError extends Error {}
export type FieldType = "text" | "textarea" | "number" | "integer" | "date" | "boolean" | "enum" | "password";
export interface FieldSpec { name: string; label: string; type: FieldType; required?: boolean; enumValues?: string[]; min?: number; unique?: boolean; writeOnly?: boolean; maxLength?: number; placeholder?: string; }
export type PermLevel = "all" | "admin";
export interface CrudSpec {
  table: string; orderBy: string; fields: FieldSpec[]; refCentro?: boolean; refUsuario?: boolean; computed?: string;
  extraJoins?: string[]; extraSelect?: string[]; extraSearchCols?: string[];
  read: PermLevel; create: PermLevel; update: PermLevel; delete: PermLevel;
  beforeWrite?: (db: D1Database, data: Record<string, unknown>, mode: "insert" | "update", existing?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  beforeDelete?: (db: D1Database, user: SessionUser, row: Record<string, unknown>) => Promise<string | null>;
  afterWrite?: (db: D1Database, user: SessionUser, row: Record<string, unknown>, mode: "insert" | "update") => Promise<void>;
  afterDelete?: (db: D1Database, user: SessionUser, row: Record<string, unknown>) => Promise<void>;
}
export function allowed(user: SessionUser, level: PermLevel): boolean { return level === "all" || user.rol === "admin"; }
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
function validate(spec: CrudSpec, body: Record<string, unknown>, mode: "insert" | "update"): Record<string, unknown> {
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
async function checkUnique(db: D1Database, spec: CrudSpec, data: Record<string, unknown>, excludeId: number | null): Promise<void> {
  for (const f of spec.fields) {
    if (!f.unique || data[f.name] === undefined || data[f.name] === null) continue;
    const row = await db.prepare(`SELECT id FROM ${spec.table} WHERE ${f.name} = ?${excludeId ? " AND id != ?" : ""}`).bind(...(excludeId ? [data[f.name], excludeId] : [data[f.name]])).first();
    if (row) throw new ValidationError(`Ya existe un registro con ${f.label} = ${String(data[f.name])}`);
  }
}
export function createCrud(spec: CrudSpec): Hono<{ Bindings: Env; Variables: Variables }> {
  const app = new Hono<{ Bindings: Env; Variables: Variables }>(); app.use("*", requireAuth);
  const selectCols = ["t.id", ...spec.fields.filter(f => !f.writeOnly).map(f => `t.${f.name}`), "t.created_at", "t.updated_at"];
  if (spec.refCentro) selectCols.push("c.nombre AS centro_nombre");
  if (spec.refUsuario) selectCols.push("u.nombre AS usuario_nombre", "u.username AS usuario_username");
  if (spec.fields.some(f => f.name === "foto")) selectCols.push("t.foto IS NOT NULL AS tiene_foto");
  if (spec.computed) selectCols.push(spec.computed);
  if (spec.extraSelect) selectCols.push(...spec.extraSelect);
  const joins: string[] = [];
  if (spec.refCentro) joins.push(" LEFT JOIN centros c ON c.id = t.centro_id");
  if (spec.refUsuario) joins.push(" LEFT JOIN usuarios u ON u.id = t.usuario_id");
  if (spec.extraJoins) joins.push(...spec.extraJoins);
  const baseSql = `SELECT ${selectCols.join(", ")} FROM ${spec.table} t${joins.join("")}`;
  const searchCols = [...spec.fields.filter(f => f.type === "text" || f.type === "textarea").map(f => `t.${f.name}`), ...(spec.extraSearchCols ?? [])];
  app.get("/", async c => {
    const user = c.get("user"); if (!allowed(user, spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const where: string[] = [], params: unknown[] = [], centroId = c.req.query("centro_id");
    if (centroId && centroId !== "all") { const id = Number(centroId); if (!Number.isInteger(id) || id < 1) return c.json({ error: "centro_id no válido" }, 400); where.push("t.centro_id = ?"); params.push(id); }
    const q = (c.req.query("q") ?? "").trim(); if (q && searchCols.length) { where.push(`(${searchCols.map(col => `${col} LIKE ?`).join(" OR ")})`); for (let i=0;i<searchCols.length;i++) params.push(`%${q}%`); }
    const sql = `${baseSql}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY t.${spec.orderBy} DESC`;
    return c.json({ items: (await c.env.DB.prepare(sql).bind(...params).all()).results });
  });
  app.get("/:id", async c => {
    if (!allowed(c.get("user"), spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(Number(c.req.param("id"))).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404); return c.json({ item: row });
  });
  app.post("/", async c => {
    if (!allowed(c.get("user"), spec.create)) return c.json({ error: "No tienes permiso para crear registros" }, 403);
    const body = await readBody(c); let data = validate(spec, body, "insert"); await checkUnique(c.env.DB, spec, data, null);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "insert");
    const keys = Object.keys(data); if (!keys.length) throw new ValidationError("No hay datos que guardar");
    const result = await c.env.DB.prepare(`INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map(k => data[k])).run();
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind((result.meta as { last_row_id?: number }).last_row_id).first();
    if (spec.afterWrite) await spec.afterWrite(c.env.DB, c.get("user"), row ?? data, "insert");
    return c.json({ item: row }, 201);
  });
  app.put("/:id", async (c: Ctx): Promise<Response> => {
    if (!allowed(c.get("user"), spec.update)) return c.json({ error: "No tienes permiso para editar registros" }, 403);
    const id = Number(c.req.param("id")), existing = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!existing) return c.json({ error: "Registro no encontrado" }, 404);
    const body = await readBody(c); let data = validate(spec, body, "update"); await checkUnique(c.env.DB, spec, data, id);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "update", existing); const keys = Object.keys(data); if (!keys.length) return c.json({ item: existing });
    const sets = [...keys.map(k => `${k} = ?`), "updated_at = datetime('now')"];
    await c.env.DB.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map(k => data[k]), id).run();
    const updated = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(id).first();
    if (spec.afterWrite) await spec.afterWrite(c.env.DB, c.get("user"), updated ?? existing, "update");
    return c.json({ item: updated });
  });
  app.delete("/:id", async c => {
    const user = c.get("user"); if (!allowed(user, spec.delete)) return c.json({ error: "No tienes permiso para borrar registros" }, 403);
    const id = Number(c.req.param("id")), row = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    if (spec.beforeDelete) { const error = await spec.beforeDelete(c.env.DB, user, row); if (error) return c.json({ error }, 400); }
    await c.env.DB.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).bind(id).run();
    if (spec.afterDelete) await spec.afterDelete(c.env.DB, user, row);
    return c.json({ ok: true });
  });
  // Importación masiva (CSV): upsert por el campo único (código/username).
  // Cada fila se valida con las mismas reglas que el alta individual; los fallos
  // de una fila no detienen el resto (se devuelven acumulados).
  app.post("/import", async c => {
    if (!allowed(c.get("user"), spec.create)) return c.json({ error: "No tienes permiso para importar registros" }, 403);
    let body: { rows?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    if (!Array.isArray(body.rows)) return c.json({ error: "Falta la lista de filas" }, 400);
    if (body.rows.length > 500) return c.json({ error: "Máximo 500 registros por importación" }, 400);
    const uniqueField = spec.fields.find(f => f.unique);
    const existingByCode = new Map<string, Record<string, unknown>>();
    if (uniqueField) {
      const rows = (await c.env.DB.prepare(`SELECT id, ${uniqueField.name} FROM ${spec.table} WHERE ${uniqueField.name} IS NOT NULL`).all()).results as Record<string, unknown>[];
      for (const r of rows) existingByCode.set(String(r[uniqueField.name]), r);
    }
    let creados = 0, actualizados = 0;
    const errores: string[] = [];
    for (let i = 0; i < body.rows.length; i++) {
      let raw = body.rows[i];
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) { errores.push(`Fila ${i + 1}: no es un registro válido`); continue; }
      // Comodidad: una columna «id» de texto se interpreta como el código/clave única.
      if (uniqueField && (raw as Record<string, unknown>)[uniqueField.name] === undefined && typeof (raw as Record<string, unknown>).id === "string" && (raw as Record<string, unknown>).id !== "") {
        raw = { ...(raw as Record<string, unknown>), [uniqueField.name]: (raw as Record<string, unknown>).id };
      }
      try {
        let data = validate(spec, raw as Record<string, unknown>, "insert");
        let mode: "insert" | "update" = "insert";
        let existing: Record<string, unknown> | undefined;
        if (uniqueField && data[uniqueField.name] !== undefined && data[uniqueField.name] !== null) {
          const found = existingByCode.get(String(data[uniqueField.name]));
          if (found) {
            mode = "update";
            existing = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(Number(found.id)).first() ?? found;
          }
        }
        await checkUnique(c.env.DB, spec, data, mode === "update" ? Number(existing?.id) : null);
        if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, mode, existing);
        const keys = Object.keys(data); if (!keys.length) { errores.push(`Fila ${i + 1}: sin datos que guardar`); continue; }
        let rowId: number;
        if (mode === "insert") {
          const res = await c.env.DB.prepare(`INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map(k => data[k])).run();
          rowId = Number((res.meta as { last_row_id?: number }).last_row_id);
          creados++;
        } else {
          const sets = [...keys.map(k => `${k} = ?`), "updated_at = datetime('now')"];
          await c.env.DB.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map(k => data[k]), Number(existing?.id)).run();
          rowId = Number(existing?.id);
          actualizados++;
        }
        const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(rowId).first();
        if (spec.afterWrite) await spec.afterWrite(c.env.DB, c.get("user"), row ?? data, mode);
        if (mode === "insert" && uniqueField && data[uniqueField.name] !== undefined && data[uniqueField.name] !== null) {
          existingByCode.set(String(data[uniqueField.name]), { id: rowId, [uniqueField.name]: data[uniqueField.name] });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : "registro no válido";
        if (errores.length < 8) errores.push(`Fila ${i + 1}: ${msg}`);
      }
    }
    if (!creados && !actualizados && errores.length) return c.json({ error: errores[0], errores }, 400);
    return c.json({ creados, actualizados, errores });
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
