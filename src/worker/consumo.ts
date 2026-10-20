import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { logMovimiento } from "./movimientos";

// Descuento de consumibles escaneando el QR del puesto de consumo o a mano.
// Cualquier usuario autenticado puede descontar (el resto de CRUD es de admin).
type Tabla = { table: string; columna: string; etiqueta: string; singular: string; nombre: string };
const CONSUMIBLES: Record<string, Tabla> = {
  quimicos: { table: "quimicos", columna: "num_garrafas", etiqueta: "garrafas", singular: "garrafa", nombre: "químico" },
  material_limpieza: { table: "material_limpieza", columna: "cantidad", etiqueta: "unidades", singular: "unidad", nombre: "material" },
};

export const consumoRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  .post("/", async (c) => {
    let body: { tipo?: unknown; id?: unknown; cantidad?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const tipo = typeof body.tipo === "string" ? body.tipo : "";
    const target = CONSUMIBLES[tipo];
    if (!target) return c.json({ error: "Tipo de consumible no válido" }, 400);
    const id = Number(body.id), cantidad = Number(body.cantidad);
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Consumible no válido" }, 400);
    if (!Number.isInteger(cantidad) || cantidad < 1) return c.json({ error: "La cantidad debe ser un número entero positivo" }, 400);
    // Descuento atómico: solo aplica si queda stock suficiente.
    const upd = await c.env.DB.prepare(
      `UPDATE ${target.table} SET ${target.columna} = ${target.columna} - ?, updated_at = datetime('now') WHERE id = ? AND ${target.columna} >= ?`,
    ).bind(cantidad, id, cantidad).run();
    if (Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
      const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.table} WHERE id = ?`).bind(id).first();
      if (!row) return c.json({ error: "Consumible no encontrado" }, 404);
      const restantes = Number(row.stock);
      return c.json({ error: `Stock insuficiente: queda${restantes === 1 ? "" : "n"} ${restantes} ${restantes === 1 ? target.singular : target.etiqueta}` }, 400);
    }
    const row = await c.env.DB.prepare(`SELECT id, nombre, ${target.columna} AS stock FROM ${target.table} WHERE id = ?`).bind(id).first();
    const descripcion = `${String(row?.nombre ?? `#${id}`)} (${target.nombre})`;
    await logMovimiento(c.env.DB, c.get("user"), "consumo", target.table, id, descripcion, cantidad);
    return c.json({ ok: true, item: row, mensaje: `Descontada${cantidad === 1 ? "" : "s"} ${cantidad} ${cantidad === 1 ? target.singular : target.etiqueta}` });
  });
