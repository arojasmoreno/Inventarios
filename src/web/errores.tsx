import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { downloadCsv, formatNum, Modal, Toast } from "./ui";

type Row = Record<string, unknown>;

const fecha = (v: unknown): string => String(v ?? "").replace("T", " ").slice(0, 19) || "—";
const etiquetaOrigen = (v: unknown): string => {
  const s = String(v ?? "");
  return s === "servidor" ? "Servidor" : s === "api" ? "Petición API" : s === "importar" ? "Importación CSV"
    : s === "cliente" ? "Navegador" : s || "—";
};

/** Histórico de errores de la aplicación: fallos del servidor, peticiones
 *  fallidas del navegador y problemas al importar CSV. Solo administradores. */
export function ErroresPage({ user }: { user: { rol: string } }) {
  const [items, setItems] = useState<Row[]>([]);
  const [grupos, setGrupos] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [nivel, setNivel] = useState("all");
  const [origen, setOrigen] = useState("all");
  const [q, setQ] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<Row | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const esAdmin = user.rol === "admin";

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const qs = new URLSearchParams({ nivel, origen, limite: "300" });
    if (q.trim()) qs.set("q", q.trim());
    if (desde) qs.set("desde", desde);
    if (hasta) qs.set("hasta", hasta);
    try {
      const r = await api.get<{ items: Row[]; total: number; grupos?: Row[] }>(`/api/errores?${qs.toString()}`);
      setItems(r.items); setTotal(r.total); setGrupos(r.grupos ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el histórico de errores");
    } finally { setLoading(false); }
  }, [nivel, origen, q, desde, hasta]);
  useEffect(() => { void load(); }, [load]);

  const resumen = useMemo(() => ({
    errores: items.filter(r => String(r.nivel) === "error").length,
    avisos: items.filter(r => String(r.nivel) === "aviso").length,
  }), [items]);

  const borrar = async (row: Row) => {
    if (!window.confirm("¿Eliminar esta entrada del histórico?")) return;
    try {
      await api.del(`/api/errores/${String(row.id)}`);
      setToast({ message: "Error eliminado del histórico", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };
  const vaciar = async () => {
    if (!window.confirm("Se borrará todo el histórico de errores. ¿Continuar?")) return;
    try {
      await api.del("/api/errores");
      setToast({ message: "Histórico vaciado", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo vaciar", kind: "error" }); }
  };
  const exportar = () => downloadCsv(
    `errores-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Fecha", "Nivel", "Origen", "Método", "Ruta", "Usuario", "Mensaje", "Detalle"],
    items.map(r => [fecha(r.fecha), String(r.nivel ?? ""), etiquetaOrigen(r.origen),
      String(r.metodo ?? ""), String(r.ruta ?? ""), String(r.usuario ?? ""),
      String(r.mensaje ?? ""), String(r.detalle ?? "")]),
  );

  return <>
    <div className="toolbar no-print" style={{ flexWrap: "wrap" }}>
      <input className="input" style={{ maxWidth: 240 }} placeholder="🔍 Buscar en los errores…" value={q} onChange={e => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 160 }} aria-label="Nivel" value={nivel} onChange={e => setNivel(e.target.value)}>
        <option value="all">Todos los niveles</option>
        <option value="error">Errores</option>
        <option value="aviso">Avisos</option>
      </select>
      <select className="input" style={{ maxWidth: 190 }} aria-label="Origen" value={origen} onChange={e => setOrigen(e.target.value)}>
        <option value="all">Cualquier origen</option>
        <option value="servidor">Servidor</option>
        <option value="api">Petición API</option>
        <option value="cliente">Navegador</option>
        <option value="importar">Importación CSV</option>
      </select>
      <input className="input" style={{ maxWidth: 160 }} type="date" aria-label="Desde" value={desde} onChange={e => setDesde(e.target.value)} />
      <input className="input" style={{ maxWidth: 160 }} type="date" aria-label="Hasta" value={hasta} onChange={e => setHasta(e.target.value)} />
      <div className="spacer" />
      <button className="btn secondary" onClick={() => void load()}>🔄 Actualizar</button>
      <button className="btn secondary" onClick={exportar} disabled={!items.length}>⬇️ CSV</button>
      {esAdmin && <button className="btn danger" onClick={() => void vaciar()} disabled={!total}>🗑️ Vaciar histórico</button>}
    </div>

    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

    <div className="card" style={{ marginBottom: 12 }}>
      <div className="card-pad" style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "center" }}>
        <span className="badge danger">🔴 {formatNum(resumen.errores)} errores</span>
        <span className="badge warn">🟡 {formatNum(resumen.avisos)} avisos</span>
        <span style={{ color: "var(--muted)", fontSize: 13 }}>
          {formatNum(total)} registros en total · se muestran los últimos {formatNum(items.length)}
        </span>
      </div>
    </div>

    {grupos.length > 0 && <div className="card card-pad" style={{ marginBottom: 12 }}>
      <div className="section-head"><h3>🔁 Errores repetidos</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Los que más se repiten en el filtro actual</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th className="right">Veces</th><th>Mensaje</th><th>Origen</th><th>Última vez</th></tr></thead>
        <tbody>{grupos.map((g, i) => <tr key={i}>
          <td className="right"><span className="badge danger">{formatNum(g.veces)}</span></td>
          <td>{String(g.mensaje ?? "—")}</td>
          <td><span className="badge muted">{etiquetaOrigen(g.origen)}</span></td>
          <td style={{ whiteSpace: "nowrap" }}>{fecha(g.ultimo)}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}

    <div className="card">
      {loading ? <div className="loading">Cargando histórico…</div>
        : !items.length ? <div className="empty"><span className="icon">✅</span><strong>Sin errores registrados</strong><p>Aquí irán apareciendo los fallos del servidor, las peticiones que devuelvan error y los problemas al importar CSV.</p></div>
        : <div className="table-scroll"><table>
          <thead><tr><th>Fecha</th><th>Nivel</th><th>Origen</th><th>Ruta</th><th>Usuario</th><th>Mensaje</th><th className="right">Acciones</th></tr></thead>
          <tbody>{items.map(r => {
            const n = String(r.nivel ?? "error");
            return <tr key={String(r.id)}>
              <td style={{ whiteSpace: "nowrap" }}>{fecha(r.fecha)}</td>
              <td><span className={`badge ${n === "aviso" ? "warn" : "danger"}`}>{n === "aviso" ? "Aviso" : "Error"}</span></td>
              <td><span className="badge muted">{etiquetaOrigen(r.origen)}</span></td>
              <td style={{ fontSize: 12.5 }}>{r.metodo ? `${String(r.metodo)} ` : ""}{String(r.ruta ?? "—")}</td>
              <td>{String(r.usuario ?? "—")}</td>
              <td style={{ maxWidth: 420 }}>{String(r.mensaje ?? "—")}</td>
              <td className="right"><div className="row-actions">
                <button className="btn secondary small" onClick={() => setDetalle(r)}>🔍 Detalle</button>
                {esAdmin && <button className="btn danger small" onClick={() => void borrar(r)}>🗑️</button>}
              </div></td>
            </tr>;
          })}</tbody></table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      Histórico de errores: fallos del servidor, peticiones rechazadas por la API y filas de CSV que no se pudieron importar.
    </p>

    {detalle && <Modal title="Detalle del error" subtitle={fecha(detalle.fecha)} onClose={() => setDetalle(null)} wide>
      <div className="form-grid">
        <div><div className="field"><label>Nivel</label><div><span className={`badge ${String(detalle.nivel) === "aviso" ? "warn" : "danger"}`}>{String(detalle.nivel ?? "error")}</span></div></div></div>
        <div><div className="field"><label>Origen</label><div>{etiquetaOrigen(detalle.origen)}</div></div></div>
        <div><div className="field"><label>Petición</label><div>{String(detalle.metodo ?? "—")} {String(detalle.ruta ?? "")}</div></div></div>
        <div><div className="field"><label>Usuario</label><div>{String(detalle.usuario ?? "—")}</div></div></div>
        <div className="full"><div className="field"><label>Mensaje</label><div style={{ whiteSpace: "pre-wrap" }}>{String(detalle.mensaje ?? "—")}</div></div></div>
        {detalle.detalle ? <div className="full"><div className="field"><label>Detalle técnico</label>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, background: "var(--bg-soft, #f8fafc)", padding: 10, borderRadius: 8, overflow: "auto", maxHeight: 320 }}>{String(detalle.detalle)}</pre>
        </div></div> : null}
      </div>
      <div className="modal-footer"><button className="btn secondary" onClick={() => setDetalle(null)}>Cerrar</button></div>
    </Modal>}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
