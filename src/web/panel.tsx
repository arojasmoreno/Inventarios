import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { formatFecha, formatNum } from "./ui";

type Row = Record<string, unknown>;

interface PanelData {
  generado: string;
  consumo: {
    hoy: { unidades: number; movimientos: number };
    semana: { unidades: number; movimientos: number };
    mes: { unidades: number; movimientos: number };
  };
  estaciones: { total: number; activas: number };
  por_dia: { fecha: string; unidades: number; movimientos: number }[];
  por_zona: { zona_id: number | null; zona: string; centro: string; movimientos: number; unidades: number; ultimo: string }[];
  sin_consumo: Row[];
  stock_bajo: Row[];
  quimicos_vencidos: number;
}

const nombreEstacion = (e: Row): string => {
  const partes = [e.zona_nombre, e.subzona_nombre, e.soporte_nombre].filter((v): v is string => Boolean(v));
  return partes.join(" · ") || `Estación #${String(e.id)}`;
};

/** Panel de control: lo que importa hoy — consumos, estaciones paradas y stock bajo. */
export function PanelPage() {
  const [data, setData] = useState<PanelData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await api.get<PanelData>("/api/panel")); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo cargar el panel"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div className="card empty">⚠️ {error}</div>;
  if (!data) return <div className="loading\">Cargando panel…</div>;

  const maxDia = Math.max(1, ...data.por_dia.map((d) => Number(d.unidades)));
  const maxZona = Math.max(1, ...data.por_zona.map((z) => Number(z.unidades)));
  const alertas = data.stock_bajo.length + data.quimicos_vencidos + data.sin_consumo.length;

  return <>
    <div className="kpis">
      <div className="kpi"><div className="label">Consumo hoy</div><div className="value">{formatNum(data.consumo.hoy.unidades)} ud.</div>
        <div className="kpi-sub">{formatNum(data.consumo.hoy.movimientos)} movimientos registrados</div></div>
      <div className="kpi"><div className="label">Últimos 7 días</div><div className="value">{formatNum(data.consumo.semana.unidades)} ud.</div>
        <div className="kpi-sub">{formatNum(data.consumo.mes.unidades)} ud. en 30 días</div></div>
      <div className="kpi"><div className="label">Estaciones</div><div className="value">{formatNum(data.estaciones.activas)}<span style={{ fontSize: 15, color: "var(--muted)" }}> / {formatNum(data.estaciones.total)}</span></div>
        <div className="kpi-sub">activas de totales</div></div>
      <a className="kpi" href="#/estaciones" style={{ textDecoration: "none", color: "inherit" }}>
        <div className="label">Sin consumo (30 d)</div><div className="value">{formatNum(data.sin_consumo.length)}</div>
        <div className={"kpi-sub" + (data.sin_consumo.length ? " up" : "")}>estaciones activas paradas</div></a>
      <div className={"kpi" + (alertas > 0 ? " alert" : "")}><div className="label">Alertas</div><div className="value">{formatNum(alertas)}</div>
        <div className="kpi-sub">stock bajo {formatNum(data.stock_bajo.length)} · vencidos {formatNum(data.quimicos_vencidos)}</div></div>
    </div>

    <div className="card card-pad">
      <div className="section-head"><h3>📊 Consumo por día (14 días)</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Máximo {formatNum(maxDia)} ud./día</span></div>
      {data.por_dia.length
        ? <div className="chart">{data.por_dia.map((d) => <div className="chart-col" key={d.fecha} title={`${formatFecha(d.fecha)}: ${formatNum(d.unidades)} ud.`}>
            <div className="chart-bars"><div className="bar in" style={{ height: `${Math.max(4, Math.round((Number(d.unidades) / maxDia) * 100))}%` }} title={`${formatNum(d.unidades)} ud.`} /></div>
            <span className="chart-label">{String(d.fecha).slice(8, 10)}/{String(d.fecha).slice(5, 7)}</span>
          </div>)}</div>
        : <p style={{ color: "var(--muted)", margin: 0 }}>Todavía no hay consumos registrados. Escanea el QR de una estación para empezar.</p>}
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>📍 Consumos por zona (30 días)</h3></div>
        {data.por_zona.length
          ? data.por_zona.map((z) => <a key={`${z.zona_id ?? "x"}-${z.zona}`} className="hbar"
              href={z.zona_id ? `#/estaciones?zona=${z.zona_id}` : "#/zonas"}
              title={`Ver estaciones de ${z.zona} · último consumo ${formatFecha(String(z.ultimo ?? "").slice(0, 10))}`}>
              <span className="hbar-label">{z.zona}<br /><small style={{ color: "var(--muted)", fontWeight: 400 }}>{z.centro}</small></span>
              <span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.max(3, Math.round((Number(z.unidades) / maxZona) * 100))}%` }} /></span>
              <span className="hbar-value">{formatNum(z.unidades)} <small>ud.</small></span>
            </a>)
          : <p style={{ color: "var(--muted)", margin: 0 }}>Sin consumos por zona todavía.</p>}
      </div>
      <div className="card card-pad">
        <div className="section-head"><h3>📉 Artículos bajo mínimo ({formatNum(data.stock_bajo.length)})</h3>
          <a className="btn secondary small" href="#/informes">📈 Informes</a></div>
        {data.stock_bajo.length
          ? <div className="table-scroll"><table>
            <thead><tr><th>Categoría</th><th>Artículo</th><th className="right">Stock</th><th className="right">Mínimo</th></tr></thead>
            <tbody>{data.stock_bajo.map((s, i) => <tr key={`${String(s.seccion)}-${String(s.id ?? i)}`}>
              <td><a href={`#/${String(s.seccion)}`} style={{ color: "var(--primary)", textDecoration: "none" }}>{String(s.categoria)}</a></td>
              <td>{String(s.nombre ?? "—")}{s.codigo ? <span style={{ color: "var(--muted)" }}> · {String(s.codigo)}</span> : null}</td>
              <td className="right"><span className="badge danger">{formatNum(s.stock)}</span></td>
              <td className="right">{formatNum(s.minimo)}</td>
            </tr>)}</tbody></table></div>
          : <p style={{ color: "var(--muted)", margin: 0 }}>Ningún artículo por debajo del mínimo. ¡Todo surtido! </p>}
      </div>
    </div>

    {data.sin_consumo.length > 0 && <div className="card card-pad">
      <div className="section-head"><h3>🚻 Estaciones sin consumo en 30 días ({formatNum(data.sin_consumo.length)})</h3>
        <a className="btn secondary small" href="#/estaciones">Ver estaciones</a></div>
      <div className="chips">{data.sin_consumo.map((e) => <a className="chip" key={String(e.id)} href={`#/estaciones?consumo=${String(e.id)}`}
        title={`Abrir el modo estación de ${nombreEstacion(e)}`}>🚻 {nombreEstacion(e)}{e.tipo_nombre ? ` · ${String(e.tipo_nombre)}` : ""}</a>)}</div>
    </div>}
  </>;
}
