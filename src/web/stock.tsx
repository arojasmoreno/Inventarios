import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Toast, formatNum } from "./ui";

type Row = Record<string, unknown>;

const RECURSOS = [
  { key: "quimicos", endpoint: "/api/quimicos", label: "Productos químicos", stockKey: "num_garrafas", unidad: "garrafas" },
  { key: "material_limpieza", endpoint: "/api/material-limpieza", label: "Material de limpieza", stockKey: "cantidad", unidad: "unidades" },
  { key: "epis", endpoint: "/api/epis", label: "EPIs", stockKey: "stock", unidad: "uds." },
  { key: "ropa_trabajo", endpoint: "/api/ropa-trabajo", label: "Ropa de trabajo", stockKey: "stock", unidad: "uds." },
] as const;

/** Entradas, salidas y ajustes de stock (solo administradores). */
export function StockPage() {
  const [recurso, setRecurso] = useState<string>(RECURSOS[0].key);
  const [items, setItems] = useState<Row[]>([]);
  const [movimientos, setMovimientos] = useState<Row[]>([]);
  const [itemId, setItemId] = useState("");
  const [tipo, setTipo] = useState<"entrada" | "salida" | "ajuste">("entrada");
  const [cantidad, setCantidad] = useState("1");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const cfg = RECURSOS.find((r) => r.key === recurso) ?? RECURSOS[0];
  const load = useCallback(async () => {
    try {
      const [l, m] = await Promise.all([
        api.get<{ items: Row[] }>(cfg.endpoint),
        api.get<{ items: Row[] }>("/api/movimientos"),
      ]);
      setItems(l.items); setMovimientos(m.items.slice(0, 15));
    } catch { setError("No se pudieron cargar los datos"); }
  }, [cfg.endpoint]);
  useEffect(() => { void load(); }, [load]);

  const item = items.find((i) => String(i.id) === itemId);
  const costeUnit = Number(item?.coste_unitario ?? 0) || 0;
  const n = Number(cantidad);
  const costeEstimado = tipo === "ajuste" ? null : costeUnit * (Number.isFinite(n) ? n : 0);

  const submit = async () => {
    if (!item) { setError("Elige un registro"); return; }
    setError(null); setMsg(null); setBusy(true);
    try {
      const r = await api.post<{ mensaje?: string }>("/api/movimientos/ajuste", { recurso, id: Number(item.id), tipo, cantidad: n, motivo: motivo || null });
      setMsg(r.mensaje ?? "Movimiento registrado");
      setMotivo(""); setCantidad("1");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo registrar el movimiento"); }
    finally { setBusy(false); }
  };

  return <>
    <div className="card card-pad" style={{ maxWidth: 720 }}>
      <div className="section-head"><h3>Entradas / Salidas</h3></div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Entradas, salidas y ajustes de stock con motivo y coste. El coste usa el coste unitario de cada producto.</p>
      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      {msg && <div className="banner" style={{ marginBottom: 12 }}>{msg}</div>}
      <div className="form-grid">
        <div><div className="field"><label htmlFor="st-rec">Recurso</label>
          <select id="st-rec" className="input" value={recurso} onChange={(e) => { setRecurso(e.target.value); setItemId(""); }}>
            {RECURSOS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select></div></div>
        <div><div className="field"><label htmlFor="st-item">Registro</label>
          <select id="st-item" className="input" value={itemId} onChange={(e) => setItemId(e.target.value)}>
            <option value="">— Elige —</option>
            {items.map((i) => <option key={String(i.id)} value={String(i.id)}>{String(i.codigo ? `${i.codigo} · ` : "")}{String(i.nombre ?? i.prenda ?? i.descripcion ?? i.id)}</option>)}
          </select></div></div>
        <div><div className="field"><label htmlFor="st-tipo">Tipo de movimiento</label>
          <select id="st-tipo" className="input" value={tipo} onChange={(e) => setTipo(e.target.value as typeof tipo)}>
            <option value="entrada">Entrada (+)</option>
            <option value="salida">Salida (−)</option>
            <option value="ajuste">Ajuste (fija el stock)</option>
          </select></div></div>
        <div style={{ maxWidth: 140 }}><div className="field"><label htmlFor="st-cant">Cantidad</label>
          <input id="st-cant" className="input" type="number" min={0} step={1} value={cantidad} onChange={(e) => setCantidad(e.target.value)} /></div></div>
        <div className="full"><div className="field"><label htmlFor="st-motivo">Motivo (opcional)</label>
          <input id="st-motivo" className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Recepción de pedido, merma, recuento…" /></div></div>
      </div>
      <p style={{ color: "var(--muted)", margin: "0 0 12px" }}>
        {item ? <>Stock actual: <strong>{formatNum(item[cfg.stockKey])}</strong> {cfg.unidad}{costeEstimado !== null && <> · Coste estimado: <strong>{formatNum(costeEstimado, 2)} €</strong></>}</> : "Selecciona un registro para ver su stock y coste."}
      </p>
      <div className="modal-footer"><button className="btn" onClick={() => void submit()} disabled={busy || !item}>{busy ? "Registrando…" : "Registrar movimiento"}</button></div>
    </div>
    <div className="card">
      <div className="section-head" style={{ padding: "14px 16px 0" }}><h3>Últimos movimientos</h3></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Tipo</th><th>Detalle</th><th className="right">Cant.</th><th className="right">Coste (€)</th></tr></thead>
        <tbody>{movimientos.map((m) => <tr key={String(m.id)}>
          <td>{String(m.created_at ?? "").replace("T", " ").slice(0, 16)}</td>
          <td>{String(m.usuario_nombre ?? "—")}</td>
          <td><span className={`badge ${String(m.accion) === "consumo" ? "info" : String(m.accion) === "entrada" ? "ok" : "warn"}`}>{String(m.accion ?? "—").replaceAll("_", " ")}</span></td>
          <td>{String(m.descripcion ?? "—")}</td>
          <td className="right">{m.cantidad == null ? "—" : formatNum(m.cantidad)}</td>
          <td className="right">{m.coste == null ? "—" : formatNum(Number(m.coste), 2)}</td>
        </tr>)}</tbody>
      </table></div>
    </div>
    {msg && <Toast message={msg} kind="ok" onClose={() => setMsg(null)} />}
  </>;
}
