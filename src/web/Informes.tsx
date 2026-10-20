import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ColorSwatch, downloadCsv, formatFecha, formatNum } from "./ui";

type Row = Record<string, unknown>;
interface Informe {
  generado: string;
  centro: { id: number; nombre: string } | null;
  centros: { id: number; nombre: string }[];
  resumen: {
    quimicos: { registros: number; garrafas: number; litros: number };
    material: { registros: number; unidades: number };
    maquinaria: { registros: number; unidades: number };
    epis: { registros: number; unidades: number };
    ropa: { registros: number; unidades: number };
  };
  valor: { quimicos: number; material: number; epis: number; ropa: number; total: number };
  stock_bajo: { quimicos: number; material: number; epis: number; ropa: number; total: number };
  caducidad: { vencidas: number; en30: number; en90: number };
  quimicos: Row[]; material: Row[]; maquinaria: Row[]; epis: Row[]; ropas: Row[];
  por_color: { color: string; unidades: number; registros: number }[];
  por_tipo: { tipo: string; unidades: number; registros: number }[];
}
function estadoCaducidad(row: Row): { label: string; kind: string } {
  const e = String(row.estado_caducidad ?? "ok");
  if (e === "vencida") return { label: "Vencida", kind: "danger" };
  if (e === "30") return { label: "≤ 30 días", kind: "warn" };
  if (e === "90") return { label: "≤ 90 días", kind: "info" };
  return { label: "En vigor", kind: "ok" };
}
// Celda de stock con aviso cuando queda en el mínimo o por debajo.
function stockAlerta(row: Row, key: string) {
  const n = Number(row[key] ?? 0), min = Number(row.stock_minimo ?? 0);
  return <>{formatNum(n)}{min > 0 && n <= min ? <> <span className="badge danger">⚠️ mín. {min}</span></> : null}</>;
}

