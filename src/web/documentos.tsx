import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api";
import { Toast } from "./ui";

type Row = Record<string, unknown>;

// Paleta de badges por tipo de ficha (rotativa, tonos del Doc Manager).
const BADGE_CLASSES = ["d-ok", "d-info", "d-warn", "d-violet", "d-rose", "d-teal"];

const fechaCorta = (v: unknown): string => String(v ?? "").replace("T", " ").slice(0, 16);
const nombreCentros = (r: Row): string[] =>
  String(r.centros_nombre ?? "").split(",").filter(Boolean);

/**
 * Sección «Documentación»: catálogo de fichas (seguridad, técnicas, manuales de
 * maquinaria, instrucciones de trabajo) con filtro por tipo y búsqueda profunda.
 * Administradores y administradores de centros hacen CRUD; el resto solo lee.
 */
export function DocumentosPage({ user }: { user: { rol: string } }) {
  const canManage = user.rol === "admin" || user.rol === "admin_centros";

  const [items, setItems] = useState<Row[]>([]);
  const [tipos, setTipos] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [fTipo, setFTipo] = useState("all");
  const [fCentro, setFCentro] = useState("all");

  const [editing, setEditing] = useState<Row | null | "new">(null);
  const [nuevoTipo, setNuevoTipo] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  // Búsqueda profunda con debounce (la hace el backend sobre todos los campos).
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams();
      if (qDebounced) params.set("q", qDebounced);
      if (fTipo !== "all") params.set("tipo_id", fTipo);
      if (fCentro !== "all") params.set("centro_id", fCentro);
      const qs = params.toString();
      const r = await api.get<{ items: Row[] }>(`/api/documentos${qs ? `?${qs}` : ""}`);
      setItems(r.items);
    } catch (e) { setError(e instanceof Error ? e.message : "Error cargando las fichas"); }
    finally { setLoading(false); }
  }, [qDebounced, fTipo, fCentro]);
  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    Promise.all([
      api.get<{ items: Row[] }>("/api/documentos-tipos"),
      api.get<{ items: Row[] }>("/api/centros"),
    ]).then(([t, c]) => { setTipos(t.items); setCentros(c.items); })
      .catch(() => { /* los filtros siguen funcionando vacíos */ });
  }, []);

  const tipoColor = useCallback((tipoId: unknown) => {
    const idx = tipos.findIndex((t) => String(t.id) === String(tipoId));
    return BADGE_CLASSES[(idx < 0 ? 0 : idx) % BADGE_CLASSES.length];
  }, [tipos]);

  const remove = async (row: Row) => {
    if (!window.confirm(`¿Eliminar la ficha «${String(row.nombre)}»? Esta acción no se puede deshacer.`)) return;
    try {
      await api.del(`/api/documentos/${String(row.id)}`);
      setToast({ message: "Ficha eliminada", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };

  const conFiltros = Boolean(qDebounced) || fTipo !== "all" || fCentro !== "all";

  return <div className="docs">
    <div className="docs-head">
      <div>
        <h2>📚 Documentación</h2>
        <p>Fichas de seguridad, fichas técnicas, manuales de maquinaria e instrucciones de trabajo, por centro.</p>
      </div>
      {canManage && <button className="d-btn" onClick={() => setEditing("new")}>＋ Nueva ficha</button>}
    </div>

    <div className="docs-toolbar">
      <input className="d-input d-search" placeholder="🔍 Buscar en todas las fichas…"
        value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar fichas" />
      <select className="d-input" value={fTipo} onChange={(e) => setFTipo(e.target.value)} aria-label="Filtrar por tipo de ficha">
        <option value="all\">Todos los tipos</option>
        {tipos.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.nombre)}</option>)}
      </select>
      <select className="d-input" value={fCentro} onChange={(e) => setFCentro(e.target.value)} aria-label="Filtrar por centro">
        <option value="all\">Todos los centros</option>
        {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <span className="docs-count">{loading ? "…" : `${items.length} ficha${items.length === 1 ? "" : "s"}`}</span>
    </div>

    {error && <div className="docs-error">⚠️ {error}</div>}
    {loading
      ? <div className="docs-empty">Cargando fichas…</div>
      : !items.length
        ? <div className="docs-empty">
            <span className="icon">📄</span>
            <strong>{conFiltros ? "Ninguna ficha coincide con la búsqueda" : "No hay fichas todavía"}</strong>
            <p>{canManage
              ? (conFiltros ? "Prueba con otra búsqueda u otro tipo." : "Pulsa «Nueva ficha» para añadir la primera al catálogo.")
              : (conFiltros ? "Prueba con otra búsqueda u otro tipo." : "Todavía no hay fichas asignadas a tus centros.")}</p>
          </div>
        : <div className="docs-table-wrap"><table className="docs-table">
          <thead><tr>
            <th>Tipo</th><th>Ficha</th><th>Centros</th><th>Fabricante</th><th>Documento</th><th>Actualizado</th>
            {canManage && <th className="right">Acciones</th>}
          </tr></thead>
          <tbody>{items.map((r) => <tr key={String(r.id)}>
            <td><span className={`d-badge ${tipoColor(r.tipo_id)}`}>{String(r.tipo_nombre ?? "—")}</span></td>
            <td><div className="docs-nombre">{String(r.nombre)}</div>
              {r.descripcion ? <div className="docs-desc">{String(r.descripcion)}</div> : null}</td>
            <td><div className="docs-chips">{nombreCentros(r).map((cn) => <span className="d-chip" key={cn}>{cn}</span>)}</div></td>
            <td>{r.fabricante ? String(r.fabricante) : <span className="muted">—</span>}</td>
            <td><a className="docs-link" href={String(r.url)} target="_blank" rel="noreferrer">Abrir ↗</a></td>
            <td className="docs-fecha">{fechaCorta(r.updated_at ?? r.created_at)}</td>
            {canManage && <td className="right"><div className="row-actions">
              <button className="d-btn ghost small" onClick={() => setEditing(r)}>✏️ Editar</button>
              <button className="d-btn danger small" onClick={() => void remove(r)}>🗑️ Borrar</button>
            </div></td>}
          </tr>)}</tbody>
        </table></div>}
    <p className="docs-foot">{loading ? "" : `${items.length} de ${items.length} fichas visibles · ${conFiltros ? "con filtros aplicados" : "catálogo completo"}`}</p>

    {editing && <FichaForm
      initial={editing === "new" ? null : editing}
      tipos={tipos}
      centros={centros}
      onClose={() => setEditing(null)}
      onNuevoTipo={() => setNuevoTipo(true)}
      onSaved={async (msg) => { setEditing(null); setToast({ message: msg, kind: "ok" }); await load(); }}
    />}
    {nuevoTipo && <NuevoTipoModal
      onClose={() => setNuevoTipo(false)}
      onCreated={async (nombre) => {
        setNuevoTipo(false);
        setToast({ message: `Tipo «${nombre}» creado`, kind: "ok" });
        const t = await api.get<{ items: Row[] }>("/api/documentos-tipos");
        setTipos(t.items);
      }}
    />}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </div>;
}

