import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { downloadCsv, formatNum } from "./ui";

type Row = Record<string, unknown>;

const PERIODOS = [
  { key: 7, label: "7 días" },
  { key: 30, label: "30 días" },
  { key: 90, label: "90 días" },
  { key: 0, label: "Todo" },
] as const;

/** Consumos y costes: resumen, gráfico diario y detalle con exportación. */
export function ConsumosCostesPage() {
  const [movimientos, setMovimientos] = useState<Row[]>([]);
  const [dias, setDias] = useState<number>(30);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setMovimientos((await api.get<{ items: Row[] }>("/api/movimientos")).items); }
    catch (e) { setError(e instanceof Error ? e.message : "Error cargando movimientos"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const cutoff = useMemo(() => {
    if (dias === 0) return "";
    const d = new Date(); d.setDate(d.getDate() - dias); return d.toISOString().slice(0, 10);
  }, [dias]);
  const enPeriodo = useMemo(() => movimientos.filter((m) => String(m.created_at ?? "").slice(0, 10) >= cutoff), [movimientos, cutoff]);
  const de = (accion: string) => enPeriodo.filter((m) => m.accion === accion);
  const suma = (rows: Row[], key: "cantidad" | "coste") => rows.reduce((s, r) => s + Number(r[key] ?? 0), 0);

  const consumos = de("consumo"), entradas = de("entrada"), salidas = de("salida"), entregas = de("entrega");
  const costeConsumos = suma(consumos, "coste");
  const porDia = useMemo(() => {
    const map = new Map<string, number>();
    for (const m of consumos) {
      const dia = String(m.created_at ?? "").slice(0, 10);
      if (!dia) continue;
      map.set(dia, (map.get(dia) ?? 0) + Number(m.cantidad ?? 0));
    }
    const arr = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    return arr.slice(-31);
  }, [consumos]);
  const maxDia = Math.max(1, ...porDia.map(([, v]) => v));

  const exportCsv = () => {
    downloadCsv(`consumos-costes-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Fecha", "Usuario", "Tipo", "Detalle", "Cantidad", "Coste (€)", "Motivo"],
      enPeriodo.map((m) => [String(m.created_at ?? "").slice(0, 16), String(m.usuario_nombre ?? ""), String(m.accion ?? ""), String(m.descripcion ?? ""), String(m.cantidad ?? ""), String(m.coste ?? ""), String(m.motivo ?? "")]));
  };

  if (error) return <div className="card empty">⚠️ {error}</div>;
  return <>
    <div className="toolbar no-print">
      <select className="input" style={{ maxWidth: 160 }} value={dias} onChange={(e) => setDias(Number(e.target.value))}>
        {PERIODOS.map((p) => <option key={p.key} value={p.key}>{p.key === 0 ? "Todo el histórico" : `Últimos ${p.label}`}</option>)}
      </select>
      <div className="spacer" />
      <button className="btn secondary" onClick={exportCsv} disabled={!enPeriodo.length}>⬇️ CSV</button>
    </div>
    <div className="stat-grid">
      <div className="stat"><div className="k">Consumos ({enPeriodo.filter((m) => m.accion === "consumo").length})</div><div className="v">{formatNum(suma(consumos, "cantidad"))} uds.</div></div>
      <div className="stat"><div className="k">Coste de consumos</div><div className="v">{formatNum(costeConsumos, 2)} €</div></div>
      <div className="stat"><div className="k">Entradas (30 d equivalentes)</div><div className="v">{formatNum(suma(entradas, "cantidad"))} uds.</div></div>
      <div className="stat"><div className="k">Salidas</div><div className="v">{formatNum(suma(salidas, "cantidad"))} uds.</div></div>
      <div className="stat"><div className="k">Entregas de ropa</div><div className="v">{formatNum(suma(entregas, "cantidad"))} uds.</div></div>
    </div>
    <div className="card card-pad">
      <div className="section-head"><h3>Consumos por día</h3></div>
      {porDia.length === 0
        ? <p style={{ color: "var(--muted)" }}>Sin consumos registrados en el periodo.</p>
        : <>
            <div className="bars">{porDia.map(([dia, v]) => (
              <div key={dia} className="bar" style={{ height: `${Math.max(6, Math.round((v / maxDia) * 100))}%` }} title={`${dia}: ${v} uds.`}><span>{v}</span></div>
            ))}</div>
            <p style={{ color: "var(--muted)", fontSize: 12, margin: "8px 0 0" }}>Unidades consumidas por día · últimos {porDia.length} días</p>
          </>}
    </div>
    <div className="card">
      <div className="section-head" style={{ padding: "14px 16px 0" }}><h3>Consumos registrados</h3></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Detalle</th><th className="right">Cantidad</th><th className="right">Coste (€)</th></tr></thead>
        <tbody>{consumos.slice(0, 40).map((m) => <tr key={String(m.id)}>
          <td>{String(m.created_at ?? "").replace("T", " ").slice(0, 16)}</td>
          <td>{String(m.usuario_nombre ?? "—")}</td>
          <td>{String(m.descripcion ?? "—")}</td>
          <td className="right">{formatNum(m.cantidad)}</td>
          <td className="right">{m.coste == null ? "—" : formatNum(Number(m.coste), 2)}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
  </>;
}
