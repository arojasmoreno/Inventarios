import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { Field, Modal, Toast, camposConError, downloadCsv, formatNum, type FieldDef } from "./ui";

type Row = Record<string, unknown>;
type Aviso = { message: string; kind: "ok" | "error" };

const precioTexto = (v: unknown): string => (v == null || v === "" ? "—" : formatNum(v, 2));

/** Parsea un CSV/TSV sencillo (coma, punto y coma o tabulador; con comillas):
 *  el mismo formato que exporta «Guardar en Excel (CSV)». */
function parseCsv(texto: string): string[][] {
  const out: string[][] = [];
  let fila: string[] = [], cur = "", enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (enComillas) {
      if (ch === '"' && texto[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') enComillas = false;
      else cur += ch;
    } else if (ch === '"') enComillas = true;
    else if (ch === "," || ch === ";" || ch === "\t") { fila.push(cur); cur = ""; }
    else if (ch === "\n") { fila.push(cur); out.push(fila); fila = []; cur = ""; }
    else if (ch !== "\r") cur += ch;
  }
  fila.push(cur); out.push(fila);
  return out.map(f => f.map(s => s.trim())).filter(f => f.some(s => s !== ""));
}

// ─────────────────────────── Productos disponibles ───────────────────────────
const CAMPOS: FieldDef[] = [
  { name: "codigo", label: "Código", type: "text", required: true, placeholder: "Ej. M-001", help: "Es el que relaciona el producto con «Material de limpieza»: lo recibido en un pedido se suma por código." },
  { name: "producto", label: "Producto", type: "text", required: true, placeholder: "Ej. Mopa de microfibra" },
  { name: "precio", label: "Precio (€)", type: "number", help: "Opcional: déjalo en blanco si aún no lo conoces." },
];

/** Catálogo de productos que se pueden pedir: código, producto y precio, con
 *  alta manual (formulario), importación desde Excel (CSV) y las unidades que
 *  ya hay de cada código en «Material de limpieza». */
export function ProductosDisponiblesPage({ user }: { user: { rol: string } }) {
  const admin = user.rol === "admin";
  const [items, setItems] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<{ mode: "create" | "edit"; values: Row } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [importando, setImportando] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setItems((await api.get<{ items: Row[] }>("/api/productos-disponibles")).items); }
    catch (e) { setError(e instanceof Error ? e.message : "Error cargando los datos"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtrados = useMemo(() => {
    const n = q.trim().toLowerCase();
    return items
      .filter(r => !n || [r.codigo, r.producto].some(k => String(k ?? "").toLowerCase().includes(n)))
      .sort((a, b) => String(a.codigo ?? "").localeCompare(String(b.codigo ?? ""), "es", { sensitivity: "base" }));
  }, [items, q]);

  const etiquetas = CAMPOS.map(f => ({ clave: f.name, etiqueta: f.label }));
  const openCreate = () => { setFormError(null); setFieldErrors([]); setEditing({ mode: "create", values: { codigo: "", producto: "", precio: "" } }); };
  const openEdit = (row: Row) => { setFormError(null); setFieldErrors([]); setEditing({ mode: "edit", values: { id: row.id, codigo: row.codigo ?? "", producto: row.producto ?? "", precio: row.precio ?? "" } }); };

  const guardar = async () => {
    if (!editing) return;
    const codigo = String(editing.values.codigo ?? "").trim();
    const producto = String(editing.values.producto ?? "").trim();
    const vacios = [...(!codigo ? ["codigo"] : []), ...(!producto ? ["producto"] : [])];
    const precioRaw = editing.values.precio;
    const precio = precioRaw === "" || precioRaw == null ? null : Number(String(precioRaw).replace(",", "."));
    if (precio !== null && !Number.isFinite(precio)) vacios.push("precio");
    if (vacios.length) { setFieldErrors(vacios); setFormError(precio !== null && !Number.isFinite(precio) ? "El precio debe ser un número" : "Revisa los campos marcados en rojo"); return; }
    setSaving(true); setFormError(null); setFieldErrors([]);
    try {
      const payload: Row = { codigo, producto, precio };
      if (editing.mode === "create") await api.post("/api/productos-disponibles", payload);
      else await api.put(`/api/productos-disponibles/${String(editing.values.id)}`, payload);
      setEditing(null); setAviso({ message: "Producto guardado", kind: "ok" });
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudo guardar el producto";
      setFormError(msg); setFieldErrors(camposConError(msg, etiquetas));
    } finally { setSaving(false); }
  };

  const eliminar = async (row: Row) => {
    if (!window.confirm(`¿Eliminar el producto «${String(row.producto)}» (${String(row.codigo)})? Esta acción no se puede deshacer.`)) return;
    try { await api.del(`/api/productos-disponibles/${String(row.id)}`); setAviso({ message: "Producto eliminado", kind: "ok" }); await load(); }
    catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo eliminar el producto", kind: "error" }); }
  };

  const exportar = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`productos-disponibles-${stamp}.csv`,
      ["Código", "Producto", "Precio (€)", "Unidades en material de limpieza"],
      filtrados.map(r => [
        String(r.codigo ?? ""), String(r.producto ?? ""),
        r.precio == null || r.precio === "" ? "" : formatNum(r.precio, 2),
        formatNum(r.unidades_almacen ?? 0),
      ]));
  };

  // Importación desde Excel: se guarda la hoja como CSV (Archivo → Guardar
  // como → CSV) y se sube aquí; la columna «codigo» hace de clave (upsert).
  const importar = async (f: File | null) => {
    if (!f) return;
    setImportando(true); setAviso(null);
    try {
      const filas = parseCsv(await f.text());
      if (filas.length < 2) { setAviso({ message: "El archivo necesita una fila de cabeceras y al menos un producto", kind: "error" }); return; }
      const cab = filas[0].map(h => h.toLowerCase().replace(/\s+/g, "_"));
      const iCod = cab.indexOf("codigo"), iProd = cab.indexOf("producto"), iPrec = cab.indexOf("precio");
      if (iCod < 0 || iProd < 0) { setAviso({ message: "Las cabeceras deben incluir «codigo» y «producto» (y opcionalmente «precio»)", kind: "error" }); return; }
      const rows: Row[] = []; const fallos: string[] = [];
      for (let i = 1; i < filas.length; i++) {
        const c = filas[i];
        const codigo = (c[iCod] ?? "").trim(), producto = (c[iProd] ?? "").trim();
        if (!codigo || !producto) { if (fallos.length < 5) fallos.push(`Fila ${i}: falta código o producto`); continue; }
        const precioTxt = iPrec >= 0 ? (c[iPrec] ?? "").trim() : "";
        const n = precioTxt === "" ? null : Number(precioTxt.replace(/\./g, "").replace(",", "."));
        rows.push({ codigo, producto, precio: n !== null && Number.isFinite(n) ? n : null });
      }
      if (!rows.length) { setAviso({ message: fallos[0] ?? "No se encontraron filas válidas", kind: "error" }); return; }
      const r = await api.post<{ creados?: number; actualizados?: number; errores?: string[] }>("/api/productos-disponibles/import", { rows });
      const partes = `${r.creados ?? 0} creados · ${r.actualizados ?? 0} actualizados`;
      const detalle = r.errores?.length ? ` · ${r.errores.length} con error (${r.errores[0]})` : fallos.length ? ` · ${fallos.length} descartadas` : "";
      setAviso({ message: `Importados: ${partes}${detalle}`, kind: r.errores?.length ? "error" : "ok" });
      await load();
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo importar el archivo", kind: "error" }); }
    finally { setImportando(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  if (loading) return <div className="card loading">Cargando productos…</div>;
  if (error) return <div className="card empty">⚠️ {error}</div>;
  return <>
    <div className="toolbar no-print" style={{ gap: 8 }}>
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar por código o producto…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="spacer" />
      {admin && <label className={"btn secondary" + (importando ? " disabled" : "")} style={{ cursor: "pointer" }} title="Subir un Excel guardado como CSV (columnas codigo, producto, precio)">
        📥 {importando ? "Leyendo…" : "Excel (CSV)"}
        <input ref={inputRef} type="file" accept=".csv,.txt,text/csv" style={{ display: "none" }} disabled={importando} onChange={e => void importar(e.target.files?.[0] ?? null)} />
      </label>}
      {admin && <button className="btn secondary" onClick={exportar} disabled={!filtrados.length}>⬇️ Excel (CSV)</button>}
      {admin && <button className="btn" onClick={openCreate}>＋ Nuevo producto</button>}
    </div>
    <div className="card">
      {!filtrados.length
        ? <div className="empty"><span className="icon">📭</span><strong>No hay productos</strong><p>{q ? "Prueba con otra búsqueda." : admin ? "Pulsa «Nuevo producto» o sube un Excel (CSV) para cargar el catálogo." : "Todavía no se han dado de alta productos."}</p></div>
        : <div className="table-scroll"><table>
          <thead><tr><th>Código</th><th>Producto</th><th className="right">Precio (€)</th><th>Material de limpieza</th>{admin && <th className="right">Acciones</th>}</tr></thead>
          <tbody>{filtrados.map(r => <tr key={String(r.id)}>
            <td><strong>{String(r.codigo ?? "—")}</strong></td>
            <td>{String(r.producto ?? "—")}</td>
            <td className="right">{precioTexto(r.precio)}</td>
            <td>{Number(r.en_almacen) === 1
              ? <span className="badge ok">{formatNum(r.unidades_almacen)} uds</span>
              : <span className="badge muted" title="Todavía no hay stock de este código en Material de limpieza">Sin registro</span>}</td>
            {admin && <td className="right"><div className="row-actions">
              <button className="btn secondary small" onClick={() => openEdit(r)}>✏️ Editar</button>
              <button className="btn danger small" onClick={() => void eliminar(r)}>🗑️ Borrar</button>
            </div></td>}
          </tr>)}</tbody>
        </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {filtrados.length} de {items.length} productos · El <strong>código</strong> es la relación con «Material de limpieza»: lo recibido en un pedido se suma en esa tabla por su código.
    </p>
    {editing && <Modal title={editing.mode === "create" ? "Nuevo producto" : "Editar producto"} subtitle="Catálogo de productos disponibles para pedir" onClose={() => setEditing(null)}>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">{CAMPOS.map(f => <div key={f.name} className={f.type === "textarea" ? "full" : ""}>
        <Field def={f} value={editing.values[f.name]} onChange={v => { setFieldErrors(prev => prev.filter(k => k !== f.name)); setEditing(prev => prev ? { ...prev, values: { ...prev.values, [f.name]: v } } : prev); }} error={fieldErrors.includes(f.name)} />
      </div>)}</div>
      <div className="modal-footer">
        <button className="btn secondary" onClick={() => setEditing(null)}>Cancelar</button>
        <button className="btn" onClick={() => void guardar()} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
      </div>
    </Modal>}
    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}