// ------------------------------------------------------------ Modal de ficha
function FichaForm({ initial, tipos, centros, onClose, onSaved, onNuevoTipo }: {
  initial: Row | null;
  tipos: Row[];
  centros: Row[];
  onClose: () => void;
  onNuevoTipo: () => void;
  onSaved: (msg: string) => void;
}) {
  const [nombre, setNombre] = useState(initial ? String(initial.nombre ?? "") : "");
  const [tipoId, setTipoId] = useState(initial ? String(initial.tipo_id ?? "") : "");
  const [selCentros, setSelCentros] = useState<Set<number>>(() =>
    new Set(String(initial?.centros_ids ?? "").split(",").filter(Boolean).map(Number)));
  const [url, setUrl] = useState(initial ? String(initial.url ?? "") : "");
  const [descripcion, setDescripcion] = useState(initial ? String(initial.descripcion ?? "") : "");
  const [fabricante, setFabricante] = useState(initial ? String(initial.fabricante ?? "") : "");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const toggleCentro = (id: number) => setSelCentros((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!nombre.trim()) { setFormError("El nombre de la ficha es obligatorio"); return; }
    if (!tipoId) { setFormError("Elige el tipo de ficha"); return; }
    if (!selCentros.size) { setFormError("Marca al menos un centro donde se usa la ficha"); return; }
    if (!/^https?:\/\/\S+$/i.test(url.trim())) { setFormError("La URL del documento debe empezar por http:// o https://"); return; }
    setSaving(true);
    try {
      const payload = {
        nombre: nombre.trim(),
        tipo_id: Number(tipoId),
        url: url.trim(),
        descripcion: descripcion.trim() || null,
        fabricante: fabricante.trim() || null,
        centros: [...selCentros],
      };
      if (initial) { await api.put(`/api/documentos/${String(initial.id)}`, payload); onSaved("Ficha actualizada"); }
      else { await api.post("/api/documentos", payload); onSaved("Ficha añadida al catálogo"); }
    } catch (err) { setFormError(err instanceof Error ? err.message : "No se pudo guardar la ficha"); }
    finally { setSaving(false); }
  };

  return <div className="docs-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="docs-modal" onSubmit={submit} role="dialog" aria-modal="true">
      <div className="docs-modal-head">
        <div>
          <h3>{initial ? "Editar ficha" : "Nueva ficha"}</h3>
          <p>Añade un documento al catálogo y asígnalo a los centros donde se utiliza.</p>
        </div>
        <button type="button" className="d-icon-btn" onClick={onClose} aria-label="Cerrar">✕</button>
      </div>
      <div className="docs-modal-body">
        {formError && <div className="docs-form-error">{formError}</div>}
        <label className="d-label" htmlFor="f-nombre">Nombre de la ficha</label>
        <input id="f-nombre" className="d-input" autoFocus placeholder="Disolvente industrial — revisión 2"
          value={nombre} onChange={(e) => setNombre(e.target.value)} />

        <label className="d-label" htmlFor="f-tipo">Tipo de ficha</label>
        <div className="d-tipo-row">
          <select id="f-tipo" className="d-input" value={tipoId} onChange={(e) => setTipoId(e.target.value)}>
            <option value="">— Elige un tipo —</option>
            {tipos.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.nombre)}</option>)}
          </select>
          <button type="button" className="d-btn ghost" onClick={onNuevoTipo} title="Crear un nuevo tipo de ficha">＋ Nuevo tipo</button>
        </div>

        <label className="d-label">Centro al que pertenece</label>
        <div className="docs-chips">{centros.map((c) => {
          const id = Number(c.id);
          return <button type="button" key={id} className={"d-chip toggle" + (selCentros.has(id) ? " on" : "")}
            onClick={() => toggleCentro(id)} aria-pressed={selCentros.has(id)}>{String(c.nombre)}</button>;
        })}</div>
        <p className="d-hint">Cada persona verá esta ficha si su centro está marcado aquí.</p>

        <label className="d-label" htmlFor="f-url">Documento</label>
        <input id="f-url" className="d-input" placeholder="https://… enlace a la ficha"
          value={url} onChange={(e) => setUrl(e.target.value)} />
        <p className="d-hint">Pega la URL donde consultar el documento (PDF del fabricante, intranet, etc.).</p>

        <div className="d-two">
          <div>
            <label className="d-label" htmlFor="f-desc">Producto o equipo (opcional)</label>
            <input id="f-desc" className="d-input" placeholder="Tornillo de bancada 400 V"
              value={descripcion} onChange={(e) => setDescripcion(e.target.value)} />
          </div>
          <div>
            <label className="d-label" htmlFor="f-fab">Fabricante (opcional)</label>
            <input id="f-fab" className="d-input" placeholder="Nombre del fabricante"
              value={fabricante} onChange={(e) => setFabricante(e.target.value)} />
          </div>
        </div>
      </div>
      <div className="docs-modal-foot">
        <button type="button" className="d-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="submit" className="d-btn" disabled={saving}>{saving ? "Guardando…" : initial ? "Guardar cambios" : "Añadir ficha"}</button>
      </div>
    </form>
  </div>;
}

