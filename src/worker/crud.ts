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
  table: string; orderBy: string; fields: FieldSpec[]; refCentro?: boolean; computed?: string;
  read: PermLevel; create: PermLevel; update: PermLevel; delete: PermLevel;
  beforeWrite?: (db: D1Database, data: Record<string, unknown>, mode: "insert" | "update") => Promise<Record<string, unknown>>;
  beforeDelete?: (db: D1Database, user: SessionUser, row: Record<string, unknown>) => Promise<string | null>;
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
    case "date": if (typeof raw !== "string" || !/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return { ok: false, error: `${f.label}: fecha no válida` }; else return { ok: true, value: raw };
    case "boolean": if (typeof raw === "boolean") return { ok: true, value: raw ? 1 : 0 }; else if ([1,"1","true"].includes(raw as never)) return { ok: true, value: 1 }; else if ([0,"0","false"].includes(raw as never)) return { ok: true, value: 0 }; else return { ok: false, error: `${f.label}: valor no válido` };
    case "enum": { const v = typeof raw === "string" ? raw.trim() : ""; if (!f.enumValues || !f.enumValues.includes(v)) return { ok: false, error: `${f.label}: opción no válida` }; return { ok: true, value: v }; }
    case "password": if (typeof raw !== "string") return { ok: false, error: `${f.label}: no válida` }; else return { ok: true, value: raw };
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
  const selectCols = ["t.id", ...spec.fields.filter((f) => !f.writeOnly).map((f) => `t.${f.name}`), "t.created_at", "t.updated_at"];
  if (spec.refCentro) selectCols.push("c.nombre AS centro_nombre"); if (spec.computed) selectCols.push(spec.computed);
  const join = spec.refCentro ? " LEFT JOIN centros c ON c.id = t.centro_id" : "";
  const baseSql = `SELECT ${selectCols.join(", ")} FROM ${spec.table} t${join}`;
  const searchCols = spec.fields.filter((f) => f.type === "text" || f.type === "textarea").map((f) => `t.${f.name}`);
  app.get("/", async (c) => {
    const user = c.get("user"); if (!allowed(user, spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const where: string[] = [], params: unknown[] = []; const centroId = c.req.query("centro_id");
    if (centroId && centroId !== "all") { const id = Number(centroId); if (!Number.isInteger(id) || id < 1) return c.json({ error: "centro_id no válido" }, 400); where.push("t.centro_id = ?"); params.push(id); }
    const q = (c.req.query("q") ?? "").trim(); if (q && searchCols.length) { where.push(`(${searchCols.map((col) => `${col} LIKE ?`).join(" OR ")})`); for (let i=0;i<searchCols.length;i++) params.push(`%${q}%`); }
    const sql = `${baseSql}${where.length ? " WHERE " + where.join(" AND ") : ""} ORDER BY t.${spec.orderBy} DESC`;
    return c.json({ items: (await c.env.DB.prepare(sql).bind(...params).all()).results });
  });
  app.get("/:id", async (c) => {
    if (!allowed(c.get("user"), spec.read)) return c.json({ error: "Requiere permisos de administrador" }, 403);
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(Number(c.req.param("id"))).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404); return c.json({ item: row });
  });
  app.post("/", async (c) => {
    if (!allowed(c.get("user"), spec.create)) return c.json({ error: "No tienes permiso para crear registros" }, 403);
    const body = await readBody(c); let data = validate(spec, body, "insert"); await checkUnique(c.env.DB, spec, data, null);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "insert");
    const keys = Object.keys(data); if (!keys.length) throw new ValidationError("No hay datos que guardar");
    const res = await c.env.DB.prepare(`INSERT INTO ${spec.table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).bind(...keys.map((k) => data[k])).run();
    const row = await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind((res.meta as { last_row_id?: number }).last_row_id).first(); return c.json({ item: row }, 201);
  });
  app.put("/:id", async (c) => {
    if (!allowed(c.get("user"), spec.update)) return c.json({ error: "No tienes permiso para editar registros" }, 403);
    const id = Number(c.req.param("id")); const existing = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!existing) return c.json({ error: "Registro no encontrado" }, 404);
    const body = await readBody(c); let data = validate(spec, body, "update"); await checkUnique(c.env.DB, spec, data, id);
    if (spec.beforeWrite) data = await spec.beforeWrite(c.env.DB, data, "update"); const keys = Object.keys(data); if (!keys.length) return c.json({ item: existing });
    const sets = [...keys.map((k) => `${k} = ?`), "updated_at = datetime('now')"];
    await c.env.DB.prepare(`UPDATE ${spec.table} SET ${sets.join(", ")} WHERE id = ?`).bind(...keys.map((k) => data[k]), id).run();
    return c.json({ item: await c.env.DB.prepare(`${baseSql} WHERE t.id = ?`).bind(id).first() });
  });
  app.delete("/:id", async (c) => {
    const user = c.get("user"); if (!allowed(user, spec.delete)) return c.json({ error: "No tienes permiso para borrar registros" }, 403);
    const id = Number(c.req.param("id")); const row = await c.env.DB.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).bind(id).first();
    if (!row) return c.json({ error: "Registro no encontrado" }, 404);
    if (spec.beforeDelete) { const error = await spec.beforeDelete(c.env.DB, user, row); if (error) return c.json({ error }, 400); }
    await c.env.DB.prepare(`DELETE FROM ${spec.table} WHERE id = ?`).bind(id).run(); return c.json({ ok: true });
  });
  return app;
}
async function readBody(c: Ctx): Promise<Record<string, unknown>> {
  try { const body: unknown = await c.req.json(); if (body && typeof body === "object") return body as Record<string, unknown>; } catch { /* petición JSON inválida */ }
  throw new ValidationError("Petición inválida");
}
export async function hashPasswordField(data: Record<string, unknown>): Promise<void> {
  const password = data.password;
  if (typeof password === "string" && password.length > 0) { const salt = toHex(crypto.getRandomValues(new Uint8Array(16))); data.salt = salt; data.password_hash = await hashPassword(password, salt); }
  delete data.password;
}
