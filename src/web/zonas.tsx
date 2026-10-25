import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Modal, Toast, camposConError } from "./ui";
import { QrLoteModal } from "./qr";

type Row = Record<string, unknown>;

// Nombre corto de un punto de consumo dentro de su zona (subzona › soporte).
const nombrePunto = (e: Row): string => {
  const partes = [e.subzona_nombre, e.soporte_nombre].filter((v): v is string => Boolean(v));
  return partes.join(" › ") || `Estación #${String(e.id)}`;
};

/**
 * Zonas y subzonas por centro (estilo de la web de referencia):
 * cada centro despliega sus zonas y, dentro, sus subzonas.
 * Altas, ediciones y borrados con el mismo CRUD modal del resto de secciones.
 */
export function ZonasCentroPage({ user }: { user: { rol: string } }) {
  const [centros, setCentros] = useState<Row[]>([]);
  const [zonas, setZonas] = useState<Row[]>([]);
  const [subzonas, setSubzonas] = useState<Row[]>([]);
  const [estaciones, setEstaciones] = useState<Row[]>([]);
  const [qrLote, setQrLote] = useState<{ zona: string; ests: Row[] } | null>(null);
  const [centroId, setCentroId] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ kind: "zona" | "subzona"; mode: "create" | "edit"; values: Row } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  // Campos que han fallado al validar (se sombrean en rojo).
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const canWrite = user.rol === "admin";

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [c, z, s, est] = await Promise.all([
        api.get<{ items: Row[] }>("/api/centros"),
        api.get<{ items: Row[] }>("/api/zonas"),
        api.get<{ items: Row[] }>("/api/subzonas"),
        api.get<{ items: Row[] }>("/api/estaciones"),
      ]);
      setCentros(c.items); setZonas(z.items); setSubzonas(s.items); setEstaciones(est.items);
    } catch (e) { setError(e instanceof Error ? e.message : "Error cargando zonas"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtradas = useMemo(
    () => zonas.filter((z) => centroId === "all" || String(z.centro_id) === centroId),
    [zonas, centroId],
  );
  const subsDe = (zonaId: number) => subzonas.filter((s) => String(s.zona_id) === String(zonaId));

  const openZona = (zona?: Row) => {
    setFormError(null);
    setCampoErr([]);
    setEditing({ kind: "zona", mode: zona ? "edit" : "create", values: zona ? { ...zona } : { nombre: "", notas: "", centro_id: centroId === "all" ? String(centros[0]?.id ?? "") : centroId } });
  };
  const openSub = (zona: Row, sub?: Row) => {
    setFormError(null);
    setCampoErr([]);
    setEditing({ kind: "subzona", mode: sub ? "edit" : "create", values: sub ? { ...sub } : { nombre: "", notas: "", zona_id: zona.id, zona_ref: zona.nombre } });
  };

  const save = async () => {
    if (!editing) return;
    setSaving(true); setFormError(null);
    const esZona = editing.kind === "zona";
    const endpoint = esZona ? "/api/zonas" : "/api/subzonas";
    const payload: Row = {
      nombre: String(editing.values.nombre ?? "").trim(),
      notas: String(editing.values.notas ?? "").trim() || null,
      ...(esZona ? { centro_id: Number(editing.values.centro_id) } : { zona_id: Number(editing.values.zona_id) }),
    };
    if (!payload.nombre) { setFormError("Revisa los campos marcados en rojo"); setCampoErr(["nombre"]); setSaving(false); return; }
    try {
      const etiqueta = esZona ? "Zona" : "Subzona";
      if (editing.mode === "create") { await api.post(endpoint, payload); setToast({ message: `${etiqueta} «${String(payload.nombre)}» creada`, kind: "ok" }); }
      else { await api.put(`${endpoint}/${String(editing.values.id)}`, payload); setToast({ message: `${etiqueta} «${String(payload.nombre)}» actualizada`, kind: "ok" }); }
      setEditing(null);
      await load();
    } catch (e) { const msg = e instanceof Error ? e.message : "No se pudo guardar"; setFormError(msg); setCampoErr(camposConError(msg, [{ clave: "nombre", etiqueta: "Nombre" }, { clave: "centro_id", etiqueta: "Centro" }, { clave: "zona_id", etiqueta: "Zona" }, { clave: "notas", etiqueta: "Notas" }])); }
    finally { setSaving(false); }
  };

  const remove = async (kind: "zona" | "subzona", row: Row) => {
    const etiqueta = kind === "zona" ? "la zona" : "la subzona";
    if (!window.confirm(`¿Eliminar ${etiqueta} «${String(row.nombre)}»? Esta acción no se puede deshacer.`)) return;
    try {
      await api.del(`${kind === "zona" ? "/api/zonas" : "/api/subzonas"}/${String(row.id)}`);
      setToast({ message: "Elemento eliminado", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };

  const nombreCentro = (id: unknown) => String(centros.find((c) => String(c.id) === String(id))?.nombre ?? "—");

  if (loading) return <div className="loading">Cargando zonas…</div>;
  if (error) return <div className="card empty">⚠️ {error}</div>;

  const nombreZona = editing?.kind === "subzona" && editing.values.zona_ref ? String(editing.values.zona_ref) : "";
  return <>
    <div className="toolbar no-print">
      <select className="input" style={{ maxWidth: 240 }} value={centroId} onChange={(e) => setCentroId(e.target.value)}>
        <option value="all">Todos los centros</option>
        {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <div className="spacer" />
      {canWrite && <button className="btn" onClick={() => openZona()}>＋ Nueva zona</button>}
    </div>

    {!filtradas.length
      ? <div className="card empty"><span className="icon">🗺️</span><strong>No hay zonas</strong><p>Pulsa «Nueva zona» para crear la primera zona de este centro.</p></div>
      : filtradas.map((z) => {
        const subs = subsDe(Number(z.id));
        const ests = estaciones.filter((e) => String(e.zona_id) === String(z.id));
        return <div className="card card-pad" key={String(z.id)}>
          <div className="section-head">
            <h3>🗺️ {String(z.nombre)}</h3>
            <div className="row-actions">
              <span className={`badge ${ests.length ? "info" : "muted"}`}>{ests.length} punto{ests.length === 1 ? "" : "s"} de consumo</span>
              <span className="badge muted">{nombreCentro(z.centro_id)}</span>
              {canWrite && <>
                <button className="btn secondary small" onClick={() => openZona(z)}>✏️ Editar</button>
                <button className="btn danger small" onClick={() => void remove("zona", z)}>🗑️ Borrar</button>
              </>}
            </div>
          </div>
          {z.notas ? <p style={{ color: "var(--muted)", margin: "0 0 10px" }}>{String(z.notas)}</p> : null}
          <div className="chips" style={{ marginBottom: canWrite ? 8 : 0 }}>
            {subs.map((s) => <span className="chip" key={String(s.id)} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 6px 4px 12px" }}>
              🧱 {String(s.nombre)}
              {canWrite && <>
                <button className="icon-btn" title="Editar subzona" onClick={() => openSub(z, s)}>✏️</button>
                <button className="icon-btn" title="Borrar subzona" onClick={() => void remove("subzona", s)}>🗑️</button>
              </>}
            </span>)}
            {!subs.length && <span style={{ color: "var(--muted)", fontSize: 13 }}>Sin subzonas todavía.</span>}
          </div>
          {ests.length > 0 && <div className="chips" style={{ marginBottom: canWrite ? 8 : 0 }}>
            {ests.map((e) => <a className="chip" key={String(e.id)} href={`#/estaciones?consumo=${String(e.id)}`}
              title={`Abrir el modo estación de ${nombrePunto(e)} · ${String(e.articulo_nombre ?? "")} (stock ${String(e.articulo_stock ?? 0)})`}>
              🚻 {nombrePunto(e)}
            </a>)}
          </div>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <a className="btn secondary small" href={`#/estaciones?zona=${String(z.id)}`}>🚻 Ver puntos de consumo{ests.length ? ` (${ests.length})` : ""}</a>
            {ests.length > 0 && <button className="btn secondary small" onClick={() => setQrLote({ zona: String(z.nombre), ests })}>🖨️ Imprimir QR de la zona</button>}
            {canWrite && <button className="btn secondary small" onClick={() => openSub(z)}>＋ Añadir subzona</button>}
          </div>
        </div>;
      })}

    {qrLote && <QrLoteModal
      items={qrLote.ests.map((e) => ({ id: Number(e.id), title: nombrePunto(e) }))}
      subtitle={`Zona ${qrLote.zona} · una etiqueta por estación`}
      onClose={() => setQrLote(null)} />}
    {editing && <Modal
      title={editing.mode === "create"
        ? (editing.kind === "zona" ? "Nueva zona" : `Nueva subzona · ${nombreZona}`)
        : (editing.kind === "zona" ? "Editar zona" : "Editar subzona")}
      subtitle="Centro → zona → subzona"
      onClose={() => setEditing(null)}
    >
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">
        <div className="full"><div className={"field" + (campoErr.includes("nombre") ? " error" : "")}>
          <label htmlFor="z-nombre">Nombre <span className="req">*</span></label>
          <input id="z-nombre" className={"input" + (campoErr.includes("nombre") ? " error" : "")} value={String(editing.values.nombre ?? "")} onChange={(e) => { setCampoErr(prev => prev.filter(k => k !== "nombre")); setEditing({ ...editing, values: { ...editing.values, nombre: e.target.value } }); }} autoFocus />
        </div></div>
        {editing.kind === "zona" && <div className="full"><div className={"field" + (campoErr.includes("centro_id") ? " error" : "")}>
          <label htmlFor="z-centro">Centro <span className="req">*</span></label>
          <select id="z-centro" className={"input" + (campoErr.includes("centro_id") ? " error" : "")} value={String(editing.values.centro_id ?? "")} onChange={(e) => { setCampoErr(prev => prev.filter(k => k !== "centro_id")); setEditing({ ...editing, values: { ...editing.values, centro_id: e.target.value } }); }} disabled={editing.mode === "edit"}>
            {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
          </select>
          {editing.mode === "edit" && <small>El centro de una zona no se puede cambiar; créala de nuevo si necesitas moverla.</small>}
        </div></div>}
        <div className="full"><div className="field">
          <label htmlFor="z-notas">Notas</label>
          <textarea id="z-notas" className="input" rows={3} value={String(editing.values.notas ?? "")} onChange={(e) => setEditing({ ...editing, values: { ...editing.values, notas: e.target.value } })} />
        </div></div>
      </div>
      <div className="modal-footer">
        <button className="btn secondary" onClick={() => setEditing(null)}>Cancelar</button>
        <button className="btn" onClick={() => void save()} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
      </div>
    </Modal>}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
