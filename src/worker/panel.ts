import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";

type Row = Record<string, unknown>;

// Panel de control: resumen operativo del día a día (consumos recientes,
// estaciones sin uso, artículos por debajo del stock mínimo y consumo por zona).
export const panelRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
panelRoutes.use("*", requireAuth);
panelRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const [hoy, semana, mes, porDia, porZona, sinUso, bajoMin, vencidos] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(cantidad), 0) AS unidades FROM movimientos
       WHERE accion = 'consumo' AND created_at >= datetime('now')`,
    ).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(cantidad), 0) AS unidades FROM movimientos
       WHERE accion = 'consumo' AND created_at >= datetime('now', '-7 days')`,
    ).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(cantidad), 0) AS unidades FROM movimientos
       WHERE accion = 'consumo' AND created_at >= datetime('now', '-30 days')`,
    ).first<Row>(),
    // Consumo por día de los últimos 14 días (para el gráfico del panel).
    db.prepare(
      `SELECT date(created_at) AS fecha, COALESCE(SUM(cantidad), 0) AS unidades, COUNT(*) AS movimientos
       FROM movimientos WHERE accion = 'consumo' AND created_at >= datetime('now', '-13 days')
       GROUP BY fecha ORDER BY fecha`,
    ).all<Row>(),
    // Consumo por zona de los últimos 30 días (enlaza con el listado de estaciones).
    db.prepare(
      `SELECT z.id AS zona_id, COALESCE(z.nombre, '(sin zona)') AS zona, COALESCE(c.nombre, '(sin centro)') AS centro,
              COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades, MAX(m.created_at) AS ultimo
       FROM movimientos m
       JOIN estaciones e ON e.id = m.estacion_id
       LEFT JOIN zonas z ON z.id = e.zona_id
       LEFT JOIN centros c ON c.id = e.centro_id
       WHERE m.accion = 'consumo' AND m.created_at >= datetime('now', '-30 days')
       GROUP BY z.id, zona, centro ORDER BY unidades DESC LIMIT 20`,
    ).all<Row>(),
    // Estaciones activas sin ningún consumo (o sin consumos) en los últimos 30 días.
    db.prepare(
      `SELECT e.id, z.nombre AS zona_nombre, s.nombre AS subzona_nombre, sp.nombre AS soporte_nombre,
              COALESCE(ct.nombre, '') AS tipo_nombre
       FROM estaciones e
       LEFT JOIN zonas z ON z.id = e.zona_id
       LEFT JOIN subzonas s ON s.id = e.subzona_id
       LEFT JOIN soportes sp ON sp.id = e.soporte_id
       LEFT JOIN consumibles_tipos ct ON ct.id = e.tipo_consumible_id
       WHERE e.activo = 1 AND NOT EXISTS (
         SELECT 1 FROM movimientos m WHERE m.estacion_id = e.id AND m.accion = 'consumo'
           AND m.created_at >= datetime('now', '-30 days'))
       ORDER BY z.nombre, s.nombre LIMIT 30`,
    ).all<Row>(),
    // Artículos con stock por debajo del mínimo (maquinaria no tiene mínimo).
    db.prepare(
      `SELECT nombre, num_garrafas AS stock, stock_minimo AS minimo, codigo, 'Químicos' AS categoria, 'quimicos' AS seccion FROM quimicos WHERE stock_minimo > 0 AND num_garrafas <= stock_minimo
       UNION ALL SELECT nombre, cantidad, stock_minimo, codigo, 'Material de limpieza', 'material' FROM material_limpieza WHERE stock_minimo > 0 AND cantidad <= stock_minimo
       UNION ALL SELECT COALESCE(NULLIF(descripcion, ''), codigo), stock, stock_minimo, codigo, 'EPIs', 'epis' FROM epis WHERE stock_minimo > 0 AND stock <= stock_minimo
       UNION ALL SELECT prenda, stock, stock_minimo, codigo, 'Ropa de trabajo', 'ropa' FROM ropa_trabajo WHERE stock_minimo > 0 AND stock <= stock_minimo
       ORDER BY minimo, stock LIMIT 50`,
    ).all<Row>(),
    db.prepare("SELECT COUNT(*) AS n FROM quimicos WHERE fecha_caducidad < date('now')").first<Row>(),
  ]);
  const estacionesRes = await db.prepare(
    "SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END), 0) AS activas FROM estaciones",
  ).first<Row>();
  return c.json({
    generado: new Date().toISOString(),
    consumo: {
      hoy: { unidades: Number(hoy?.unidades ?? 0), movimientos: Number(hoy?.movimientos ?? 0) },
      semana: { unidades: Number(semana?.unidades ?? 0), movimientos: Number(semana?.movimientos ?? 0) },
      mes: { unidades: Number(mes?.unidades ?? 0), movimientos: Number(mes?.movimientos ?? 0) },
    },
    estaciones: { total: Number(estacionesRes?.total ?? 0), activas: Number(estacionesRes?.activas ?? 0) },
    por_dia: porDia.results,
    por_zona: porZona.results,
    sin_consumo: sinUso.results,
    stock_bajo: bajoMin.results,
    quimicos_vencidos: Number(vencidos?.n ?? 0),
  });
});
