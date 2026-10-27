import type { CrudSpec } from "./crud";
import { createCrud, ValidationError } from "./crud";
import type { D1Database } from "./d1";
import { requireAuth } from "./auth";
import { logMovimiento } from "./audit";
import { STOCK_TABLA } from "./movimientos";

// Último consumo de la estación que todavía no se ha deshecho.
const ULTIMO_CONSUMO = `(SELECT mm.id FROM movimientos mm WHERE mm.estacion_id = t.id AND mm.accion = 'consumo'
  AND NOT EXISTS (SELECT 1 FROM movimientos d WHERE d.accion = 'deshacer_consumo' AND d.registro_id = mm.id)
  ORDER BY mm.id DESC LIMIT 1)`;

// Estaciones de consumo (antes «puntos de consumo»): centro → zona → subzona,
// soporte, tipo de consumible y artículo que se descuenta al escanear su QR.
export const estacionesSpec: CrudSpec = {
  table: "estaciones", orderBy: "id", refCentro: true,
  extraJoins: [
    " LEFT JOIN zonas z ON z.id = t.zona_id",
    " LEFT JOIN subzonas s ON s.id = t.subzona_id",
    " LEFT JOIN soportes sp ON sp.id = t.soporte_id",
    " LEFT JOIN consumibles_tipos ct ON ct.id = t.tipo_consumible_id",
    " LEFT JOIN quimicos aq ON aq.id = t.articulo_id AND t.articulo_tipo = 'quimicos'",
    " LEFT JOIN material_limpieza am ON am.id = t.articulo_id AND t.articulo_tipo = 'material_limpieza'",
    " LEFT JOIN consumibles_tipos act ON act.id = am.tipo_consumible_id",
    " LEFT JOIN epis ae ON ae.id = t.articulo_id AND t.articulo_tipo = 'epis'",
    " LEFT JOIN ropa_trabajo ar ON ar.id = t.articulo_id AND t.articulo_tipo = 'ropa_trabajo'",
    " LEFT JOIN maquinaria amq ON amq.id = t.articulo_id AND t.articulo_tipo = 'maquinaria'",
  ],
  extraSelect: [
    "z.nombre AS zona_nombre", "s.nombre AS subzona_nombre", "sp.nombre AS soporte_nombre",
    "ct.nombre AS tipo_nombre",
    "act.nombre AS articulo_tipo_consumible",
    "t.articulo_tipo",
    "(t.articulo_tipo || ':' || t.articulo_id) AS articulo",
    "COALESCE(aq.nombre, am.nombre, ae.descripcion, ar.prenda, amq.nombre) AS articulo_nombre",
    "COALESCE(aq.codigo, am.codigo, ae.codigo, ar.codigo) AS articulo_codigo",
    "COALESCE(aq.numero_lote, ae.codigo, ar.codigo) AS articulo_lote",
    "COALESCE(am.color, ae.color, ar.color) AS articulo_color",
    "COALESCE(aq.num_garrafas, am.cantidad, ae.stock, ar.stock, amq.cantidad) AS articulo_stock",
    "COALESCE(aq.stock_minimo, am.stock_minimo, ae.stock_minimo, ar.stock_minimo, 0) AS articulo_stock_minimo",
    `${ULTIMO_CONSUMO} AS ultimo_consumo_id`,
    `(SELECT m.cantidad FROM movimientos m WHERE m.id = ${ULTIMO_CONSUMO}) AS ultimo_consumo_cantidad`,
    `(SELECT m.descripcion FROM movimientos m WHERE m.id = ${ULTIMO_CONSUMO}) AS ultimo_consumo_detalle`,
    `(SELECT m.created_at FROM movimientos m WHERE m.id = ${ULTIMO_CONSUMO}) AS ultimo_consumo_fecha`,
  ],
  extraSearchCols: ["z.nombre", "s.nombre", "sp.nombre", "ct.nombre"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "centro_id", label: "Centro", type: "integer", required: true, min: 1 },
    { name: "zona_id", label: "Zona", type: "integer", required: true, min: 1 },
    { name: "subzona_id", label: "Subzona", type: "integer", required: false, min: 1 },
    { name: "soporte_id", label: "Soporte", type: "integer", required: false, min: 1 },
    { name: "tipo_consumible_id", label: "Tipo de consumible", type: "integer", required: true, min: 1 },
    { name: "articulo_id", label: "Artículo", type: "integer", required: true, min: 1 },
    { name: "activo", label: "Activa", type: "boolean", required: true },
  ],
  beforeWrite: async (db, data) => {
    if (data.zona_id === undefined || data.zona_id === null) throw new ValidationError("La zona es obligatoria");
    const zona = await db.prepare("SELECT id, centro_id FROM zonas WHERE id = ?").bind(Number(data.zona_id)).first();
    if (!zona) throw new ValidationError("La zona seleccionada no existe");
    if (data.centro_id !== undefined && data.centro_id !== null && Number(data.centro_id) !== Number(zona.centro_id)) {
      throw new ValidationError("La zona elegida no pertenece a ese centro");
    }
    data.centro_id = Number(zona.centro_id);
    if (data.subzona_id !== undefined && data.subzona_id !== null) {
      const sub = await db.prepare("SELECT id, zona_id FROM subzonas WHERE id = ?").bind(Number(data.subzona_id)).first();
      if (!sub) throw new ValidationError("La subzona seleccionada no existe");
      if (Number(sub.zona_id) !== Number(data.zona_id)) throw new ValidationError("La subzona no pertenece a la zona elegida");
    }
    if (data.soporte_id !== undefined && data.soporte_id !== null) {
      const so = await db.prepare("SELECT id FROM soportes WHERE id = ?").bind(Number(data.soporte_id)).first();
      if (!so) throw new ValidationError("El soporte seleccionado no existe");
    }
    if (data.tipo_consumible_id === undefined || data.tipo_consumible_id === null) throw new ValidationError("El tipo de consumible es obligatorio");
    const tipo = await db.prepare("SELECT id, articulo_tipo FROM consumibles_tipos WHERE id = ?").bind(Number(data.tipo_consumible_id)).first();
    if (!tipo) throw new ValidationError("El tipo de consumible no existe");
    const target = STOCK_TABLA[String(tipo.articulo_tipo)];
    if (!target) throw new ValidationError("Ese tipo de consumible no tiene artículos asociados");
    data.articulo_tipo = String(tipo.articulo_tipo);
    if (data.articulo_id === undefined || data.articulo_id === null) throw new ValidationError("El artículo es obligatorio");
    const art = await db.prepare(`SELECT id FROM ${target.tabla} WHERE id = ?`).bind(Number(data.articulo_id)).first();
    if (!art) throw new ValidationError("El artículo seleccionado no existe");
    return data;
  },
};

