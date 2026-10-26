import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";

type Row = Record<string, unknown>;
export const reportesRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
reportesRoutes.use("*", requireAuth);
reportesRoutes.get("/", async (c) => {
  const db = c.env.DB;
  const centroParam = c.req.query("centro_id");
  const centroId = centroParam && centroParam !== "all" ? Number(centroParam) : null;
  if (centroId !== null && (!Number.isInteger(centroId) || centroId < 1)) return c.json({ error: "centro_id no válido" }, 400);
  const where = centroId ? " WHERE centro_id = ?" : "";
  const bind = <T extends Row>(sql: string) => (centroId ? db.prepare(sql).bind(centroId).all<T>() : db.prepare(sql).all<T>());
  const centrosRes = await db.prepare("SELECT id, nombre FROM centros ORDER BY nombre").all<Row>();
  const quimicosRes = await bind<Row>(`SELECT q.id, q.codigo, q.marca, q.nombre, q.numero_lote, q.litros_por_garrafa, q.num_garrafas,
    q.litros_por_garrafa * q.num_garrafas AS total_litros, q.fecha_caducidad, q.stock_minimo, q.precio, q.origen, q.centro_id, c.nombre AS centro_nombre,
    CASE WHEN q.fecha_caducidad < date('now') THEN 'vencida' WHEN q.fecha_caducidad <= date('now', '+30 day') THEN '30'
    WHEN q.fecha_caducidad <= date('now', '+90 day') THEN '90' ELSE 'ok' END AS estado_caducidad
    FROM quimicos q LEFT JOIN centros c ON c.id = q.centro_id${where} ORDER BY (q.fecha_caducidad IS NULL), q.fecha_caducidad`);
  const materialRes = await bind<Row>(`SELECT m.id, m.codigo, m.marca, m.nombre, m.color, m.cantidad, m.stock_minimo, m.precio, m.origen, m.centro_id, c.nombre AS centro_nombre
    FROM material_limpieza m LEFT JOIN centros c ON c.id = m.centro_id${where} ORDER BY m.color, m.nombre`);
  const maquinariaRes = await bind<Row>(`SELECT m.id, m.nombre, m.tipo, m.cantidad, m.estado, m.numero_serie, m.centro_id, c.nombre AS centro_nombre
    FROM maquinaria m LEFT JOIN centros c ON c.id = m.centro_id${where} ORDER BY m.tipo, m.nombre`);
  const episRes = await bind<Row>(`SELECT e.id, e.codigo, e.marca, e.modelo, e.talla, e.descripcion, e.color, e.stock, e.stock_minimo, e.precio, e.fecha_revision, e.centro_id, c.nombre AS centro_nombre
    FROM epis e LEFT JOIN centros c ON c.id = e.centro_id${where} ORDER BY e.codigo`);
  const ropasRes = await bind<Row>(`SELECT r.id, r.codigo, r.prenda, r.marca, r.modelo, r.talla, r.color, r.stock, r.stock_minimo, r.precio, r.centro_id, c.nombre AS centro_nombre
    FROM ropa_trabajo r LEFT JOIN centros c ON c.id = r.centro_id${where} ORDER BY r.codigo`);
  const quimicos = quimicosRes.results, material = materialRes.results, maquinaria = maquinariaRes.results;
  const epis = episRes.results, ropas = ropasRes.results;
  const suma = (rows: Row[], key: string): number => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  const porColor = new Map<string, { color: string; unidades: number; registros: number }>();
  for (const r of material) { const color = String(r.color); const e = porColor.get(color) ?? { color, unidades: 0, registros: 0 }; e.unidades += Number(r.cantidad ?? 0); e.registros++; porColor.set(color, e); }
  const porTipo = new Map<string, { tipo: string; unidades: number; registros: number }>();
  for (const r of maquinaria) { const tipo = String(r.tipo); const e = porTipo.get(tipo) ?? { tipo, unidades: 0, registros: 0 }; e.unidades += Number(r.cantidad ?? 0); e.registros++; porTipo.set(tipo, e); }
  const estado = (r: Row): string => String(r.estado_caducidad);
  // Consumos de estaciones agrupados por ubicación (zona y subzona).
  const whereMov = centroId ? " AND e.centro_id = ?" : "";
  const bindMov = <T extends Row>(sql: string) => (centroId ? db.prepare(sql).bind(centroId).all<T>() : db.prepare(sql).all<T>());
  const porZonaRes = await bindMov<Row>(`SELECT COALESCE(c.nombre, '(sin centro)') AS centro, COALESCE(z.nombre, '(sin zona)') AS zona,
    COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades, MAX(m.created_at) AS ultimo
    FROM movimientos m JOIN estaciones e ON e.id = m.estacion_id
    LEFT JOIN zonas z ON z.id = e.zona_id LEFT JOIN centros c ON c.id = e.centro_id
    WHERE m.accion = 'consumo'${whereMov} GROUP BY centro, zona ORDER BY unidades DESC`);
  const porSubzonaRes = await bindMov<Row>(`SELECT COALESCE(z.nombre, '(sin zona)') AS zona, COALESCE(s.nombre, '(sin subzona)') AS subzona,
    COUNT(*) AS movimientos, COALESCE(SUM(m.cantidad), 0) AS unidades, MAX(m.created_at) AS ultimo
    FROM movimientos m JOIN estaciones e ON e.id = m.estacion_id
    LEFT JOIN zonas z ON z.id = e.zona_id LEFT JOIN subzonas s ON s.id = e.subzona_id
    WHERE m.accion = 'consumo'${whereMov} GROUP BY zona, subzona ORDER BY unidades DESC`);
  // Entregas de equipación agrupadas por operario (bloque de Informes).
  const entregasRes = await bind<Row>(`SELECT u.id AS operario_id, u.nombre AS operario, u.username,
    COUNT(*) AS entregas, COALESCE(SUM(re.cantidad), 0) AS unidades, MAX(re.fecha) AS ultima
    FROM ropa_entregas re JOIN usuarios u ON u.id = re.usuario_id
    ${centroId ? "WHERE re.centro_id = ?" : ""}
    GROUP BY u.id, u.nombre, u.username ORDER BY unidades DESC, operario`);
  // ---- Datos del dashboard (pestaña «Dashboard» de Gestión de informes) ----
  // Inventario por planta: comparativa global entre centros; el filtro de la
  // cabecera no la altera porque su propósito es comparar plantas entre sí.
  const porCentroRes = await db.prepare(`SELECT c.id, c.nombre,
    (SELECT COUNT(*) FROM quimicos q WHERE q.centro_id = c.id) AS quimicos_registros,
    (SELECT COALESCE(SUM(q.num_garrafas), 0) FROM quimicos q WHERE q.centro_id = c.id) AS quimicos_garrafas,
    (SELECT COALESCE(SUM(q.litros_por_garrafa * q.num_garrafas), 0) FROM quimicos q WHERE q.centro_id = c.id) AS quimicos_litros,
    (SELECT COUNT(*) FROM material_limpieza m WHERE m.centro_id = c.id) AS material_registros,
    (SELECT COALESCE(SUM(m.cantidad), 0) FROM material_limpieza m WHERE m.centro_id = c.id) AS material_unidades,
    (SELECT COUNT(*) FROM maquinaria m WHERE m.centro_id = c.id) AS maquinaria_registros,
    (SELECT COALESCE(SUM(m.cantidad), 0) FROM maquinaria m WHERE m.centro_id = c.id) AS maquinaria_unidades,
    (SELECT COUNT(*) FROM epis e WHERE e.centro_id = c.id) AS epis_registros,
    (SELECT COALESCE(SUM(e.stock), 0) FROM epis e WHERE e.centro_id = c.id) AS epis_unidades,
    (SELECT COUNT(*) FROM ropa_trabajo r WHERE r.centro_id = c.id) AS ropa_registros,
    (SELECT COALESCE(SUM(r.stock), 0) FROM ropa_trabajo r WHERE r.centro_id = c.id) AS ropa_unidades,
    (SELECT COUNT(*) FROM estaciones e WHERE e.centro_id = c.id AND e.activo = 1) AS estaciones_activas,
    (SELECT COUNT(*) FROM quimicos q WHERE q.centro_id = c.id AND q.fecha_caducidad < date('now')) AS caducadas,
    (SELECT COUNT(*) FROM quimicos q WHERE q.centro_id = c.id AND q.stock_minimo > 0 AND q.num_garrafas <= q.stock_minimo)
      + (SELECT COUNT(*) FROM material_limpieza m WHERE m.centro_id = c.id AND m.stock_minimo > 0 AND m.cantidad <= m.stock_minimo)
      + (SELECT COUNT(*) FROM epis e WHERE e.centro_id = c.id AND e.stock_minimo > 0 AND e.stock <= e.stock_minimo)
      + (SELECT COUNT(*) FROM ropa_trabajo r WHERE r.centro_id = c.id AND r.stock_minimo > 0 AND r.stock <= r.stock_minimo) AS stock_bajo,
    (SELECT COALESCE(SUM(m.cantidad), 0) FROM movimientos m JOIN estaciones e ON e.id = m.estacion_id
      WHERE m.accion = 'consumo' AND e.centro_id = c.id AND m.created_at >= datetime('now', '-30 days')) AS consumo_30d
    FROM centros c ORDER BY c.nombre`).all<Row>();
  // Origen de los consumibles (fábrica / empresa) en el alcance filtrado.
  const origenQRes = await bind<Row>(`SELECT COALESCE(NULLIF(TRIM(origen), ''), 'fabrica') AS origen, COUNT(*) AS registros,
    COALESCE(SUM(num_garrafas), 0) AS garrafas, COALESCE(SUM(litros_por_garrafa * num_garrafas), 0) AS litros
    FROM quimicos${where} GROUP BY origen`);
  const origenMRes = await bind<Row>(`SELECT COALESCE(NULLIF(TRIM(origen), ''), 'fabrica') AS origen, COUNT(*) AS registros,
    COALESCE(SUM(cantidad), 0) AS unidades FROM material_limpieza${where} GROUP BY origen`);
  const porOrigen = new Map<string, Row>();
  for (const o of ["fabrica", "empresa"]) porOrigen.set(o, {
    origen: o, quimicos_registros: 0, quimicos_garrafas: 0, quimicos_litros: 0, material_registros: 0, material_unidades: 0,
  });
  for (const r of origenQRes.results) porOrigen.set(String(r.origen), {
    ...(porOrigen.get(String(r.origen)) ?? {}), origen: r.origen, quimicos_registros: r.registros,
    quimicos_garrafas: r.garrafas, quimicos_litros: Number(Number(r.litros).toFixed(2)),
  });
  for (const r of origenMRes.results) porOrigen.set(String(r.origen), {
    ...(porOrigen.get(String(r.origen)) ?? {}), origen: r.origen, material_registros: r.registros, material_unidades: r.unidades,
  });
  // Consumo diario de los últimos 30 días (gráfico de líneas/barras del dashboard).
  const consumoDiaRes = await bindMov<Row>(`SELECT date(m.created_at) AS fecha, COALESCE(SUM(m.cantidad), 0) AS unidades, COUNT(*) AS movimientos
    FROM movimientos m JOIN estaciones e ON e.id = m.estacion_id
    WHERE m.accion = 'consumo' AND m.created_at >= datetime('now', '-30 days')${whereMov}
    GROUP BY fecha ORDER BY fecha`);
  // Actividad de los últimos 30 días por tipo de movimiento (alcance global).
  const actividadRes = await db.prepare(`SELECT accion, COUNT(*) AS registros FROM movimientos
    WHERE created_at >= datetime('now', '-30 days') GROUP BY accion ORDER BY registros DESC`).all<Row>();
  // Cifras globales del centro de mando (usuarios, estaciones, documentación…).
  const globalesRes = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM usuarios WHERE activo = 1) AS usuarios,
    (SELECT COUNT(*) FROM centros) AS centros,
    (SELECT COUNT(*) FROM zonas) AS zonas,
    (SELECT COUNT(*) FROM estaciones) AS estaciones,
    (SELECT COUNT(*) FROM estaciones WHERE activo = 1) AS estaciones_activas,
    (SELECT COUNT(*) FROM documentos) AS documentos,
    (SELECT COUNT(*) FROM ropa_entregas) AS entregas,
    (SELECT COUNT(*) FROM maquinaria WHERE estado NOT IN ('Operativo', 'Operativa', 'Baja')) AS maquinas_paradas`).first<Row>();
  // Solo cantidades: los costes se han eliminado de los consumibles.
  const bajoDe = (rows: Row[], key: string): number => rows.filter((r) => Number(r.stock_minimo ?? 0) > 0 && Number(r[key] ?? 0) <= Number(r.stock_minimo)).length;
  const sQ = bajoDe(quimicos, "num_garrafas"), sM = bajoDe(material, "cantidad");
  const sE = bajoDe(epis, "stock"), sR = bajoDe(ropas, "stock");
  const stockBajo = { quimicos: sQ, material: sM, epis: sE, ropa: sR, total: sQ + sM + sE + sR };
  return c.json({
    generado: new Date().toISOString(),
    centro: centroId ? centrosRes.results.find((x) => Number(x.id) === centroId) ?? null : null,
    centros: centrosRes.results,
    resumen: {
      quimicos: { registros: quimicos.length, garrafas: suma(quimicos, "num_garrafas"), litros: Number(suma(quimicos, "total_litros").toFixed(2)) },
      material: { registros: material.length, unidades: suma(material, "cantidad") },
      maquinaria: { registros: maquinaria.length, unidades: suma(maquinaria, "cantidad") },
      epis: { registros: epis.length, unidades: suma(epis, "stock") },
      ropa: { registros: ropas.length, unidades: suma(ropas, "stock") },
    },
    stock_bajo: stockBajo,
    caducidad: { vencidas: quimicos.filter((r) => estado(r) === "vencida").length, en30: quimicos.filter((r) => estado(r) === "30").length, en90: quimicos.filter((r) => estado(r) === "90").length },
    quimicos, material, maquinaria, epis, ropas,
    por_color: [...porColor.values()].sort((a, b) => b.unidades - a.unidades),
    por_tipo: [...porTipo.values()].sort((a, b) => b.unidades - a.unidades),
    consumos_por_zona: porZonaRes.results,
    consumos_por_subzona: porSubzonaRes.results,
    entregas_por_operario: entregasRes.results,
    por_centro: porCentroRes.results,
    por_origen: [...porOrigen.values()],
    consumo_por_dia: consumoDiaRes.results,
    actividad: actividadRes.results,
    globales: globalesRes ?? {},
  });
});
