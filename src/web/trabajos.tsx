import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Field, Modal, Toast, formatFecha, formatNum, type FieldDef } from "./ui";

type Row = Record<string, unknown>;
type Aviso = { message: string; kind: "ok" | "error" };

const TIPOS = [
  { value: "limpieza", label: "🧹 Limpieza" },
  { value: "mantenimiento", label: "🔧 Mantenimiento" },
  { value: "incidencia", label: "⚠️ Incidencia" },
  { value: "otro", label: "📌 Otro" },
];
const PRIORIDADES = [
  { value: "baja", label: "Baja" },
  { value: "normal", label: "Normal" },
  { value: "alta", label: "Alta" },
  { value: "urgente", label: "Urgente" },
];
const ESTADOS = [
  { value: "abierto", label: "Abierto", badge: "info" },
  { value: "en_curso", label: "En curso", badge: "warn" },
  { value: "pausado", label: "Pausado", badge: "muted" },
  { value: "cerrado", label: "Cerrado", badge: "ok" },
];
const etiqueta = (lista: Array<{ value: string; label: string }>, v: unknown): string =>
  lista.find((x) => x.value === String(v))?.label ?? String(v ?? "—");
const badgeEstado = (v: unknown): string => ESTADOS.find((x) => x.value === String(v))?.badge ?? "muted";
const badgePrioridad = (v: unknown): string => {
  const p = String(v ?? "normal");
  return p === "urgente" ? "danger" : p === "alta" ? "warn" : p === "baja" ? "muted" : "info";
};

interface Resumen {
  total: number; por_estado: Record<string, number>; vencidos: number;
  cerrados_mes: number; horas_mes: number;
}

const FORM_VACIO: Row = {
  centro_id: "", zona_id: "", subzona_id: "", titulo: "", descripcion: "",
  tipo: "limpieza", prioridad: "normal", estado: "abierto", operario_id: "",
  fecha_prevista: "", horas: "", material: "", notas: "",
};

/** Órdenes de trabajo: limpieza, mantenimiento e incidencias por centro, con
 *  operario asignado, prioridad, fecha prevista y horas. */