async function cargarEstacion(db: D1Database, id: number): Promise<Record<string, unknown> | null> {
  return db.prepare(
    `SELECT e.id, e.activo, e.articulo_tipo, e.articulo_id, e.zona_id, e.subzona_id,
      z.nombre AS zona_nombre, s.nombre AS subzona_nombre, sp.nombre AS soporte_nombre
     FROM estaciones e
     LEFT JOIN zonas z ON z.id = e.zona_id
     LEFT JOIN subzonas s ON s.id = e.subzona_id
     LEFT JOIN soportes sp ON sp.id = e.soporte_id
     WHERE e.id = ?`,
  ).bind(id).first();
}

function ubicacionDe(e: Record<string, unknown>): string {
  const partes = [e.zona_nombre, e.subzona_nombre, e.soporte_nombre].filter((v): v is string => Boolean(v));
  return partes.length ? partes.join(" · ") : `Estación #${String(e.id)}`;
}

export const estaciones = createCrud(estacionesSpec);

// Historial de la estación: últimos movimientos (consumos y deshaces) con su operario.
estaciones.get("/:id/movimientos", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Estación no válida" }, 400);
  const e = await c.env.DB.prepare("SELECT id FROM estaciones WHERE id = ?").bind(id).first();
  if (!e) return c.json({ error: "Estación no encontrada" }, 404);
  const raw = Number(c.req.query("limit"));
  const limit = Number.isInteger(raw) && raw >= 1 && raw <= 50 ? raw : 10;
  const res = await c.env.DB.prepare(
    `SELECT m.id, m.accion, m.cantidad, m.descripcion, m.created_at, u.nombre AS usuario_nombre
     FROM movimientos m LEFT JOIN usuarios u ON u.id = m.usuario_id
     WHERE m.estacion_id = ? ORDER BY m.id DESC LIMIT ?`,
  ).bind(id, limit).all();
  return c.json({ items: res.results });
});

