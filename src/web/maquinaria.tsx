import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Modal, Toast, formatFecha } from "./ui";
import { MAQUINARIA, ResourcePage, SITUACIONES, TIPOS } from "./resources";

type Row = Record<string, unknown>;
type Tab = "maquinaria" | "historial" | "situaciones" | "tipos";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "maquinaria", label: "Maquinaria", icon: "🧭" },
  { id: "historial", label: "Histórico", icon: "🕘" },
  { id: "situaciones", label: "Situaciones", icon: "🧾" },
  { id: "tipos", label: "Tipos de máquina", icon: "🧩" },
];

const hoy = () => new Date().toISOString().slice(0, 10);

// Badge de una situación (los colores siguen al nombre de la situación).
const sitBadge = (nombre: unknown) => {
  const e = String(nombre ?? "");
  const cls = e === "Operativo" ? "ok" : e === "En reparación" ? "warn" : e === "Averiado" ? "danger" : e === "Baja" ? "muted" : "info";
  return <span className={`badge ${cls}`}>{e || "—"}</span>;
};

/** Sección «Control de maquinaria»: la tabla de máquinas (solo sus datos y
 *  ubicación), el histórico de situaciones (fecha + situación, marca, modelo y
 *  centro; de ahí sale el estado actual) y el catálogo de situaciones. */
