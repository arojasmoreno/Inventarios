import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { centrosPermitidos, marcas } from "./alcance";

type Row = Record<string, unknown>;

// Panel de control: resumen operativo del día a día (consumos recientes,
// estaciones sin uso, artículos por debajo del stock mínimo y consumo por zona).
// Todo se limita a los centros asignados al usuario; el administrador ve la
// instalación completa.
export const panelRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
panelRoutes.use("*", requireAuth);

function panelVacio() {
  return {
    generado: new Date().toISOString(),
    forma_parte_sin_centros: true,
    formaciones_proximas: [],
    pedidos: { total: 0, pendientes: 0, retrasados: 0 },
    trabajos: { abiertos: 0, en_curso: 0, vencidos: 0 },
    errores_24h: 0,
    valor_stock: { quimicos: 0, material: 0, epis: 0, ropa: 0, total: 0 },
    rotacion_90d: { unidades: 0, stock: 0, indice: 0 },
    formaciones_caducan30: 0,
    consumo: {
      hoy: { unidades: 0, movimientos: 0 },
      semana: { unidades: 0, movimientos: 0 },
      mes: { unidades: 0, movimientos: 0 },
    },
    estaciones: { total: 0, activas: 0 },
    por_dia: [],
    por_zona: [],
    sin_consumo: [],
    stock_bajo: [],
    quimicos_vencidos: 0,
    maquinas_no_operativas: [],
    revisiones_epis: [],
    quimicos_caducan30: 0,
    reposicion: [],
  };
}

panelRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const user = c.get("user");
  const centros = await centrosPermitidos(db, user);
  // Usuario sin centros asignados: no hay nada que mostrar (y nada que filtrar).
  if (centros && centros.length === 0) return c.json(panelVacio());
  const ph = centros ? marcas(centros.length) : "";
  const cb = centros ?? [];
  // Consumos: se filtran por el centro de la estación donde se registraron.
  const porEstacion = centros
    ? ` AND EXISTS (SELECT 1 FROM estaciones sx WHERE sx.id = m.estacion_id AND sx.centro_id IN (${ph}))`
    : "";
  const porCentro = (columna: string) => (centros ? ` AND ${columna} IN (${ph})` : "");
  const rep = (veces: number) => (centros ? new Array(veces).fill(0).flatMap(() => cb) : []);

  const [hoy, semana, mes, porDia, porZona, sinUso, bajoMin, vencidos] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades FROM movimientos m
       WHERE m.accion = 'consumo' AND date(m.created_at) = date('now')${porEstacion}`,
    ).bind(...cb).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades FROM movimientos m
       WHERE m.accion = 'consumo' AND m.created_at >= datetime('now', '-7 days')${porEstacion}`,
    ).bind(...cb).first<Row>(),
    db.prepare(
      `SELECT COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades FROM movimientos m
       WHERE m.accion = 'consumo' AND m.created_at >= datetime('now', '-30 days')${porEstacion}`,
    ).bind(...cb).first<Row>(),
    // Consumo por día de los últimos 14 días (para el gráfico del panel).
    db.prepare(
      `SELECT date(m.created_at) AS fecha, COALESCE(SUM(m.cantidad), 0) AS unidades, COUNT(*) AS movimientos
       FROM movimientos m WHERE m.accion = 'consumo' AND date(m.created_at) >= date('now', '-13 day')${porEstacion}
       GROUP BY fecha ORDER BY fecha`,
    ).bind(...cb).all<Row>(),
    // Consumo por zona de los últimos 30 días (enlaza con el listado de estaciones).
    db.prepare(
      `SELECT z.id AS zona_id, COALESCE(z.nombre, '(sin zona)') AS zona, COALESCE(c.nombre, '(sin centro)') AS centro,
              COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades, MAX(m.created_at) AS ultimo
       FROM movimientos m
       JOIN estaciones e ON e.id = m.estacion_id
       LEFT JOIN zonas z ON z.id = e.zona_id
       LEFT JOIN centros c ON c.id = e.centro_id
       WHERE m.accion = 'consumo' AND m.created_at >= datetime('now', '-30 days')${porCentro("e.centro_id")}
       GROUP BY z.id, zona, centro ORDER BY unidades DESC LIMIT 20`,
    ).bind(...cb).all<Row>(),
    // Estaciones activas sin ningún consumo en los últimos 30 días.
    db.prepare(
      `SELECT e.id, z.nombre AS zona_nombre, s.nombre AS subzona_nombre, sp.nombre AS soporte_nombre,
              COALESCE(ct.nombre, '') AS tipo_nombre
       FROM estaciones e
       LEFT JOIN zonas z ON z.id = e.zona_id
       LEFT JOIN subzonas s ON s.id = e.subzona_id
       LEFT JOIN soportes sp ON sp.id = e.soporte_id
       LEFT JOIN consumibles_tipos ct ON ct.id = e.tipo_consumible_id
       WHERE e.activo = 1${porCentro("e.centro_id")} AND NOT EXISTS (
         SELECT 1 FROM movimientos m WHERE m.estacion_id = e.id AND m.accion = 'consumo'
           AND m.created_at >= datetime('now', '-30 days'))
       ORDER BY z.nombre, s.nombre LIMIT 30`,
    ).bind(...cb).all<Row>(),
    // Artículos con stock por debajo del mínimo (maquinaria no tiene mínimo).
    // Se incluye cuánto falta para poder reponer sin hacer cuentas.
    db.prepare(
      `SELECT nombre, stock, minimo,
              CASE WHEN minimo > stock THEN minimo - stock ELSE 0 END AS faltante,
              codigo, categoria, seccion
       FROM (
         SELECT MAX(nombre) AS nombre, SUM(litros_por_garrafa * num_garrafas) AS stock,
                COALESCE(MAX(CASE WHEN TRIM(COALESCE(numero_lote, '')) = '' THEN stock_minimo END), MAX(stock_minimo)) AS minimo,
                MAX(codigo) AS codigo, 'Químicos' AS categoria, 'quimicos' AS seccion
         FROM quimicos WHERE 1 = 1${porCentro("centro_id")}
         GROUP BY LOWER(TRIM(nombre)), LOWER(TRIM(COALESCE(marca, '')))
         UNION ALL SELECT nombre, cantidad, stock_minimo, codigo, 'Material de limpieza', 'material'
           FROM material_limpieza WHERE 1 = 1${porCentro("centro_id")}
         UNION ALL SELECT COALESCE(NULLIF(descripcion, ''), codigo), stock, stock_minimo, codigo, 'EPIs', 'epis'
           FROM epis WHERE 1 = 1${porCentro("centro_id")}
         UNION ALL SELECT prenda, stock, stock_minimo, codigo, 'Ropa de trabajo', 'ropa'
           FROM ropa_trabajo WHERE 1 = 1${porCentro("centro_id")}
       ) WHERE minimo > 0 AND stock <= minimo
       ORDER BY minimo, stock LIMIT 50`,
    ).bind(...rep(4)).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM quimicos WHERE fecha_caducidad < date('now')${porCentro("centro_id")}`)
      .bind(...cb).first<Row>(),
  ]);
  const estacionesRes = await db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN activo = 1 THEN 1 ELSE 0 END), 0) AS activas
     FROM estaciones WHERE 1 = 1${porCentro("centro_id")}`,
  ).bind(...cb).first<Row>();
  // Tarjetas de alerta: máquinas fuera de servicio, revisiones de EPI
  // próximas/vencidas y químicos caducando en los próximos 30 días.
  const [maqNoOperativas, revisionesEpi, caducan30] = await Promise.all([
    db.prepare(
      `SELECT m.id, m.nombre, m.tipo, m.estado, m.numero_serie, c.nombre AS centro_nombre
       FROM maquinaria m LEFT JOIN centros c ON c.id = m.centro_id
       WHERE m.estado NOT IN ('Operativo', 'Operativa', 'Baja')${porCentro("m.centro_id")}
       ORDER BY m.estado, m.nombre LIMIT 20`,
    ).bind(...cb).all<Row>(),
    db.prepare(
      `SELECT e.id, COALESCE(NULLIF(e.descripcion, ''), e.codigo) AS nombre, e.fecha_revision, c.nombre AS centro_nombre,
              CAST(julianday(e.fecha_revision) - julianday('now') AS INTEGER) AS dias
       FROM epis e LEFT JOIN centros c ON c.id = e.centro_id
       WHERE e.fecha_revision IS NOT NULL AND e.fecha_revision <= date('now', '+30 day')${porCentro("e.centro_id")}
       ORDER BY e.fecha_revision LIMIT 20`,
    ).bind(...cb).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n FROM quimicos WHERE fecha_caducidad <= date('now', '+30 day')${porCentro("centro_id")}`)
      .bind(...cb).first<Row>(),
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
       ${centros ? `AND of.centro_id IN (${ph})` : ""}
       AND NOT EXISTS (
         SELECT 1 FROM operario_formaciones o2
         WHERE o2.usuario_id = of.usuario_id AND o2.formacion_id = of.formacion_id AND o2.fecha > of.fecha)
     ORDER BY of.caducidad LIMIT 20`,
  ).bind(...cb).all<Row>();
  // KPI operativos: pedidos, trabajos, errores y valor del almacén.
  const [pedidosRes, trabajosRes, erroresRes, valorRes, consumo90] = await Promise.all([
    db.prepare(
      `SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN estado <> 'aplicado' THEN 1 ELSE 0 END), 0) AS pendientes,
        COALESCE(SUM(CASE WHEN estado IN ('enviado', 'recibido') AND fecha_prevista IS NOT NULL
          AND date(fecha_prevista) < date('now') THEN 1 ELSE 0 END), 0) AS retrasados
       FROM pedidos WHERE 1 = 1${porCentro("centro_id")}`,
    ).bind(...cb).first<Row>(),
    db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN estado <> 'cerrado' THEN 1 ELSE 0 END), 0) AS abiertos,
        COALESCE(SUM(CASE WHEN estado = 'en_curso' THEN 1 ELSE 0 END), 0) AS en_curso,
        COALESCE(SUM(CASE WHEN estado <> 'cerrado' AND fecha_prevista IS NOT NULL
          AND date(fecha_prevista) < date('now') THEN 1 ELSE 0 END), 0) AS vencidos
       FROM trabajos WHERE 1 = 1${porCentro("centro_id")}`,
    ).bind(...cb).first<Row>(),
    db.prepare("SELECT COUNT(*) AS n FROM errores WHERE fecha >= datetime('now', '-1 day')").first<Row>(),
    db.prepare(
      `SELECT
        (SELECT COALESCE(SUM(num_garrafas * COALESCE(precio, 0)), 0) FROM quimicos WHERE 1 = 1${porCentro("centro_id")}) AS quimicos,
        (SELECT COALESCE(SUM(cantidad * COALESCE(precio, 0)), 0) FROM material_limpieza WHERE 1 = 1${porCentro("centro_id")}) AS material,
        (SELECT COALESCE(SUM(stock * COALESCE(precio, 0)), 0) FROM epis WHERE 1 = 1${porCentro("centro_id")}) AS epis,
        (SELECT COALESCE(SUM(stock * COALESCE(precio, 0)), 0) FROM ropa_trabajo WHERE 1 = 1${porCentro("centro_id")}) AS ropa,
        (SELECT COALESCE(SUM(num_garrafas), 0) FROM quimicos WHERE 1 = 1${porCentro("centro_id")}) +
        (SELECT COALESCE(SUM(cantidad), 0) FROM material_limpieza WHERE 1 = 1${porCentro("centro_id")}) +
        (SELECT COALESCE(SUM(stock), 0) FROM epis WHERE 1 = 1${porCentro("centro_id")}) +
        (SELECT COALESCE(SUM(stock), 0) FROM ropa_trabajo WHERE 1 = 1${porCentro("centro_id")}) AS uds`,
    ).bind(...rep(8)).first<Row>(),
    db.prepare(
      `SELECT COALESCE(SUM(m.cantidad), 0) AS n FROM movimientos m
       WHERE m.accion IN ('consumo', 'salida') AND m.created_at >= datetime('now', '-90 days')${porEstacion}`,
    ).bind(...cb).first<Row>(),
  ]);
  const valor = {
    quimicos: Number(valorRes?.quimicos ?? 0), material: Number(valorRes?.material ?? 0),
    epis: Number(valorRes?.epis ?? 0), ropa: Number(valorRes?.ropa ?? 0),
  };
  const valorTotal = valor.quimicos + valor.material + valor.epis + valor.ropa;
  const stockBajo = bajoMin.results;
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
    // El histórico de errores es solo para administradores.
    errores_24h: centros ? 0 : Number(erroresRes?.n ?? 0),
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
    stock_bajo: stockBajo,
    // Lista de reposición: solo los artículos por debajo del mínimo, con lo que falta.
    reposicion: stockBajo
      .filter((s) => Number(s.faltante ?? 0) > 0)
      .map((s) => ({
        categoria: String(s.categoria ?? ""), seccion: String(s.seccion ?? ""),
        nombre: String(s.nombre ?? ""), codigo: s.codigo == null ? null : String(s.codigo),
        stock: Number(s.stock ?? 0), minimo: Number(s.minimo ?? 0), faltante: Number(s.faltante ?? 0),
      })),
    quimicos_vencidos: Number(vencidos?.n ?? 0),
    maquinas_no_operativas: maqNoOperativas.results,
    revisiones_epis: revisionesEpi.results,
    quimicos_caducan30: Number(caducan30?.n ?? 0),
  });
});