// Al escanear el QR de la estación se descuenta el artículo que tiene asignado.
estaciones.post("/:id/consumir", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Estación no válida" }, 400);
  const e = await cargarEstacion(c.env.DB, id);
  if (!e) return c.json({ error: "Estación no encontrada" }, 404);
  if (Number(e.activo) !== 1) return c.json({ error: "La estación está desactivada" }, 400);
  let body: { cantidad?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const cantidad = body.cantidad === undefined ? 1 : Number(body.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) return c.json({ error: "La cantidad debe ser un número entero entre 1 y 100" }, 400);
  const target = STOCK_TABLA[String(e.articulo_tipo)];
  if (!target) return c.json({ error: "La estación no tiene un tipo de artículo válido" }, 500);
  const productoId = Number(e.articulo_id);
  // El nombre del artículo vive en columnas distintas según la tabla («prenda» en ropa de trabajo, «descripcion» en EPIs…).
  const prod = await c.env.DB.prepare(`SELECT id, ${target.columnaNombre} AS nombre, ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(productoId).first();
  if (!prod) return c.json({ error: "El artículo asignado a la estación ya no existe" }, 400);
  const upd = await c.env.DB.prepare(
    `UPDATE ${target.tabla} SET ${target.columna} = ${target.columna} - ?, updated_at = datetime('now') WHERE id = ? AND ${target.columna} >= ?`,
  ).bind(cantidad, productoId, cantidad).run();
  if (Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
    const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(productoId).first();
    const restantes = Number(row?.stock ?? 0);
    return c.json({ error: `Stock insuficiente: quedan${restantes === 1 ? "" : "n"} ${restantes} unidades` }, 400);
  }
  const stockRow = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(productoId).first();
  const ubicacion = ubicacionDe(e);
  await logMovimiento(c.env.DB, c.get("user"), "consumo", target.tabla, productoId,
    `${String(prod?.nombre ?? "Producto")} → ${ubicacion}`, cantidad, null, id);
  return c.json({
    ok: true,
    item: { nombre: prod.nombre ?? null, stock: stockRow?.stock ?? null },
    ubicacion,
    mensaje: `Descontada${cantidad === 1 ? "" : "s"} ${cantidad} unidad${cantidad === 1 ? "" : "es"} en ${ubicacion}`,
  });
});

// Deshacer: repone el último consumo (o uno concreto) de la estación.
estaciones.post("/:id/deshacer", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Estación no válida" }, 400);
  const e = await cargarEstacion(c.env.DB, id);
  if (!e) return c.json({ error: "Estación no encontrada" }, 404);
  let body: { movimiento_id?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const mid = body.movimiento_id === undefined || body.movimiento_id === null ? null : Number(body.movimiento_id);
  if (mid !== null && (!Number.isInteger(mid) || mid < 1)) return c.json({ error: "Movimiento no válido" }, 400);
  const mov = mid
    ? await c.env.DB.prepare("SELECT id, cantidad, tabla, registro_id, descripcion FROM movimientos WHERE id = ? AND estacion_id = ? AND accion = 'consumo'").bind(mid, id).first()
    : await c.env.DB.prepare(
        `SELECT m.id, m.cantidad, m.tabla, m.registro_id, m.descripcion FROM movimientos m
         WHERE m.estacion_id = ? AND m.accion = 'consumo'
           AND NOT EXISTS (SELECT 1 FROM movimientos d WHERE d.accion = 'deshacer_consumo' AND d.registro_id = m.id)
         ORDER BY m.id DESC LIMIT 1`,
      ).bind(id).first();
  if (!mov) return c.json({ error: "No hay consumos que deshacer en esta estación" }, 400);
  const ya = await c.env.DB.prepare("SELECT id FROM movimientos WHERE accion = 'deshacer_consumo' AND registro_id = ?").bind(Number(mov.id)).first();
  if (ya) return c.json({ error: "Ese consumo ya se ha deshecho" }, 400);
  const target = Object.values(STOCK_TABLA).find((t) => t.tabla === String(mov.tabla));
  if (!target || mov.registro_id == null) return c.json({ error: "Ese consumo no se puede deshacer" }, 400);
  const cantidad = Number(mov.cantidad ?? 0);
  if (cantidad > 0) {
    await c.env.DB.prepare(`UPDATE ${target.tabla} SET ${target.columna} = ${target.columna} + ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(cantidad, Number(mov.registro_id)).run();
  }
  await logMovimiento(c.env.DB, c.get("user"), "deshacer_consumo", "movimientos", Number(mov.id),
    `Se deshace: ${String(mov.descripcion ?? "consumo")}`, cantidad || null, null, id);
  const row = await c.env.DB.prepare(`SELECT ${target.columna} AS stock FROM ${target.tabla} WHERE id = ?`).bind(Number(mov.registro_id)).first();
  return c.json({ ok: true, stock: row?.stock ?? null, mensaje: "Consumo deshecho. Stock repuesto." });
});