export function Informes() {
  const [centroId, setCentroId] = useState("all"), [data, setData] = useState<Informe | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api.get<Informe>(`/api/informes?centro_id=${encodeURIComponent(centroId)}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "Error generando el informe"); }
    finally { setLoading(false); }
  }, [centroId]);
  useEffect(() => { void load(); }, [load]);
  if (loading) return <div className="loading">Generando informe…</div>;
  if (error || !data) return <div className="card empty"><span className="icon">⚠️</span>{error ?? "No hay datos"}</div>;
  const r = data.resumen, stamp = new Date().toISOString().slice(0, 10), alcance = data.centro ? data.centro.nombre : "todos los centros";
  const csvQuimicos = () => downloadCsv(`informe-quimicos-${stamp}.csv`,
    ["Código", "Marca", "Producto", "Lote", "L/garrafa", "Garrafas", "Total litros", "Coste/ud. (€)", "Valor (€)", "Caducidad", "Estado", "Centro"],
    data.quimicos.map(q => [String(q.codigo ?? ""), String(q.marca ?? ""), String(q.nombre ?? ""), String(q.numero_lote ?? ""), formatNum(q.litros_por_garrafa, 2), formatNum(q.num_garrafas), formatNum(q.total_litros, 2), formatNum(q.coste_unitario ?? "", 2), formatNum((Number(q.coste_unitario ?? 0) || 0) * Number(q.num_garrafas ?? 0), 2), formatFecha(q.fecha_caducidad), estadoCaducidad(q).label, String(q.centro_nombre ?? "—")]));
  const csvMaterial = () => downloadCsv(`informe-material-${stamp}.csv`,
    ["Código", "Marca", "Material", "Color", "Unidades", "Coste/ud. (€)", "Valor (€)", "Centro"],
    data.material.map(m => [String(m.codigo ?? ""), String(m.marca ?? ""), String(m.nombre ?? ""), String(m.color ?? ""), formatNum(m.cantidad), formatNum(m.coste_unitario ?? "", 2), formatNum((Number(m.coste_unitario ?? 0) || 0) * Number(m.cantidad ?? 0), 2), String(m.centro_nombre ?? "—")]));
  const csvMaquinaria = () => downloadCsv(`informe-maquinaria-${stamp}.csv`,
    ["Máquina", "Tipo", "Unidades", "Nº serie", "Estado", "Centro"],
    data.maquinaria.map(m => [String(m.nombre ?? ""), String(m.tipo ?? ""), formatNum(m.cantidad), String(m.numero_serie ?? "—"), String(m.estado ?? ""), String(m.centro_nombre ?? "—")]));
  const csvEpis = () => downloadCsv(`informe-epis-${stamp}.csv`,
    ["Código", "Marca", "Modelo", "Talla", "Descripción", "Stock", "Coste/ud. (€)", "Valor (€)", "Próxima revisión", "Centro"],
    data.epis.map(e => [String(e.codigo ?? ""), String(e.marca ?? ""), String(e.modelo ?? ""), String(e.talla ?? ""), String(e.descripcion ?? ""), formatNum(e.stock), formatNum(e.coste_unitario ?? "", 2), formatNum((Number(e.coste_unitario ?? 0) || 0) * Number(e.stock ?? 0), 2), formatFecha(e.fecha_revision), String(e.centro_nombre ?? "—")]));
  const csvRopa = () => downloadCsv(`informe-ropa-${stamp}.csv`,
    ["Código", "Prenda", "Marca", "Modelo", "Talla", "Stock", "Coste/ud. (€)", "Valor (€)", "Centro"],
    data.ropas.map(p => [String(p.codigo ?? ""), String(p.prenda ?? ""), String(p.marca ?? ""), String(p.modelo ?? ""), String(p.talla ?? ""), formatNum(p.stock), formatNum(p.coste_unitario ?? "", 2), formatNum((Number(p.coste_unitario ?? 0) || 0) * Number(p.stock ?? 0), 2), String(p.centro_nombre ?? "—")]));
  const kpiValor = `${formatNum(data.valor.total, 2)} €`;
  return <>
    <div className="toolbar no-print">
      <label htmlFor="centro-informe" style={{ fontWeight: 600 }}>Centro / planta:</label>
      <select id="centro-informe" className="input" style={{ maxWidth: 240 }} value={centroId} onChange={e => setCentroId(e.target.value)}>
        <option value="all">Todos los centros</option>
        {data.centros.map(c => <option key={c.id} value={String(c.id)}>{c.nombre}</option>)}
      </select>
      <div className="spacer" />
      <button className="btn secondary" onClick={() => window.print()}>🖨️ Imprimir / PDF</button>
    </div>
    <div className="card card-pad" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
      <div><h2 style={{ fontSize: 18 }}>Informe de material en planta</h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>Alcance: <strong>{alcance}</strong> · Generado el {formatFecha(data.generado.slice(0, 10))} a las {data.generado.slice(11, 16)} h</p></div>
    </div>
    {data.caducidad.vencidas > 0 && <div className="banner danger">⚠️ {data.caducidad.vencidas} producto{data.caducidad.vencidas > 1 ? "s" : ""} químico{data.caducidad.vencidas > 1 ? "s" : ""} con la caducidad vencida. Retíralo{data.caducidad.vencidas > 1 ? "s" : ""} del almacén.</div>}
    {data.caducidad.en30 > 0 && <div className="banner warn">⏳ {data.caducidad.en30} lote{data.caducidad.en30 > 1 ? "s" : ""} caduca{data.caducidad.en30 > 1 ? "n" : ""} en menos de 30 días.</div>}
    {data.stock_bajo.total > 0 && <div className="banner warn">📉 {data.stock_bajo.total} referencia{data.stock_bajo.total > 1 ? "s" : ""} en el stock mínimo o por debajo: químicos {data.stock_bajo.quimicos} · material {data.stock_bajo.material} · EPIs {data.stock_bajo.epis} · ropa {data.stock_bajo.ropa}. Haz entrada desde «Entradas / Salidas».</div>}
    <div className="kpis">
      <div className="kpi"><div className="label">Químicos</div><div className="value">{formatNum(r.quimicos.litros, 2)} L</div><div style={{ color: "var(--muted)" }}>{formatNum(r.quimicos.garrafas)} garrafas · {formatNum(r.quimicos.registros)} productos</div></div>
      <div className="kpi"><div className="label">Material de limpieza</div><div className="value">{formatNum(r.material.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(r.material.registros)} referencias</div></div>
      <div className="kpi"><div className="label">Maquinaria</div><div className="value">{formatNum(r.maquinaria.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(r.maquinaria.registros)} tipos de máquina</div></div>
      <div className="kpi"><div className="label">EPIs · Ropa</div><div className="value">{formatNum(r.epis.unidades + r.ropa.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(r.epis.registros)} EPIs · {formatNum(r.ropa.registros)} prendas</div></div>
      <div className="kpi"><div className="label">Valor del inventario</div><div className="value">{kpiValor}</div><div style={{ color: "var(--muted)" }}>químicos {formatNum(data.valor.quimicos, 2)} € · material {formatNum(data.valor.material, 2)} € · EPIs {formatNum(data.valor.epis, 2)} € · ropa {formatNum(data.valor.ropa, 2)} €</div></div>
      <div className={"kpi" + (data.stock_bajo.total > 0 || data.caducidad.vencidas > 0 ? " alert" : "")}><div className="label">Alertas</div><div className="value">{formatNum(data.stock_bajo.total + data.caducidad.vencidas)}</div><div style={{ color: "var(--muted)" }}>stock bajo + caducidades vencidas ({formatNum(data.caducidad.en90)} en ≤90 d)</div></div>
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧴 Productos químicos ({formatNum(data.quimicos.length)})</h3><button className="btn secondary small no-print" onClick={csvQuimicos}>⬇️ CSV</button></div>
      {!data.quimicos.length ? <div className="empty">Sin productos químicos en {alcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Producto</th><th>Lote</th><th className="right">L/garrafa</th><th className="right">Garrafas</th><th className="right">Total litros</th><th className="right">Valor (€)</th><th>Caducidad</th><th>Estado</th><th>Centro</th></tr></thead>
        <tbody>{data.quimicos.map(q => { const est = estadoCaducidad(q); return <tr key={String(q.id)}>
          <td>{String(q.codigo ?? "—")}</td><td>{String(q.marca ?? "—")}</td><td>{String(q.nombre ?? "")}</td><td>{String(q.numero_lote ?? "")}</td>
          <td className="right">{formatNum(q.litros_por_garrafa, 2)}</td>
          <td className="right">{stockAlerta(q, "num_garrafas")}</td>
          <td className="right"><strong>{formatNum(q.total_litros, 2)}</strong></td>
          <td className="right">{q.coste_unitario == null ? "—" : formatNum((Number(q.coste_unitario) || 0) * Number(q.num_garrafas ?? 0), 2)}</td>
          <td>{formatFecha(q.fecha_caducidad)}</td>
          <td><span className={"badge " + est.kind}>{est.label}</span></td>
          <td>{String(q.centro_nombre ?? "—")}</td></tr>; })}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧽 Material de limpieza por color</h3><button className="btn secondary small no-print" onClick={csvMaterial}>⬇️ CSV</button></div>
      <div className="card-pad" style={{ paddingTop: 0 }}><div className="chips">{data.por_color.map(c => <span key={c.color} className="badge"><ColorSwatch color={c.color} />{c.color}: {formatNum(c.unidades)} uds.</span>)}{!data.por_color.length && <span style={{ color: "var(--muted)" }}>Sin material registrado.</span>}</div></div>
      {data.material.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Material</th><th>Color</th><th className="right">Unidades</th><th className="right">Valor (€)</th><th>Centro</th></tr></thead>
        <tbody>{data.material.map(m => <tr key={String(m.id)}>
          <td>{String(m.codigo ?? "—")}</td><td>{String(m.marca ?? "—")}</td><td>{String(m.nombre ?? "")}</td>
          <td><ColorSwatch color={String(m.color ?? "")} />{String(m.color ?? "")}</td>
          <td className="right">{stockAlerta(m, "cantidad")}</td>
          <td className="right">{m.coste_unitario == null ? "—" : formatNum((Number(m.coste_unitario) || 0) * Number(m.cantidad ?? 0), 2)}</td>
          <td>{String(m.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧹 Maquinaria por tipo</h3><button className="btn secondary small no-print" onClick={csvMaquinaria}>⬇️ CSV</button></div>
      <div className="card-pad" style={{ paddingTop: 0 }}><div className="chips">{data.por_tipo.map(t => <span key={t.tipo} className="badge">{t.tipo}: {formatNum(t.unidades)} uds.</span>)}{!data.por_tipo.length && <span style={{ color: "var(--muted)" }}>Sin maquinaria registrada.</span>}</div></div>
      {data.maquinaria.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Máquina</th><th>Tipo</th><th className="right">Unidades</th><th>Nº serie</th><th>Estado</th><th>Centro</th></tr></thead>
        <tbody>{data.maquinaria.map(m => <tr key={String(m.id)}>
          <td>{String(m.nombre ?? "")}</td><td>{String(m.tipo ?? "")}</td><td className="right">{formatNum(m.cantidad)}</td>
          <td>{String(m.numero_serie ?? "—")}</td>
          <td><span className={"badge " + (m.estado === "Operativa" ? "ok" : m.estado === "En reparación" ? "warn" : m.estado === "Averiada" ? "danger" : "muted")}>{String(m.estado ?? "—")}</span></td>
          <td>{String(m.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🦺 EPIs ({formatNum(data.epis.length)})</h3><button className="btn secondary small no-print" onClick={csvEpis}>⬇️ CSV</button></div>
      {!data.epis.length ? <div className="empty">Sin EPIs en {alcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Modelo</th><th>Talla</th><th>Descripción</th><th className="right">Stock</th><th className="right">Valor (€)</th><th>Próxima revisión</th><th>Centro</th></tr></thead>
        <tbody>{data.epis.map(e => <tr key={String(e.id)}>
          <td>{String(e.codigo ?? "")}</td><td>{String(e.marca ?? "—")}</td><td>{String(e.modelo ?? "—")}</td><td>{String(e.talla ?? "—")}</td>
          <td>{String(e.descripcion ?? "—")}</td>
          <td className="right">{stockAlerta(e, "stock")}</td>
          <td className="right">{e.coste_unitario == null ? "—" : formatNum((Number(e.coste_unitario) || 0) * Number(e.stock ?? 0), 2)}</td>
          <td>{formatFecha(e.fecha_revision)}</td>
          <td>{String(e.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🥼 Ropa de trabajo ({formatNum(data.ropas.length)})</h3><button className="btn secondary small no-print" onClick={csvRopa}>⬇️ CSV</button></div>
      {!data.ropas.length ? <div className="empty">Sin ropa de trabajo en {alcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Prenda</th><th>Marca</th><th>Modelo</th><th>Talla</th><th className="right">Stock</th><th className="right">Valor (€)</th><th>Centro</th></tr></thead>
        <tbody>{data.ropas.map(p => <tr key={String(p.id)}>
          <td>{String(p.codigo ?? "")}</td><td>{String(p.prenda ?? "")}</td><td>{String(p.marca ?? "—")}</td><td>{String(p.modelo ?? "—")}</td>
          <td>{String(p.talla ?? "—")}</td>
          <td className="right">{stockAlerta(p, "stock")}</td>
          <td className="right">{p.coste_unitario == null ? "—" : formatNum((Number(p.coste_unitario) || 0) * Number(p.stock ?? 0), 2)}</td>
          <td>{String(p.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
  </>;
}
