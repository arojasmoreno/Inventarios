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
  stock_bajo: { quimicos: number; material: number; epis: number; ropa: number; total: number };
  caducidad: { vencidas: number; en30: number; en90: number };
  quimicos: Row[]; material: Row[]; maquinaria: Row[]; epis: Row[]; ropas: Row[];
  por_color: { color: string; unidades: number; registros: number }[];
  por_tipo: { tipo: string; unidades: number; registros: number }[];
  consumos_por_zona: { centro: string; zona: string; movimientos: number; unidades: number; ultimo: string | null }[];
  consumos_por_subzona: { zona: string; subzona: string; movimientos: number; unidades: number; ultimo: string | null }[];
  entregas_por_operario: { operario_id: number; operario: string; username: string; entregas: number; unidades: number; ultima: string | null }[];
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

export function Informes({ user }: { user: { rol: string } }) {
  // Los usuarios consultan el informe, pero no pueden descargarlo (CSV ni PDF).
  const puedeDescargar = user.rol !== "usuario";
  const [centroId, setCentroId] = useState("all"), [origenId, setOrigenId] = useState("all"), [data, setData] = useState<Informe | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null);
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
  // Filtro de origen (Fábrica / Empresa) sobre los consumibles del informe:
  // los totales, las alertas y el desglose por color se recalculan aquí para
  // que todo lo que se vea corresponda al origen elegido.
  const enOrigen = (row: Row) => origenId === "all" || String(row.origen ?? "") === origenId;
  const quimicos = data.quimicos.filter(enOrigen), material = data.material.filter(enOrigen);
  const suma = (rows: Row[], key: string): number => rows.reduce((acc, row) => acc + Number(row[key] ?? 0), 0);
  const rQ = { registros: quimicos.length, garrafas: suma(quimicos, "num_garrafas"), litros: Number(suma(quimicos, "total_litros").toFixed(2)) };
  const rM = { registros: material.length, unidades: suma(material, "cantidad") };
  const caducidad = {
    vencidas: quimicos.filter(q => String(q.estado_caducidad) === "vencida").length,
    en30: quimicos.filter(q => String(q.estado_caducidad) === "30").length,
    en90: quimicos.filter(q => String(q.estado_caducidad) === "90").length,
  };
  const bajoDe = (rows: Row[], key: string) => rows.filter(row => Number(row.stock_minimo ?? 0) > 0 && Number(row[key] ?? 0) <= Number(row.stock_minimo)).length;
  const sQ = bajoDe(quimicos, "num_garrafas"), sM = bajoDe(material, "cantidad");
  const sE = bajoDe(data.epis, "stock"), sR = bajoDe(data.ropas, "stock");
  const stock_bajo = { quimicos: sQ, material: sM, epis: sE, ropa: sR, total: sQ + sM + sE + sR };
  const porColorMap = new Map<string, { color: string; unidades: number; registros: number }>();
  for (const m of material) { const color = String(m.color); const e = porColorMap.get(color) ?? { color, unidades: 0, registros: 0 }; e.unidades += Number(m.cantidad ?? 0); e.registros++; porColorMap.set(color, e); }
  const porColor = [...porColorMap.values()].sort((a, b) => b.unidades - a.unidades);
  const enAlcance = origenId === "all" ? alcance : `${alcance} · origen: ${origenId === "empresa" ? "Empresa" : "Fábrica"}`;
  // Máquinas agrupadas por situación actual (último registro del histórico).
  const porSituacion = new Map<string, number>();
  for (const m of data.maquinaria) { const e = String(m.estado ?? "Sin estado"); porSituacion.set(e, (porSituacion.get(e) ?? 0) + 1); }
  const csvQuimicos = () => downloadCsv(`informe-quimicos-${stamp}.csv`,
    ["Código", "Marca", "Producto", "Lote", "L/garrafa", "Garrafas", "Total litros", "Caducidad", "Estado", "Origen", "Centro"],
    quimicos.map(q => [String(q.codigo ?? ""), String(q.marca ?? ""), String(q.nombre ?? ""), String(q.numero_lote ?? ""), formatNum(q.litros_por_garrafa, 2), formatNum(q.num_garrafas), formatNum(q.total_litros, 2), formatFecha(q.fecha_caducidad), estadoCaducidad(q).label, String(q.origen ?? "") === "empresa" ? "Empresa" : "Fabrica", String(q.centro_nombre ?? "—")]));
  const csvMaterial = () => downloadCsv(`informe-material-${stamp}.csv`,
    ["Código", "Marca", "Material", "Color", "Unidades", "Origen", "Centro"],
    material.map(m => [String(m.codigo ?? ""), String(m.marca ?? ""), String(m.nombre ?? ""), String(m.color ?? ""), formatNum(m.cantidad), String(m.origen ?? "") === "empresa" ? "Empresa" : "Fabrica", String(m.centro_nombre ?? "—")]));
  const csvMaquinaria = () => downloadCsv(`informe-maquinaria-${stamp}.csv`,
    ["Máquina", "Tipo", "Unidades", "Nº serie", "Estado", "Centro"],
    data.maquinaria.map(m => [String(m.nombre ?? ""), String(m.tipo ?? ""), formatNum(m.cantidad), String(m.numero_serie ?? "—"), String(m.estado ?? ""), String(m.centro_nombre ?? "—")]));
  const csvEpis = () => downloadCsv(`informe-epis-${stamp}.csv`,
    ["Código", "Marca", "Modelo", "Talla", "Descripción", "Stock", "Próxima revisión", "Centro"],
    data.epis.map(e => [String(e.codigo ?? ""), String(e.marca ?? ""), String(e.modelo ?? ""), String(e.talla ?? ""), String(e.descripcion ?? ""), formatNum(e.stock), formatFecha(e.fecha_revision), String(e.centro_nombre ?? "—")]));
  const csvZonas = () => downloadCsv(`informe-consumos-zonas-${stamp}.csv`,
    ["Centro", "Zona", "Movimientos", "Unidades", "Último consumo"],
    data.consumos_por_zona.map(z => [String(z.centro), String(z.zona), z.movimientos, z.unidades, String(z.ultimo ?? "")]));
  const csvEntregas = () => downloadCsv(`informe-entregas-${stamp}.csv`,
    ["Operario", "Login", "Entregas", "Unidades", "Última entrega"],
    data.entregas_por_operario.map(e => [String(e.operario), String(e.username), e.entregas, e.unidades, e.ultima ? formatFecha(e.ultima) : ""]));
  const csvRopa = () => downloadCsv(`informe-ropa-${stamp}.csv`,
    ["Código", "Prenda", "Marca", "Modelo", "Talla", "Stock", "Centro"],
    data.ropas.map(p => [String(p.codigo ?? ""), String(p.prenda ?? ""), String(p.marca ?? ""), String(p.modelo ?? ""), String(p.talla ?? ""), formatNum(p.stock), String(p.centro_nombre ?? "—")]));
  // Valor del inventario: precio unitario (opcional) × cantidad de cada
  // artículo. Los productos sin precio no suman.
  const valorDe = (rows: Row[], cantidadKey: string): number => rows.reduce((acc, a) =>
    acc + (a.precio == null || a.precio === "" ? 0 : Number(a.precio) * Number(a[cantidadKey] ?? 0)), 0);
  const valorInventario = valorDe(quimicos, "num_garrafas") + valorDe(material, "cantidad")
    + valorDe(data.epis, "stock") + valorDe(data.ropas, "stock");
  const conPrecio = [quimicos, material, data.epis, data.ropas]
    .reduce((n, rows) => n + rows.filter(a => a.precio != null && a.precio !== "").length, 0);
  const totalArticulos = quimicos.length + material.length + data.epis.length + data.ropas.length;

  return <>
    <div className="toolbar no-print">
      <label htmlFor="centro-informe" style={{ fontWeight: 600 }}>Centro / planta:</label>
      <select id="centro-informe" className="input" style={{ maxWidth: 240 }} value={centroId} onChange={e => setCentroId(e.target.value)}>
        <option value="all">Todos los centros</option>
        {data.centros.map(c => <option key={c.id} value={String(c.id)}>{c.nombre}</option>)}
      </select>
      <label htmlFor="origen-informe" style={{ fontWeight: 600 }}>Origen:</label>
      <select id="origen-informe" className="input" style={{ maxWidth: 190 }} value={origenId} onChange={e => setOrigenId(e.target.value)}>
        <option value="all">Todo el origen</option>
        <option value="fabrica">🏭 Fábrica</option>
        <option value="empresa">🏢 Empresa</option>
      </select>
      <div className="spacer" />
      {puedeDescargar && <button className="btn secondary" onClick={() => window.print()}>🖨️ Imprimir / PDF</button>}
    </div>
    <div className="card card-pad" style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
      <div><h2 style={{ fontSize: 18 }}>Informe de material en planta</h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>Alcance: <strong>{enAlcance}</strong> · Generado el {formatFecha(data.generado.slice(0, 10))} a las {data.generado.slice(11, 16)} h</p></div>
    </div>
    {caducidad.vencidas > 0 && <div className="banner danger">⚠️ {caducidad.vencidas} producto{caducidad.vencidas > 1 ? "s" : ""} químico{caducidad.vencidas > 1 ? "s" : ""} con la caducidad vencida. Retíralo{caducidad.vencidas > 1 ? "s" : ""} del almacén.</div>}
    {caducidad.en30 > 0 && <div className="banner warn">⏳ {caducidad.en30} lote{caducidad.en30 > 1 ? "s" : ""} caduca{caducidad.en30 > 1 ? "n" : ""} en menos de 30 días.</div>}
    {stock_bajo.total > 0 && <div className="banner warn">📉 {stock_bajo.total} referencia{stock_bajo.total > 1 ? "s" : ""} en el stock mínimo o por debajo: químicos {stock_bajo.quimicos} · material {stock_bajo.material} · EPIs {stock_bajo.epis} · ropa {stock_bajo.ropa}. Haz entrada desde «Entradas / Salidas».</div>}
    <div className="kpis">
      <div className="kpi"><div className="label">Químicos</div><div className="value">{formatNum(rQ.litros, 2)} L</div><div style={{ color: "var(--muted)" }}>{formatNum(rQ.garrafas)} garrafas · {formatNum(rQ.registros)} productos</div></div>
      <div className="kpi"><div className="label">Material de limpieza</div><div className="value">{formatNum(rM.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(rM.registros)} referencias</div></div>
      <div className="kpi"><div className="label">Maquinaria</div><div className="value">{formatNum(r.maquinaria.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(r.maquinaria.registros)} tipos de máquina</div></div>
      <div className="kpi"><div className="label">EPIs · Ropa</div><div className="value">{formatNum(r.epis.unidades + r.ropa.unidades)} uds.</div><div style={{ color: "var(--muted)" }}>{formatNum(r.epis.registros)} EPIs · {formatNum(r.ropa.registros)} prendas</div></div>
      <div className="kpi"><div className="label">Valor del inventario</div><div className="value">{formatNum(valorInventario, 2)} €</div><div style={{ color: "var(--muted)" }}>{formatNum(conPrecio)} de {formatNum(totalArticulos)} artículos con precio</div></div>
      <div className={"kpi" + (stock_bajo.total > 0 || caducidad.vencidas > 0 ? " alert" : "")}><div className="label">Alertas</div><div className="value">{formatNum(stock_bajo.total + caducidad.vencidas)}</div><div style={{ color: "var(--muted)" }}>stock bajo + caducidades vencidas ({formatNum(caducidad.en90)} en ≤90 d)</div></div>
    </div>
    <div className="card"><div className="card-pad section-head"><h3>📍 Consumos por zona y subzona</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvZonas} disabled={!data.consumos_por_zona.length}>⬇️ CSV</button>}</div>
      {data.consumos_por_zona.length ? <>
        <div className="table-scroll"><table>
          <thead><tr><th>Centro</th><th>Zona</th><th className="right">Movimientos</th><th className="right">Unidades</th><th>Último consumo</th></tr></thead>
          <tbody>{data.consumos_por_zona.map((z, i) => <tr key={`${String(z.centro)}-${String(z.zona)}-${i}`}>
            <td>{String(z.centro)}</td><td><strong>{String(z.zona)}</strong></td>
            <td className="right">{formatNum(z.movimientos)}</td><td className="right">{formatNum(z.unidades)}</td>
            <td>{z.ultimo ? String(z.ultimo).replace("T", " ").slice(0, 16) : "—"}</td></tr>)}</tbody></table></div>
        {data.consumos_por_subzona.length > 0 && <div className="card-pad" style={{ paddingTop: 0 }}>
          <div className="chips">{data.consumos_por_subzona.map((s, i) => <span className="badge" key={`${String(s.zona)}-${String(s.subzona)}-${i}`}>🧱 {String(s.zona)} › {String(s.subzona)}: {formatNum(s.unidades)} ud.</span>)}</div>
        </div>}
      </> : <div className="empty" style={{ padding: 20 }}>Sin consumos de estaciones registrados todavía.</div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>👕 Equipación: entregas por operario ({formatNum(data.entregas_por_operario.length)})</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvEntregas} disabled={!data.entregas_por_operario.length}>⬇️ CSV</button>}</div>
      {data.entregas_por_operario.length ? <div className="table-scroll"><table>
        <thead><tr><th>Operario</th><th>Login</th><th className="right">Entregas</th><th className="right">Unidades</th><th>Última entrega</th></tr></thead>
        <tbody>{data.entregas_por_operario.map(e => <tr key={String(e.operario_id)}>
          <td><strong>{String(e.operario)}</strong></td><td>{String(e.username)}</td>
          <td className="right">{formatNum(e.entregas)}</td><td className="right">{formatNum(e.unidades)}</td>
          <td>{e.ultima ? formatFecha(e.ultima) : "—"}</td></tr>)}</tbody></table></div>
        : <div className="empty" style={{ padding: 20 }}>Sin entregas de equipación registradas en {alcance}.</div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧴 Productos químicos ({formatNum(quimicos.length)})</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvQuimicos}>⬇️ CSV</button>}</div>
      {!quimicos.length ? <div className="empty">Sin productos químicos en {enAlcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Producto</th><th>Lote</th><th className="right">L/garrafa</th><th className="right">Garrafas</th><th className="right">Total litros</th><th>Caducidad</th><th>Estado</th><th>Origen</th><th>Centro</th></tr></thead>
        <tbody>{quimicos.map(q => { const est = estadoCaducidad(q); return <tr key={String(q.id)}>
          <td>{String(q.codigo ?? "—")}</td><td>{String(q.marca ?? "—")}</td><td>{String(q.nombre ?? "")}</td><td>{String(q.numero_lote ?? "")}</td>
          <td className="right">{formatNum(q.litros_por_garrafa, 2)}</td>
          <td className="right">{stockAlerta(q, "num_garrafas")}</td>
          <td className="right"><strong>{formatNum(q.total_litros, 2)}</strong></td>
          <td>{formatFecha(q.fecha_caducidad)}</td>
          <td><span className={"badge " + est.kind}>{est.label}</span></td>
          <td><span className={"badge " + (String(q.origen ?? "") === "empresa" ? "warn" : "info")}>{String(q.origen ?? "") === "empresa" ? "🏢 Empresa" : "🏭 Fábrica"}</span></td>
          <td>{String(q.centro_nombre ?? "—")}</td></tr>; })}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧽 Material de limpieza por color</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvMaterial}>⬇️ CSV</button>}</div>
      <div className="card-pad" style={{ paddingTop: 0 }}><div className="chips">{porColor.map(c => <span key={c.color} className="badge"><ColorSwatch color={c.color} />{c.color}: {formatNum(c.unidades)} uds.</span>)}{!porColor.length && <span style={{ color: "var(--muted)" }}>Sin material registrado.</span>}</div></div>
      {material.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Material</th><th>Color</th><th className="right">Unidades</th><th>Origen</th><th>Centro</th></tr></thead>
        <tbody>{material.map(m => <tr key={String(m.id)}>
          <td>{String(m.codigo ?? "—")}</td><td>{String(m.marca ?? "—")}</td><td>{String(m.nombre ?? "")}</td>
          <td><ColorSwatch color={String(m.color ?? "")} />{String(m.color ?? "")}</td>
          <td className="right">{stockAlerta(m, "cantidad")}</td>
          <td><span className={"badge " + (String(m.origen ?? "") === "empresa" ? "warn" : "info")}>{String(m.origen ?? "") === "empresa" ? "🏢 Empresa" : "🏭 Fábrica"}</span></td>
          <td>{String(m.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🧹 Maquinaria por tipo</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvMaquinaria}>⬇️ CSV</button>}</div>
      <div className="card-pad" style={{ paddingTop: 0 }}><div className="chips">{data.por_tipo.map(t => <span key={t.tipo} className="badge">{t.tipo}: {formatNum(t.unidades)} uds.</span>)}{!data.por_tipo.length && <span style={{ color: "var(--muted)" }}>Sin maquinaria registrada.</span>}</div>
        {porSituacion.size > 0 && <div className="chips" style={{ marginTop: 6 }} aria-label="Máquinas por situación">{[...porSituacion.entries()].map(([estado, n]) =>
          <span className="badge" key={estado}>🧭 {estado}: {formatNum(n)}</span>)}</div>}</div>
      {data.maquinaria.length > 0 && <div className="table-scroll"><table>
        <thead><tr><th>Máquina</th><th>Tipo</th><th className="right">Unidades</th><th>Nº serie</th><th>Estado</th><th>Centro</th></tr></thead>
        <tbody>{data.maquinaria.map(m => <tr key={String(m.id)}>
          <td>{String(m.nombre ?? "")}</td><td>{String(m.tipo ?? "")}</td><td className="right">{formatNum(m.cantidad)}</td>
          <td>{String(m.numero_serie ?? "—")}</td>
          <td><span className={"badge " + (m.estado === "Operativo" ? "ok" : m.estado === "En reparación" ? "warn" : m.estado === "Averiado" ? "danger" : m.estado === "Baja" ? "muted" : "info")}>{String(m.estado ?? "—")}</span></td>
          <td>{String(m.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🦺 EPIs ({formatNum(data.epis.length)})</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvEpis}>⬇️ CSV</button>}</div>
      {!data.epis.length ? <div className="empty">Sin EPIs en {alcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Marca</th><th>Modelo</th><th>Talla</th><th>Descripción</th><th className="right">Stock</th><th>Próxima revisión</th><th>Centro</th></tr></thead>
        <tbody>{data.epis.map(e => <tr key={String(e.id)}>
          <td>{String(e.codigo ?? "")}</td><td>{String(e.marca ?? "—")}</td><td>{String(e.modelo ?? "—")}</td><td>{String(e.talla ?? "—")}</td>
          <td>{String(e.descripcion ?? "—")}</td>
          <td className="right">{stockAlerta(e, "stock")}</td>
          <td>{formatFecha(e.fecha_revision)}</td>
          <td>{String(e.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
    <div className="card"><div className="card-pad section-head"><h3>🥼 Ropa de trabajo ({formatNum(data.ropas.length)})</h3>{puedeDescargar && <button className="btn secondary small no-print" onClick={csvRopa}>⬇️ CSV</button>}</div>
      {!data.ropas.length ? <div className="empty">Sin ropa de trabajo en {alcance}.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Código</th><th>Prenda</th><th>Marca</th><th>Modelo</th><th>Talla</th><th className="right">Stock</th><th>Centro</th></tr></thead>
        <tbody>{data.ropas.map(p => <tr key={String(p.id)}>
          <td>{String(p.codigo ?? "")}</td><td>{String(p.prenda ?? "")}</td><td>{String(p.marca ?? "—")}</td><td>{String(p.modelo ?? "—")}</td>
          <td>{String(p.talla ?? "—")}</td>
          <td className="right">{stockAlerta(p, "stock")}</td>
          <td>{String(p.centro_nombre ?? "—")}</td></tr>)}</tbody></table></div>}
    </div>
  </>;
}