export function MaquinariaPage({ user }: { user: { rol: string; centro_id: number | null } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const [tab, setTab] = useState<Tab>(hash === "#/tipos" ? "tipos" : "maquinaria");

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      {TABS.map(t => (
        <button key={t.id} className={"btn" + (tab === t.id ? "" : " secondary")} onClick={() => setTab(t.id)}>
          {t.icon} {t.label}
        </button>
      ))}
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        El estado de cada máquina es su último registro del histórico
      </span>
    </div>
    {tab === "maquinaria" && <ResourcePage key="maquinaria" config={MAQUINARIA} user={user} />}
    {tab === "historial" && <HistorialMaquinaria key="historial" user={user} />}
    {tab === "situaciones" && <ResourcePage key="situaciones" config={SITUACIONES} user={user} />}
    {tab === "tipos" && <ResourcePage key="tipos" config={TIPOS} user={user} />}
  </>;
}

/** Histórico de situaciones: registro por máquina con fecha, situación,
 *  marca, modelo y centro, con borrado (que recalcula el estado). */
function HistorialMaquinaria({ user }: { user: { rol: string } }) {
  const admin = user.rol === "admin";
  const [items, setItems] = useState<Row[]>([]);
  const [maquinas, setMaquinas] = useState<Row[]>([]);
  const [situaciones, setSituaciones] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [maquinaId, setMaquinaId] = useState("all");
  const [form, setForm] = useState<Row | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems((await api.get<{ items: Row[] }>("/api/maquinaria-historial")).items); }
    catch (e) { setError(e instanceof Error ? e.message : "Error cargando el histórico"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    void Promise.all([
      api.get<{ items: Row[] }>("/api/maquinaria").then(r => setMaquinas(r.items)).catch(() => setMaquinas([])),
      api.get<{ items: Row[] }>("/api/situaciones").then(r => setSituaciones(r.items)).catch(() => setSituaciones([])),
      api.get<{ items: Row[] }>("/api/centros").then(r => setCentros(r.items)).catch(() => setCentros([])),
    ]);
  }, []);

  const filtered = (() => {
    const needle = q.trim().toLowerCase();
    return items.filter(r =>
      (maquinaId === "all" || String(r.maquina_id) === maquinaId) &&
      (!needle || ["maquina_nombre", "numero_serie", "tipo", "situacion_nombre", "marca", "modelo", "centro_nombre"]
        .some(k => String(r[k] ?? "").toLowerCase().includes(needle))));
  })();

  const openForm = () => { setFormError(null); setForm({ maquina_id: "", fecha: hoy(), situacion_id: "", marca: "", modelo: "", centro_id: "" }); };
  // Al elegir otra máquina se precargan sus marca, modelo y centro.
  const elegirMaquina = (id: string) => {
    const m = maquinas.find(x => String(x.id) === id);
    setForm(prev => prev ? {
      ...prev, maquina_id: id,
      marca: String(m?.marca ?? ""), modelo: String(m?.modelo ?? ""),
      centro_id: m?.centro_id == null ? "" : String(m.centro_id),
    } : prev);
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setSaving(true); setFormError(null);
    try {
      await api.post("/api/maquinaria-historial", {
        maquina_id: Number(form.maquina_id),
        fecha: String(form.fecha || ""),
        situacion_id: Number(form.situacion_id),
        marca: String(form.marca || "").trim() || null,
        modelo: String(form.modelo || "").trim() || null,
        centro_id: form.centro_id === "" ? null : Number(form.centro_id),
      });
      setForm(null); setToast({ message: "Situación registrada", kind: "ok" });
      await load();
    } catch (err) { setFormError(err instanceof Error ? err.message : "No se pudo registrar la situación"); }
    finally { setSaving(false); }
  };
  const remove = async (row: Row) => {
    if (!window.confirm(`¿Eliminar el registro «${String(row.situacion_nombre)}» de «${String(row.maquina_nombre ?? "la máquina")}»?`)) return;
    try {
      await api.del(`/api/maquinaria-historial/${String(row.id)}`);
      setToast({ message: "Registro eliminado", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };

  return <>
    <div className="toolbar no-print">
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar…" value={q} onChange={e => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 240 }} value={maquinaId} onChange={e => setMaquinaId(e.target.value)} aria-label="Filtrar por máquina">
        <option value="all">Todas las máquinas</option>
        {maquinas.map(m => <option key={String(m.id)} value={String(m.id)}>{String(m.nombre ?? `#${String(m.id)}`)}</option>)}
      </select>
      <div className="spacer" />
      {admin && <button className="btn" onClick={openForm}>＋ Registrar situación</button>}
    </div>
    <div className="card">
      {loading ? <div className="loading">Cargando…</div>
        : error ? <div className="empty">⚠️ {error}</div>
        : !filtered.length ? <div className="empty"><span className="icon">🕘</span><strong>Sin registros</strong><p>Pulsa «Registrar situación» para añadir el primero.</p></div>
        : <div className="table-scroll"><table>
            <thead><tr>
              <th>Fecha</th><th>Máquina</th><th>Situación</th><th>Marca</th><th>Modelo</th><th>Centro</th>
              {admin && <th className="right">Acciones</th>}
            </tr></thead>
            <tbody>{filtered.map(r => <tr key={String(r.id)}>
              <td>{formatFecha(String(r.fecha ?? ""))}</td>
              <td>{String(r.maquina_nombre ?? "—")}{r.numero_serie ? <span style={{ color: "var(--muted)" }}> · {String(r.numero_serie)}</span> : null}</td>
              <td>{sitBadge(r.situacion_nombre)}</td>
              <td>{String(r.marca ?? "—")}</td>
              <td>{String(r.modelo ?? "—")}</td>
              <td>{String(r.centro_nombre ?? "—")}</td>
              {admin && <td className="right"><div className="row-actions"><button className="btn danger small" onClick={() => void remove(r)}>🗑️ Borrar</button></div></td>}
            </tr>)}</tbody>
          </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {filtered.length} de {items.length} registros · fecha, situación, marca, modelo y centro de cada cambio
    </p>

    {form && <Modal title="Registrar situación" subtitle="Pasa a ser el estado actual de la máquina" onClose={() => setForm(null)}>
      {formError && <div className="form-error">{formError}</div>}
      <form onSubmit={save}>
        <div className="form-grid">
          <div className="full field">
            <label>Máquina<span className="req">*</span></label>
            <select className="input" value={String(form.maquina_id)} onChange={e => elegirMaquina(e.target.value)} required>
              <option value="">Elige una máquina…</option>
              {maquinas.map(m => <option key={String(m.id)} value={String(m.id)}>{String(m.nombre ?? `#${String(m.id)}`)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Fecha<span className="req">*</span></label>
            <input className="input" type="date" value={String(form.fecha)} onChange={e => setForm({ ...form, fecha: e.target.value })} required />
          </div>
          <div className="field">
            <label>Situación<span className="req">*</span></label>
            <select className="input" value={String(form.situacion_id)} onChange={e => setForm({ ...form, situacion_id: e.target.value })} required>
              <option value="">Elige una situación…</option>
              {situaciones.map(s => <option key={String(s.id)} value={String(s.id)}>{String(s.nombre)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Marca</label>
            <input className="input" value={String(form.marca)} onChange={e => setForm({ ...form, marca: e.target.value })} placeholder="Se precarga de la máquina" />
          </div>
          <div className="field">
            <label>Modelo</label>
            <input className="input" value={String(form.modelo)} onChange={e => setForm({ ...form, modelo: e.target.value })} placeholder="Se precarga de la máquina" />
          </div>
          <div className="full field">
            <label>Centro</label>
            <select className="input" value={String(form.centro_id)} onChange={e => setForm({ ...form, centro_id: e.target.value })}>
              <option value="">El de la máquina</option>
              {centros.map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
            </select>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn secondary" onClick={() => setForm(null)}>Cancelar</button>
          <button className="btn" disabled={saving}>{saving ? "Guardando…" : "Registrar"}</button>
        </div>
      </form>
    </Modal>}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