// ---------------------------------------------------------- Modal de tipo nuevo
function NuevoTipoModal({ onClose, onCreated }: { onClose: () => void; onCreated: (nombre: string) => void }) {
  const [nombre, setNombre] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = nombre.trim();
    if (!n) { setFormError("Escribe el nombre del tipo"); return; }
    setSaving(true); setFormError(null);
    try {
      await api.post("/api/documentos-tipos", { nombre: n });
      onCreated(n);
    } catch (err) { setFormError(err instanceof Error ? err.message : "No se pudo crear el tipo"); }
    finally { setSaving(false); }
  };
  return <div className="docs-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
    <form className="docs-modal small" onSubmit={submit} role="dialog" aria-modal="true">
      <div className="docs-modal-head">
        <div>
          <h3>Nuevo tipo de ficha</h3>
          <p>Ej. Ficha de seguridad, Ficha técnica, Manual de maquinaria, Instrucción de trabajo…</p>
        </div>
        <button type="button" className="d-icon-btn" onClick={onClose} aria-label="Cerrar">✕</button>
      </div>
      <div className="docs-modal-body">
        {formError && <div className="docs-form-error">{formError}</div>}
        <label className="d-label" htmlFor="nt-nombre">Nombre del tipo</label>
        <input id="nt-nombre" className="d-input" autoFocus placeholder="Ficha de seguridad" value={nombre} onChange={(e) => setNombre(e.target.value)} />
      </div>
      <div className="docs-modal-foot">
        <button type="button" className="d-btn ghost" onClick={onClose}>Cancelar</button>
        <button type="submit" className="d-btn" disabled={saving}>{saving ? "Creando…" : "Crear tipo"}</button>
      </div>
    </form>
  </div>;
}
