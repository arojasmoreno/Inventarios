import { Hono } from "hono";
import type { CrudSpec } from "./crud";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import type { SessionUser } from "./auth";
import { requireAuth, requireAdmin } from "./auth";

// Registro de auditoría: quién consumió, entregó o ajustó qué, cuándo y a qué coste.
export async function logMovimiento(
  db: D1Database,
  user: SessionUser,
  accion: string,
  tabla: string | null,
  registroId: number | null,
  descripcion: string,
  cantidad: number | null,
  coste: number | null = null,
  motivo: string | null = null,
): Promise<void> {
  await db.prepare(
    "INSERT INTO movimientos (usuario_id, accion, tabla, registro_id, descripcion, cantidad, coste, motivo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(user.id, accion, tabla, registroId, descripcion, cantidad, coste, motivo).run();
}

export const movimientosSpec: CrudSpec = {
  table: "movimientos", orderBy: "id", refUsuario: true,
  extraSelect: ["t.accion", "t.tabla", "t.registro_id", "t.descripcion", "t.cantidad", "t.coste", "t.motivo"],
  extraSearchCols: ["t.accion", "t.descripcion", "t.motivo"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [],
};

// Recursos con stock que admiten entrada/salida/ajuste manual.
const STOCK: Record<string, { tabla: string; columna: string; nombre: string }> = {
  quimicos: { tabla: "quimicos", columna: "num_garrafas", nombre: "químico" },
  material_limpieza: { tabla: "material_limpieza", columna: "cantidad", nombre: "material" },
  epis: { tabla: "epis", columna: "stock", nombre: "EPI" },
  ropa_trabajo: { tabla: "ropa_trabajo", columna: "stock", nombre: "prenda" },
};

// Entradas, salidas y ajustes de stock (solo administradores).
export const movimientosRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  .post("/ajuste", requireAdmin, async (c) => {
    let body: { recurso?: unknown; id?: unknown; tipo?: unknown; cantidad?: unknown; motivo?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const recurso = typeof body.recurso === "string" ? body.recurso : "";
    const target = STOCK[recurso];
    if (!target) return c.json({ error: "Recurso no válido" }, 400);
    const tipo = typeof body.tipo === "string" ? body.tipo : "";
    if (tipo !== "entrada" && tipo !== "salida" && tipo !== "ajuste") return c.json({ error: "Tipo de movimiento no válido" }, 400);
    const id = Number(body.id), cantidad = Number(body.cantidad);
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Registro no válido" }, 400);
    if (!Number.isInteger(cantidad) || cantidad < 0 || (tipo !== "ajuste" && cantidad < 1)) return c.json({ error: "La cantidad debe ser un número entero válido" }, 400);
    const motivo = typeof body.motivo === "string" && body.motivo.trim() ? body.motivo.trim().slice(0, 300) : null;
    const item = await c.env.DB.prepare(`SELECT nombre, coste_unitario FROM ${target.tabla} WHERE id = ?`).bind(id).first();
    if (!item) return c.json({ error: "Registro no encontrado" }, 404);
    const costeUnit = Number(item.coste_unitario ?? 0) || 0;
    if (tipo === "ajuste") {
      await c.env.DB.prepare(`UPDATE ${target.tabla} SET ${target.columna} = ?, updated_at = datetime('now') WHERE id = ?`).bind(cantidad, id).run();
    } else {
      const signo = tipo === "entrada" ? "+" : "-";
      const upd = await c.env.DB.prepare(
        `UPDATE ${target.tabla} SET ${target.columna} = ${target.columna} ${signo} ?, updated_at = datetime('now') WHERE id = ?${tipo === "salida" ? ` AND ${target.columna} >= ?` : ""}`,
      ).bind(...(tipo === "salida" ? [cantidad, id, cantidad] : [cantidad, id])).run();
      if (tipo === "salida" && Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
        return c.json({ error: "Stock insuficiente para la salida" }, 400);
      }
    }
    const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(id).first();
    const coste = tipo === "ajuste" ? null : Number((costeUnit * cantidad).toFixed(2));
    await logMovimiento(c.env.DB, c.get("user"), tipo, target.tabla, id, `${String(item.nombre)} (${target.nombre})`, tipo === "ajuste" ? null : cantidad, coste, motivo);
    return c.json({ ok: true, stock: row?.stock ?? null, mensaje: `Movimiento registrado. Stock actual: ${Number(row?.stock ?? 0)}` });
  });
