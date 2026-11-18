import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { formatNum } from "./ui";

interface Grupo {
  clave: string;
  programados: number;
  vencidos: number;
  hechos: number;
  hechos_vencidos: number;
  porcentaje: number | null;
}
interface Tarea {
  faena_id: number;
  zona: string;
  subzona: string | null;
  turno: string;
  frecuencia: string | null;
  programados: number;
  vencidos: number;
  hechos: number;
  hechos_vencidos: number;
  pendientes: number;
  porcentaje: number | null;
}
interface Cumplimiento {
  centro: { id: number; nombre: string };
  anio: number;
  mes: number;
  desde: string;
  hasta: string;
  fecha_hoy: string;
  resumen: { programados: number; vencidos: number; hechos: number; pendientes: number; porcentaje: number | null };
  por_turno: Grupo[];
  por_zona: Grupo[];
  tareas: Tarea[];
}

const ETIQUETA_TURNO: Record<string, string> = { dia: "☀️ Día", tarde: "🌤️ Tarde", noche: "🌙 Noche" };
const nombreTarea = (t: Tarea): string => (t.subzona ? `${t.zona} / ${t.subzona}` : t.zona);
const tipoBadge = (p: number | null): string => (p === null ? "muted" : p >= 95 ? "ok" : p >= 70 ? "warn" : "danger");

/** Cumplimiento del plan: días exigibles hasta hoy frente a los marcados como
 *  hechos, desglosado por turno y zona. Sirve para auditar el plan mensual. */
export function CumplimientoMes({ centro, anio, mes, mesTexto, version }: {
  centro: { id: number; nombre: string };
  anio: number;
  mes: number;
  mesTexto: string;
  version: number;
}) {
  const [data, setData] = useState<Cumplimiento | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      setData(await api.get<Cumplimiento>(`/api/limpieza/cumplimiento?centro_id=${centro.id}&anio=${anio}&mes=${mes}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo calcular el cumplimiento");
    } finally { setCargando(false); }
  }, [centro.id, anio, mes]);
  useEffect(() => { void load(); }, [load, version]);

  if (error) return <div className="card empty">⚠️ {error}</div>;
  if (cargando || !data) return <div className="card loading">Calculando el cumplimiento…</div>;

  const { resumen } = data;
  const peores = [...data.tareas]
    .filter((t) => t.vencidos > 0)
    .sort((a, b) => (a.porcentaje ?? 101) - (b.porcentaje ?? 101) || b.pendientes - a.pendientes)
    .slice(0, 12);

  return <>
    <div className="kpis">
      <div className="kpi"><div className="label">Cumplimiento del mes</div>
        <div className="value">{resumen.porcentaje === null ? "—" : `${formatNum(resumen.porcentaje)}%`}</div>
        <div className="kpi-sub">{formatNum(resumen.hechos)} de {formatNum(resumen.vencidos)} días exigibles</div></div>
      <div className="kpi"><div className="label">Días programados</div><div className="value">{formatNum(resumen.programados)}</div>
        <div className="kpi-sub">en {mesTexto.toLowerCase()} · {data.centro.nombre}</div></div>
      <div className={"kpi" + (resumen.pendientes > 0 ? " alert" : "")}><div className="label">Pendientes</div>
        <div className="value">{formatNum(resumen.pendientes)}</div>
        <div className="kpi-sub">días ya pasados sin marcar</div></div>
      <div className="kpi"><div className="label">Hechos</div><div className="value">{formatNum(resumen.hechos)}</div>
        <div className="kpi-sub">marcados por los operarios</div></div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>🕒 Por turno</h3></div>
        {data.por_turno.length
          ? <div className="table-scroll"><table>
            <thead><tr><th>Turno</th><th className="right">Exigibles</th><th className="right">Hechos</th><th className="right">Cumplimiento</th></tr></thead>
            <tbody>{data.por_turno.map((g) => <tr key={g.clave}>
              <td>{ETIQUETA_TURNO[g.clave] ?? g.clave}</td>
              <td className="right">{formatNum(g.vencidos)}</td>
              <td className="right">{formatNum(g.hechos_vencidos)}</td>
              <td className="right"><span className={"badge " + tipoBadge(g.porcentaje)}>{g.porcentaje === null ? "—" : `${formatNum(g.porcentaje)}%`}</span></td>
            </tr>)}</tbody></table></div>
          : <p style={{ color: "var(--muted)", margin: 0 }}>Sin días programados en este mes.</p>}
      </div>
      <div className="card card-pad">
        <div className="section-head"><h3>📍 Por zona</h3></div>
        {data.por_zona.length
          ? <div className="table-scroll"><table>
            <thead><tr><th>Zona</th><th className="right">Exigibles</th><th className="right">Hechos</th><th className="right">Cumplimiento</th></tr></thead>
            <tbody>{data.por_zona.map((g) => <tr key={g.clave}>
              <td>{g.clave}</td>
              <td className="right">{formatNum(g.vencidos)}</td>
              <td className="right">{formatNum(g.hechos_vencidos)}</td>
              <td className="right"><span className={"badge " + tipoBadge(g.porcentaje)}>{g.porcentaje === null ? "—" : `${formatNum(g.porcentaje)}%`}</span></td>
            </tr>)}</tbody></table></div>
          : <p style={{ color: "var(--muted)", margin: 0 }}>Sin zonas programadas en este mes.</p>}
      </div>
    </div>

    <div className="card card-pad">
      <div className="section-head"><h3>⚠️ Tareas con días pendientes</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Ordenadas de peor a mejor cumplimiento</span></div>
      {peores.length
        ? <div className="table-scroll"><table>
          <thead><tr><th>Zona</th><th>Turno</th><th>Frecuencia</th><th className="right">Exigibles</th><th className="right">Hechos</th><th className="right">Pendientes</th><th className="right">Cumplimiento</th></tr></thead>
          <tbody>{peores.map((t) => <tr key={t.faena_id}>
            <td>{nombreTarea(t)}</td>
            <td>{ETIQUETA_TURNO[t.turno] ?? t.turno}</td>
            <td>{t.frecuencia ?? "—"}</td>
            <td className="right">{formatNum(t.vencidos)}</td>
            <td className="right">{formatNum(t.hechos_vencidos)}</td>
            <td className="right"><strong>{formatNum(t.pendientes)}</strong></td>
            <td className="right"><span className={"badge " + tipoBadge(t.porcentaje)}>{t.porcentaje === null ? "—" : `${formatNum(t.porcentaje)}%`}</span></td>
          </tr>)}</tbody></table></div>
        : <p style={{ color: "var(--muted)", margin: 0 }}>Todo lo que tocaba hasta hoy está marcado. 👏</p>}
    </div>
  </>;
}