export function TrabajosPage({ user }: { user: { rol: string } }) {
  const [items, setItems] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [operarios, setOperarios] = useState<Row[]>([]);
  const [zonas, setZonas] = useState<Row[]>([]);
  const [subzonas, setSubzonas] = useState<Row[]>([]);
  const [resumen, setResumen] = useState<Resumen | null>(null);
  const [puedeGestionar, setPuedeGestionar] = useState(false);
  const [centroFiltro, setCentroFiltro] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState("");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; values: Row } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const cargar = useCallback(async () => {
    setLoading(true); setError(null);
    const params = new URLSearchParams();
    if (centroFiltro) params.set("centro_id", centroFiltro);
    if (estadoFiltro) params.set("estado", estadoFiltro);
    if (q.trim()) params.set("q", q.trim());
    try {
      const [lista, res, ops, zn, sz] = await Promise.all([
        api.get<{ items: Row[]; centros: Row[]; puede_gestionar: boolean }>(`/api/trabajos${params.size ? `?${params.toString()}` : ""}`),
        api.get<Resumen>("/api/trabajos/resumen"),
        api.get<{ items: Row[] }>("/api/operarios"),
        api.get<{ items: Row[] }>("/api/zonas"),
        api.get<{ items: Row[] }>("/api/subzonas"),
      ]);
      setItems(lista.items);
      setCentros(lista.centros);
      setPuedeGestionar(lista.puede_gestionar);
      setResumen(res);
      setOperarios(ops.items);
      setZonas(zn.items);
      setSubzonas(sz.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar los trabajos");
    } finally { setLoading(false); }
  }, [centroFiltro, estadoFiltro, q]);
  useEffect(() => { void cargar(); }, [cargar]);

  const abrirCrear = () => {
    setFormError(null);
    setEditing({ mode: "create", values: { ...FORM_VACIO, centro_id: String(centros[0]?.id ?? "") } });
  };
  const abrirEditar = (row: Row) => {
    setFormError(null);
    setEditing({
      mode: "edit",
      values: {
        id: row.id, centro_id: String(row.centro_id ?? ""), zona_id: row.zona_id == null ? "" : String(row.zona_id),
        subzona_id: row.subzona_id == null ? "" : String(row.subzona_id), titulo: row.titulo ?? "",
        descripcion: row.descripcion ?? "", tipo: row.tipo ?? "limpieza", prioridad: row.prioridad ?? "normal",
        estado: row.estado ?? "abierto", operario_id: row.operario_id == null ? "" : String(row.operario_id),
        fecha_prevista: row.fecha_prevista ?? "", horas: row.horas ?? "", material: row.material ?? "", notas: row.notas ?? "",
      },
    });
  };

  const zonassForm = useMemo(
    () => zonas.filter((z) => String(z.centro_id ?? "") === String(editing?.values.centro_id ?? "")),
    [zonas, editing?.values.centro_id],
  );
  const subzonasForm = useMemo(
    () => subzonas.filter((s) => String(s.zona_id ?? "") === String(editing?.values.zona_id ?? "")),
    [subzonas, editing?.values.zona_id],
  );

  const setVal = (name: string, v: unknown) => {
    setEditing((prev) => {
      if (!prev) return prev;
      const values: Row = { ...prev.values, [name]: v };
      if (name === "centro_id") { values.zona_id = ""; values.subzona_id = ""; }
      if (name === "zona_id") values.subzona_id = "";
      return { ...prev, values };
    });
  };

  const guardar = async () => {
    if (!editing) return;
    const v = editing.values;
    if (!String(v.titulo ?? "").trim()) { setFormError("El título es obligatorio"); return; }
    if (!String(v.centro_id ?? "")) { setFormError("Elige el centro"); return; }
    const payload: Row = {
      centro_id: Number(v.centro_id),
      zona_id: v.zona_id === "" ? null : Number(v.zona_id),
      subzona_id: v.subzona_id === "" ? null : Number(v.subzona_id),
      titulo: String(v.titulo ?? "").trim(),
      descripcion: String(v.descripcion ?? "").trim() || null,
      tipo: String(v.tipo ?? "limpieza"),
      prioridad: String(v.prioridad ?? "normal"),
      estado: String(v.estado ?? "abierto"),
      operario_id: v.operario_id === "" ? null : Number(v.operario_id),
      fecha_prevista: String(v.fecha_prevista ?? "") || null,
      horas: v.horas === "" || v.horas == null ? null : Number(String(v.horas).replace(",", ".")),
      material: String(v.material ?? "").trim() || null,
      notas: String(v.notas ?? "").trim() || null,
    };
    setSaving(true); setFormError(null);
    try {
      if (editing.mode === "create") await api.post("/api/trabajos", payload);
      else await api.put(`/api/trabajos/${String(v.id)}`, payload);
      setEditing(null);
      setAviso({ message: editing.mode === "create" ? "Trabajo creado" : "Trabajo actualizado", kind: "ok" });
      await cargar();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "No se pudo guardar el trabajo");
    } finally { setSaving(false); }
  };

  const cambiarEstado = async (row: Row, estado: string) => {
    try {
      await api.post(`/api/trabajos/${String(row.id)}/estado`, { estado });
      setAviso({ message: `Trabajo «${String(row.titulo)}» → ${estado.replace("_", " ")}`, kind: "ok" });
      await cargar();
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo cambiar el estado", kind: "error" }); }
  };

  const borrar = async (row: Row) => {
    if (!window.confirm(`¿Eliminar el trabajo «${String(row.titulo)}»?`)) return;
    try {
      await api.del(`/api/trabajos/${String(row.id)}`);
      setAviso({ message: "Trabajo eliminado", kind: "ok" });
      await cargar();
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };

  const campos: FieldDef[] = [
    { name: "titulo", label: "Título del trabajo", type: "text", required: true, placeholder: "Ej. Limpieza de la zona de carga" },
    { name: "tipo", label: "Tipo", type: "select", options: TIPOS },
    { name: "prioridad", label: "Prioridad", type: "select", options: PRIORIDADES },
    { name: "estado", label: "Estado", type: "select", options: ESTADOS.map((e) => ({ value: e.value, label: e.label })) },
    { name: "operario_id", label: "Operario asignado", type: "select", options: operarios.map((o) => ({ value: Number(o.id), label: String(o.nombre ?? o.username ?? o.id) })) },
    { name: "fecha_prevista", label: "Fecha prevista", type: "date" },
    { name: "horas", label: "Horas dedicadas", type: "number" },
    { name: "material", label: "Material utilizado", type: "text", placeholder: "Ej. 2 garrafas de desengrasante" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    { name: "notas", label: "Notas", type: "textarea" },
  ];

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      <select className="input" style={{ maxWidth: 240 }} value={centroFiltro} onChange={(e) => setCentroFiltro(e.target.value)} aria-label="Filtrar por centro">
        <option value="">Todos los centros</option>
        {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <select className="input" style={{ maxWidth: 190 }} value={estadoFiltro} onChange={(e) => setEstadoFiltro(e.target.value)} aria-label="Filtrar por estado">
        <option value="">Todos los estados</option>
        {ESTADOS.map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
      </select>
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar trabajo u operario…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="spacer" />
      {puedeGestionar && <button className="btn" onClick={abrirCrear} disabled={!centros.length}
        title={user.rol === "usuario" ? "Solo lectura" : "Crear una orden de trabajo"}>＋ Nuevo trabajo</button>}
    </div>

    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}

    <div className="kpis no-print">
      <div className="kpi"><div className="label">Abiertos</div><div className="value">{formatNum((resumen?.por_estado?.abierto ?? 0) + (resumen?.por_estado?.en_curso ?? 0) + (resumen?.por_estado?.pausado ?? 0))}</div><div className="kpi-sub">sin cerrar</div></div>
      <div className="kpi"><div className="label">En curso</div><div className="value">{formatNum(resumen?.por_estado?.en_curso ?? 0)}</div><div className="kpi-sub">{formatNum(resumen?.por_estado?.abierto ?? 0)} sin empezar</div></div>
      <div className={"kpi" + (Number(resumen?.vencidos) ? " alert" : "")}><div className="label">Vencidos</div><div className="value">{formatNum(resumen?.vencidos ?? 0)}</div><div className="kpi-sub">pasada la fecha prevista</div></div>
      <div className="kpi"><div className="label">Cerrados este mes</div><div className="value">{formatNum(resumen?.cerrados_mes ?? 0)}</div><div className="kpi-sub">{formatNum(resumen?.horas_mes ?? 0)} h registradas</div></div>
    </div>

    <div className="card">
      {loading ? <div className="loading">Cargando trabajos…</div>
        : !items.length ? <div className="empty">
          <span className="icon">🛠️</span><strong>No hay trabajos</strong>
          <p>{puedeGestionar ? "Crea el primero: elige centro, zona, prioridad y operario." : "Todavía no hay órdenes de trabajo para tus centros."}</p>
          {puedeGestionar && centros.length > 0 && <button className="btn" onClick={abrirCrear}>＋ Crear trabajo</button>}
        </div>
        : <div className="table-scroll"><table>
          <thead><tr><th>Trabajo</th><th>Centro / zona</th><th>Operario</th><th>Prioridad</th><th>Estado</th><th>Prevista</th><th className="right">Horas</th><th className="right">Acciones</th></tr></thead>
          <tbody>{items.map((t) => <tr key={String(t.id)}>
            <td><strong>{String(t.titulo ?? "—")}</strong><div style={{ color: "var(--muted)", fontSize: 12 }}>{etiqueta(TIPOS, t.tipo)}</div></td>
            <td>{String(t.centro_nombre ?? "—")}<div style={{ color: "var(--muted)", fontSize: 12 }}>{[t.zona_nombre, t.subzona_nombre].filter(Boolean).join(" › ") || "—"}</div></td>
            <td>{String(t.operario_nombre ?? "—")}</td>
            <td><span className={`badge ${badgePrioridad(t.prioridad)}`}>{etiqueta(PRIORIDADES, t.prioridad)}</span></td>
            <td><span className={`badge ${badgeEstado(t.estado)}`}>{etiqueta(ESTADOS, t.estado)}</span></td>
            <td>{t.fecha_prevista ? <>{formatFecha(t.fecha_prevista)}{Number(t.vencido) === 1 && <div><span className="badge danger">⏰ {formatNum(t.dias_retraso)} d. tarde</span></div>}</> : "—"}</td>
            <td className="right">{t.horas == null ? "—" : formatNum(t.horas, 2)}</td>
            <td className="right"><div className="row-actions">
              {puedeGestionar && String(t.estado) === "abierto" && <button className="btn secondary small" onClick={() => void cambiarEstado(t, "en_curso")}>▶ Iniciar</button>}
              {puedeGestionar && String(t.estado) !== "cerrado" && <button className="btn secondary small" onClick={() => void cambiarEstado(t, "cerrado")}>✅ Cerrar</button>}
              {puedeGestionar && String(t.estado) === "cerrado" && <button className="btn secondary small" onClick={() => void cambiarEstado(t, "abierto")}>↩️ Reabrir</button>}
              {puedeGestionar && <button className="btn secondary small" onClick={() => abrirEditar(t)}>✏️ Editar</button>}
              {puedeGestionar && <button className="btn danger small" onClick={() => void borrar(t)}>🗑️</button>}
            </div></td>
          </tr>)}</tbody>
        </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {formatNum(items.length)} trabajos · Planifica las tareas por centro y zona, asigna un operario y controla la fecha prevista frente a la de cierre.
    </p>

    {editing && <Modal title={editing.mode === "create" ? "Nuevo trabajo" : "Editar trabajo"}
      subtitle="Centro, zona, prioridad, operario y fechas" onClose={() => setEditing(null)} wide>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="tr-centro">Centro <span className="req">*</span></label>
          <select id="tr-centro" className="input" value={String(editing.values.centro_id ?? "")} onChange={(e) => setVal("centro_id", e.target.value)}>
            {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tr-zona">Zona</label>
          <select id="tr-zona" className="input" value={String(editing.values.zona_id ?? "")} onChange={(e) => setVal("zona_id", e.target.value)}>
            <option value="">— Sin zona —</option>
            {zonassForm.map((z) => <option key={String(z.id)} value={String(z.id)}>{String(z.nombre)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="tr-subzona">Subzona</label>
          <select id="tr-subzona" className="input" value={String(editing.values.subzona_id ?? "")} onChange={(e) => setVal("subzona_id", e.target.value)}>
            <option value="">— Sin subzona —</option>
            {subzonasForm.map((s) => <option key={String(s.id)} value={String(s.id)}>{String(s.nombre)}</option>)}
          </select>
        </div>
        {campos.map((f) => <div key={f.name} className={f.type === "textarea" ? "full" : ""}>
          <Field def={f} value={editing.values[f.name]} onChange={(v) => setVal(f.name, v)} />
        </div>)}
      </div>
      <div className="modal-footer">
        <button className="btn secondary" onClick={() => setEditing(null)} disabled={saving}>Cancelar</button>
        <button className="btn" onClick={() => void guardar()} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
      </div>
    </Modal>}
    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}
