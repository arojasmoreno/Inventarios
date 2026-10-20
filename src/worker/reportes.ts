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
    q.litros_por_garrafa * q.num_garrafas AS total_litros, q.fecha_caducidad, q.stock_minimo, q.centro_id, c.nombre AS centro_nombre,
    CASE WHEN q.fecha_caducidad < date('now') THEN 'vencida' WHEN q.fecha_caducidad <= date('now', '+30 day') THEN '30'
    WHEN q.fecha_caducidad <= date('now', '+90 day') THEN '90' ELSE 'ok' END AS estado_caducidad
    FROM quimicos q LEFT JOIN centros c ON c.id = q.centro_id${where} ORDER BY q.fecha_caducidad`);
  const materialRes = await bind<Row>(`SELECT m.id, m.codigo, m.marca, m.nombre, m.color, m.cantidad, m.stock_minimo, m.centro_id, c.nombre AS centro_nombre
    FROM material_limpieza m LEFT JOIN centros c ON c.id = m.centro_id${where} ORDER BY m.color, m.nombre`);
  const maquinariaRes = await bind<Row>(`SELECT m.id, m.nombre, m.tipo, m.cantidad, m.estado, m.numero_serie, m.centro_id, c.nombre AS centro_nombre
    FROM maquinaria m LEFT JOIN centros c ON c.id = m.centro_id${where} ORDER BY m.tipo, m.nombre`);
  const episRes = await bind<Row>(`SELECT e.id, e.codigo, e.marca, e.modelo, e.talla, e.descripcion, e.color, e.stock, e.stock_minimo, e.fecha_revision, e.centro_id, c.nombre AS centro_nombre
    FROM epis e LEFT JOIN centros c ON c.id = e.centro_id${where} ORDER BY e.codigo`);
  const ropasRes = await bind<Row>(`SELECT r.id, r.codigo, r.prenda, r.marca, r.modelo, r.talla, r.color, r.stock, r.stock_minimo, r.centro_id, c.nombre AS centro_nombre
    FROM ropa_trabajo r LEFT JOIN centros c ON c.id = r.centro_id${where} ORDER BY r.codigo`);
  const quimicos = quimicosRes.results, material = materialRes.results, maquinaria = maquinariaRes.results;
  const epis = episRes.results, ropas = ropasRes.results;
  const suma = (rows: Row[], key: string): number => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
  const porColor = new Map<string, { color: string; unidades: number; registros: number }>();
  for (const r of material) { const color = String(r.color); const e = porColor.get(color) ?? { color, unidades: 0, registros: 0 }; e.unidades += Number(r.cantidad ?? 0); e.registros++; porColor.set(color, e); }
  const porTipo = new Map<string, { tipo: string; unidades: number; registros: number }>();
  for (const r of maquinaria) { const tipo = String(r.tipo); const e = porTipo.get(tipo) ?? { tipo, unidades: 0, registros: 0 }; e.unidades += Number(r.cantidad ?? 0); e.registros++; porTipo.set(tipo, e); }
  const estado = (r: Row): string => String(r.estado_caducidad);
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
  });
});
