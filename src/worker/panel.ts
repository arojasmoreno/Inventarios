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
      `SELECT * FROM (
        SELECT MAX(nombre) AS nombre, SUM(litros_por_garrafa * num_garrafas) AS stock,
               COALESCE(MAX(CASE WHEN TRIM(COALESCE(numero_lote, '')) = '' THEN stock_minimo END), MAX(stock_minimo)) AS minimo,
               MAX(codigo) AS codigo, 'Químicos' AS categoria, 'quimicos' AS seccion
        FROM quimicos GROUP BY LOWER(TRIM(nombre)), LOWER(TRIM(COALESCE(marca, '')))
      ) WHERE minimo > 0 AND stock <= minimo
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
  // Tarjetas de alerta: máquinas fuera de servicio, revisiones de EPI
  // próximas/vencidas y químicos caducando en los próximos 30 días.
  const [maqNoOperativas, revisionesEpi, caducan30] = await Promise.all([
    db.prepare(
      `SELECT m.id, m.nombre, m.tipo, m.estado, m.numero_serie, c.nombre AS centro_nombre
       FROM maquinaria m LEFT JOIN centros c ON c.id = m.centro_id
       WHERE m.estado NOT IN ('Operativo', 'Operativa', 'Baja') ORDER BY m.estado, m.nombre LIMIT 20`,
    ).all<Row>(),
    db.prepare(
      `SELECT e.id, COALESCE(NULLIF(e.descripcion, ''), e.codigo) AS nombre, e.fecha_revision, c.nombre AS centro_nombre,
              CAST(julianday(e.fecha_revision) - julianday('now') AS INTEGER) AS dias
       FROM epis e LEFT JOIN centros c ON c.id = e.centro_id
       WHERE e.fecha_revision IS NOT NULL AND e.fecha_revision <= date('now', '+30 day')
       ORDER BY e.fecha_revision LIMIT 20`,
    ).all<Row>(),
    db.prepare("SELECT COUNT(*) AS n FROM quimicos WHERE fecha_caducidad <= date('now', '+30 day')").first<Row>(),
  ]);
  // Formaciones, carnets y revisiones del personal que caducan en 30 días o ya
  // han vencido (solo la titulación más reciente de cada operario).
  const formacionesProximas = await db.prepare(
    `SELECT of.id, u.nombre AS usuario, f.nombre AS formacion, f.tipo, of.caducidad,
            c.nombre AS centro_nombre,
            CAST(julianday(of.caducidad) - julianday('now') AS INTEGER) AS dias
     FROM operario_formaciones of
     JOIN usuarios u ON u.id = of.usuario_id
     JOIN formaciones f ON f.id = of.formacion_id
     LEFT JOIN centros c ON c.id = of.centro_id
     WHERE of.caducidad IS NOT NULL AND of.caducidad <= date('now', '+30 day') AND u.activo = 1
       AND NOT EXISTS (
         SELECT 1 FROM operario_formaciones o2
         WHERE o2.usuario_id = of.usuario_id AND o2.formacion_id = of.formacion_id AND o2.fecha > of.fecha)
     ORDER BY of.caducidad LIMIT 20`,
  ).all<Row>();
  // KPI operativos: pedidos, trabajos, errores y valor del almacén.
  const [pedidosRes, trabajosRes, erroresRes, valorRes, consumo90] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN estado <> 'aplicado' THEN 1 ELSE 0 END), 0) AS pendientes,
        COALESCE(SUM(CASE WHEN estado IN ('enviado', 'recibido') AND fecha_prevista IS NOT NULL
          AND date(fecha_prevista) < date('now') THEN 1 ELSE 0 END), 0) AS retrasados
       FROM pedidos`,
    ).first<Row>(),
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN estado <> 'cerrado' THEN 1 ELSE 0 END), 0) AS abiertos,
        COALESCE(SUM(CASE WHEN estado = 'en_curso' THEN 1 ELSE 0 END), 0) AS en_curso,
        COALESCE(SUM(CASE WHEN estado <> 'cerrado' AND fecha_prevista IS NOT NULL
          AND date(fecha_prevista) < date('now') THEN 1 ELSE 0 END), 0) AS vencidos
       FROM trabajos`,
    ).first<Row>(),
    db.prepare("SELECT COUNT(*) AS n FROM errores WHERE fecha >= datetime('now', '-1 day')").first<Row>(),
    db.prepare(
      `SELECT
        (SELECT COALESCE(SUM(num_garrafas * COALESCE(precio, 0)), 0) FROM quimicos) AS quimicos,
        (SELECT COALESCE(SUM(cantidad * COALESCE(precio, 0)), 0) FROM material_limpieza) AS material,
        (SELECT COALESCE(SUM(stock * COALESCE(precio, 0)), 0) FROM epis) AS epis,
        (SELECT COALESCE(SUM(stock * COALESCE(precio, 0)), 0) FROM ropa_trabajo) AS ropa,
        (SELECT COALESCE(SUM(num_garrafas), 0) FROM quimicos) +
        (SELECT COALESCE(SUM(cantidad), 0) FROM material_limpieza) +
        (SELECT COALESCE(SUM(stock), 0) FROM epis) +
        (SELECT COALESCE(SUM(stock), 0) FROM ropa_trabajo) AS uds`,
    ).first<Row>(),
    db.prepare(
      "SELECT COALESCE(SUM(cantidad), 0) AS n FROM movimientos WHERE accion IN ('consumo', 'salida') AND created_at >= datetime('now', '-90 days')",
    ).first<Row>(),
  ]);
  const valor = {
    quimicos: Number(valorRes?.quimicos ?? 0), material: Number(valorRes?.material ?? 0),
    epis: Number(valorRes?.epis ?? 0), ropa: Number(valorRes?.ropa ?? 0),
  };
  const valorTotal = valor.quimicos + valor.material + valor.epis + valor.ropa;
  return c.json({
    generado: new Date().toISOString(),
    formaciones_proximas: formacionesProximas.results,
    pedidos: {
      total: Number(pedidosRes?.total ?? 0), pendientes: Number(pedidosRes?.pendientes ?? 0),
      retrasados: Number(pedidosRes?.retrasados ?? 0),
    },
    trabajos: {
      abiertos: Number(trabajosRes?.abiertos ?? 0), en_curso: Number(trabajosRes?.en_curso ?? 0),
      vencidos: Number(trabajosRes?.vencidos ?? 0),
    },
    errores_24h: Number(erroresRes?.n ?? 0),
    valor_stock: { ...valor, total: valorTotal },
    rotacion_90d: {
      unidades: Number(consumo90?.n ?? 0),
      stock: Number(valorRes?.uds ?? 0),
      indice: Number(valorRes?.uds ?? 0) > 0
        ? Number((Number(consumo90?.n ?? 0) / Number(valorRes?.uds)).toFixed(2)) : 0,
    },
    formaciones_caducan30: formacionesProximas.results.length,
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
    maquinas_no_operativas: maqNoOperativas.results,
    revisiones_epis: revisionesEpi.results,
    quimicos_caducan30: Number(caducan30?.n ?? 0),
  });
});
