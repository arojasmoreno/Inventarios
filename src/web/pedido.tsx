import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api } from "./api";
import { Field, Modal, Toast, camposConError, downloadCsv, formatNum, type FieldDef } from "./ui";

type Row = Record<string, unknown>;

// Origen del consumible: los mismos dos valores que en «Material de limpieza».
const ORIGEN_OPTS = [
  { value: "fabrica", label: "🏭 Fábrica" },
  { value: "empresa", label: "🏢 Empresa" },
];
const origenTexto = (v: unknown): string => { const s = String(v ?? ""); return s === "empresa" ? "Empresa" : s === "fabrica" ? "Fábrica" : "—"; };
const precioTexto = (v: unknown): string => (v == null || v === "" ? "—" : formatNum(v, 2));
const importe = (cantidad: unknown, precio: unknown): number => Number(cantidad ?? 0) * Number(precio ?? 0);
const proveedorTexto = (row: Row): string => [row.proveedor_codigo, row.proveedor_nombre].filter(Boolean).join(" · ") || "—";
const etiquetaProveedor = (p: Row | undefined): string => [p?.codigo, p?.nombre].filter(Boolean).join(" · ") || "—";
const contactoProveedor = (p: Row | undefined): string =>
  [p?.contacto, p?.telefono, p?.email].map(v => String(v ?? "").trim()).filter(Boolean).join(" · ") || "Sin datos de contacto";

/** Parsea un CSV/TSV sencillo (coma, punto y coma o tabulador; con comillas):
 *  el mismo formato que exporta «Guardar en Excel (CSV)» y que espera la
 *  importación masiva del backend. */
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

type Aviso = { message: string; kind: "ok" | "error" };

// ─────────────────────────── Productos disponibles ───────────────────────────
const CAMPOS_PRODUCTO: FieldDef[] = [
  { name: "codigo", label: "Código", type: "text", required: true, placeholder: "Ej. M-001", help: "Único en todos los proveedores. Es el que relaciona el producto con «Material de limpieza»: las cantidades de un pedido se suman por código." },
  { name: "producto", label: "Producto", type: "text", required: true, placeholder: "Ej. Mopa de microfibra" },
  { name: "precio", label: "Precio (€)", type: "number", help: "Opcional: déjalo en blanco si aún no lo conoces." },
];

/** Catálogo de productos de un proveedor: cada producto pertenece a uno solo.
 *  La tabla solo muestra los productos del proveedor elegido; el alta, la
 *  edición y la importación se hacen siempre dentro de ese proveedor. */
export function ProductosDisponiblesPage({ user, onGoProveedores }: { user: { rol: string }; onGoProveedores?: () => void }) {
  const admin = user.rol === "admin";
  const [items, setItems] = useState<Row[]>([]);
  const [proveedores, setProveedores] = useState<Row[]>([]);
  const [proveedorId, setProveedorId] = useState("");
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

  const load = useCallback(async (preferido?: string) => {
    setLoading(true); setError(null);
    try {
      const [prod, prov] = await Promise.all([
        api.get<{ items: Row[] }>("/api/productos-disponibles"),
        api.get<{ items: Row[] }>("/api/proveedores"),
      ]);
      setItems(prod.items);
      setProveedores(prov.items);
      setProveedorId(prev => {
        const wanted = preferido ?? prev;
        return wanted && prov.items.some(p => String(p.id) === wanted) ? wanted : String(prov.items[0]?.id ?? "");
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Error cargando los datos"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const provActual = useMemo(() => proveedores.find(p => String(p.id) === proveedorId), [proveedores, proveedorId]);
  const delProveedor = useMemo(() => items.filter(r => String(r.proveedor_id ?? "") === proveedorId), [items, proveedorId]);
  const filtrados = useMemo(() => {
    const n = q.trim().toLowerCase();
    return delProveedor
      .filter(r => !n || [r.codigo, r.producto, r.proveedor_codigo, r.proveedor_nombre].some(k => String(k ?? "").toLowerCase().includes(n)))
      .sort((a, b) => String(a.codigo ?? "").localeCompare(String(b.codigo ?? ""), "es", { sensitivity: "base" }));
  }, [delProveedor, q]);
  const totalUds = useMemo(() => delProveedor.reduce((acc, r) => acc + Number(r.unidades_almacen ?? 0), 0), [delProveedor]);
  const sinStock = useMemo(() => delProveedor.filter(r => Number(r.en_almacen) !== 1).length, [delProveedor]);

  const campos = useMemo<FieldDef[]>(() => [
    {
      name: "proveedor_id", label: "Proveedor", type: "select", required: true,
      options: proveedores.map(p => ({ value: Number(p.id), label: `${String(p.codigo ?? "")} · ${String(p.nombre ?? "")}` })),
      help: "Cada producto pertenece a un único proveedor.",
    },
    ...CAMPOS_PRODUCTO,
  ], [proveedores]);
  const etiquetas = campos.map(f => ({ clave: f.name, etiqueta: f.label }));

  const openCreate = () => {
    if (!proveedores.length) { onGoProveedores?.(); return; }
    setFormError(null); setFieldErrors([]);
    setEditing({ mode: "create", values: { proveedor_id: proveedorId || String(proveedores[0]?.id ?? ""), codigo: "", producto: "", precio: "" } });
  };
  const openEdit = (row: Row) => {
    setFormError(null); setFieldErrors([]);
    setEditing({
      mode: "edit",
      values: { id: row.id, proveedor_id: row.proveedor_id ?? "", codigo: row.codigo ?? "", producto: row.producto ?? "", precio: row.precio ?? "" },
    });
  };

  const guardar = async () => {
    if (!editing) return;
    const proveedor = String(editing.values.proveedor_id ?? "").trim();
    const codigo = String(editing.values.codigo ?? "").trim();
    const producto = String(editing.values.producto ?? "").trim();
    const vacios = [...(!proveedor ? ["proveedor_id"] : []), ...(!codigo ? ["codigo"] : []), ...(!producto ? ["producto"] : [])];
    const precioRaw = editing.values.precio;
    const precio = precioRaw === "" || precioRaw == null ? null : Number(String(precioRaw).replace(",", "."));
    if (precio !== null && !Number.isFinite(precio)) vacios.push("precio");
    if (vacios.length) {
      setFieldErrors(vacios);
      setFormError(precio !== null && !Number.isFinite(precio) ? "El precio debe ser un número" : "Revisa los campos marcados en rojo");
      return;
    }
    setSaving(true); setFormError(null); setFieldErrors([]);
    try {
      const payload: Row = { proveedor_id: Number(proveedor), codigo, producto, precio };
      if (editing.mode === "create") await api.post("/api/productos-disponibles", payload);
      else await api.put(`/api/productos-disponibles/${String(editing.values.id)}`, payload);
      setEditing(null);
      setAviso({ message: "Producto guardado", kind: "ok" });
      await load(proveedor);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "No se pudo guardar el producto";
      setFormError(msg); setFieldErrors(camposConError(msg, etiquetas));
    } finally { setSaving(false); }
  };

  const eliminar = async (row: Row) => {
    if (!window.confirm(`¿Eliminar el producto «${String(row.producto)}» (${String(row.codigo)}) de ${proveedorTexto(row)}? Esta acción no se puede deshacer.`)) return;
    try {
      await api.del(`/api/productos-disponibles/${String(row.id)}`);
      setAviso({ message: "Producto eliminado", kind: "ok" });
      await load(proveedorId);
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo eliminar el producto", kind: "error" }); }
  };

  const exportar = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`productos-disponibles-${stamp}.csv`,
      ["Código", "Producto", "Proveedor", "Precio (€)", "Unidades en material de limpieza"],
      filtrados.map(r => [
        String(r.codigo ?? ""), String(r.producto ?? ""), proveedorTexto(r),
        r.precio == null || r.precio === "" ? "" : formatNum(r.precio, 2),
        formatNum(r.unidades_almacen ?? 0),
      ]));
  };

  // Importación desde Excel: se guarda la hoja como CSV (Archivo → Guardar
  // como → CSV) y se sube aquí. Todas las filas se asignan al proveedor
  // seleccionado; la columna «codigo» hace de clave (upsert).
  const importar = async (f: File | null) => {
    if (!f) return;
    if (!proveedorId) { setAviso({ message: "Selecciona un proveedor antes de importar", kind: "error" }); return; }
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
        rows.push({ proveedor_id: Number(proveedorId), codigo, producto, precio: n !== null && Number.isFinite(n) ? n : null });
      }
      if (!rows.length) { setAviso({ message: fallos[0] ?? "No se encontraron filas válidas", kind: "error" }); return; }
      const r = await api.post<{ creados?: number; actualizados?: number; errores?: string[] }>("/api/productos-disponibles/import", { rows });
      const partes = `${r.creados ?? 0} creados · ${r.actualizados ?? 0} actualizados`;
      const detalle = r.errores?.length ? ` · ${r.errores.length} con error (${r.errores[0]})` : fallos.length ? ` · ${fallos.length} descartadas` : "";
      setAviso({ message: `Importados en ${etiquetaProveedor(provActual)}: ${partes}${detalle}`, kind: r.errores?.length ? "error" : "ok" });
      await load(proveedorId);
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo importar el archivo", kind: "error" }); }
    finally { setImportando(false); if (inputRef.current) inputRef.current.value = ""; }
  };

  if (loading) return <div className="card loading">Cargando productos…</div>;
  if (error) return <div className="card empty">⚠️ {error}</div>;
  if (!proveedores.length) return <div className="card empty">
    <span className="icon">🚚</span>
    <strong>Todavía no hay proveedores</strong>
    <p>{admin ? "Crea un proveedor y asígnale sus productos. Cada producto del catálogo se pide a un único proveedor." : "Pide a un administrador que cree los proveedores y el catálogo de productos."}</p>
    {admin && onGoProveedores && <button className="btn" onClick={onGoProveedores}>＋ Crear el primer proveedor</button>}
  </div>;

  return <>
    <div className="toolbar no-print" style={{ gap: 8 }}>
      <select className="input" style={{ maxWidth: 300 }} value={proveedorId} onChange={e => setProveedorId(e.target.value)} aria-label="Proveedor del catálogo">
        {proveedores.map(p => <option key={String(p.id)} value={String(p.id)}>{String(p.codigo ?? "")} · {String(p.nombre ?? "")}</option>)}
      </select>
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar por código o producto…" value={q} onChange={e => setQ(e.target.value)} />
      <div className="spacer" />
      {admin && <label className={"btn secondary" + (importando ? " disabled" : "")} style={{ cursor: "pointer" }} title="Subir un Excel guardado como CSV al proveedor seleccionado (columnas codigo, producto, precio)">
        📥 {importando ? "Leyendo…" : "Excel (CSV)"}
        <input ref={inputRef} type="file" accept=".csv,.txt,text/csv" style={{ display: "none" }} disabled={importando} onChange={e => void importar(e.target.files?.[0] ?? null)} />
      </label>}
      {admin && <button className="btn secondary" onClick={exportar} disabled={!filtrados.length}>⬇️ Excel (CSV)</button>}
      {admin && <button className="btn" onClick={openCreate}>＋ Nuevo producto</button>}
    </div>

    {provActual && <div className="card card-pad provider-summary">
      <div className="provider-summary-main">
        <span className="provider-avatar">🚚</span>
        <div>
          <span className="provider-code">{String(provActual.codigo ?? "—")}</span>
          <strong>{String(provActual.nombre ?? "—")}</strong>
          <p>{contactoProveedor(provActual)}</p>
        </div>
      </div>
      <div className="provider-summary-stats">
        <span><strong>{formatNum(delProveedor.length)}</strong>productos</span>
        <span><strong>{formatNum(totalUds)}</strong>uds en almacén</span>
        <span><strong>{formatNum(sinStock)}</strong>sin stock</span>
      </div>
    </div>}

    <div className="card">
      {!filtrados.length
        ? <div className="empty"><span className="icon">📭</span><strong>No hay productos de este proveedor</strong><p>{q ? "Prueba con otra búsqueda." : admin ? "Pulsa «Nuevo producto» o sube un Excel (CSV) para cargar su catálogo." : "Todavía no se han dado de alta productos para este proveedor."}</p></div>
        : <div className="table-scroll"><table>
          <thead><tr><th>Código</th><th>Producto</th><th>Proveedor</th><th className="right">Precio (€)</th><th>Material de limpieza</th>{admin && <th className="right">Acciones</th>}</tr></thead>
          <tbody>{filtrados.map(r => <tr key={String(r.id)}>
            <td><strong>{String(r.codigo ?? "—")}</strong></td>
            <td>{String(r.producto ?? "—")}</td>
            <td><span className="provider-mini">{String(r.proveedor_codigo ?? "—")}</span> {String(r.proveedor_nombre ?? "")}</td>
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
      {filtrados.length} de {delProveedor.length} productos de <strong>{etiquetaProveedor(provActual)}</strong> · El <strong>código</strong> es la relación con «Material de limpieza»: las cantidades de un pedido se suman en esa tabla por su código.
    </p>
    {editing && <Modal title={editing.mode === "create" ? "Nuevo producto" : "Editar producto"} subtitle={provActual ? `Catálogo de ${etiquetaProveedor(provActual)}` : "Catálogo de productos disponibles para pedir"} onClose={() => setEditing(null)}>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">{campos.map(f => <div key={f.name} className={f.type === "textarea" ? "full" : ""}>
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

// ───────────────────────────── Pedido material ───────────────────────────────
/** Hoja de pedido de un proveedor: se elige el proveedor, se añaden solo sus
 *  productos y la tabla muestra únicamente sus líneas. Al aplicar, las
 *  cantidades pendientes se suman en «Material de limpieza». */
export function PedidoMaterialPage({ user, onGoProveedores }: { user: { rol: string }; onGoProveedores?: () => void }) {
  const admin = user.rol === "admin";
  const [lineas, setLineas] = useState<Row[]>([]);
  const [productos, setProductos] = useState<Row[]>([]);
  const [proveedores, setProveedores] = useState<Row[]>([]);
  const [proveedorId, setProveedorId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [aplicando, setAplicando] = useState(false);
  const [form, setForm] = useState({ codigo: "", producto: "", cantidad: "", precio: "", origen: "fabrica" });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [l, p, prov] = await Promise.all([
        api.get<{ items: Row[] }>("/api/pedidos-material"),
        api.get<{ items: Row[] }>("/api/productos-disponibles"),
        api.get<{ items: Row[] }>("/api/proveedores"),
      ]);
      setLineas(l.items); setProductos(p.items); setProveedores(prov.items);
      setProveedorId(prev => prev && prov.items.some(x => String(x.id) === prev) ? prev : String(prov.items[0]?.id ?? ""));
    } catch (e) { setError(e instanceof Error ? e.message : "Error cargando el pedido"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const provActual = useMemo(() => proveedores.find(p => String(p.id) === proveedorId), [proveedores, proveedorId]);
  const productosProv = useMemo(() => productos
    .filter(p => String(p.proveedor_id ?? "") === proveedorId)
    .sort((a, b) => String(a.producto ?? "").localeCompare(String(b.producto ?? ""), "es", { sensitivity: "base" })), [productos, proveedorId]);
  const lineasProv = useMemo(() => lineas
    .filter(l => String(l.proveedor_id ?? "") === proveedorId)
    .sort((a, b) => Number(a.id) - Number(b.id)), [lineas, proveedorId]);
  const pendientes = lineasProv.filter(l => Number(l.aplicado ?? 0) !== 1);
  const totales = ORIGEN_OPTS.map(o => {
    const filas = pendientes.filter(l => String(l.origen ?? "fabrica") === o.value);
    return {
      ...o,
      n: filas.length,
      uds: filas.reduce((acc, f) => acc + Number(f.cantidad ?? 0), 0),
      euros: filas.reduce((acc, f) => acc + importe(f.cantidad, f.precio), 0),
    };
  });
  const totalUds = totales.reduce((a, t) => a + t.uds, 0);
  const totalEuros = totales.reduce((a, t) => a + t.euros, 0);

  const cambiarProveedor = (id: string) => {
    setProveedorId(id);
    setForm(f => ({ ...f, codigo: "", producto: "", cantidad: "", precio: "" }));
    setFormError(null);
  };

  // Al elegir un producto de la lista del proveedor se completan solo nombre y
  // precio: el código es el que relaciona el pedido con el catálogo.
  const setProducto = (codigo: string) => {
    const p = productosProv.find(x => String(x.codigo ?? "") === codigo);
    setForm(f => ({
      ...f, codigo,
      producto: p ? String(p.producto ?? "") : "",
      precio: p && p.precio != null && p.precio !== "" ? String(p.precio) : "",
    }));
  };

  const agregar = async (e: FormEvent) => {
    e.preventDefault();
    if (!proveedorId) { setFormError("Selecciona un proveedor"); return; }
    const codigo = form.codigo.trim(), producto = form.producto.trim();
    const cantidad = Number(form.cantidad);
    const precio = form.precio.trim() === "" ? null : Number(form.precio.replace(",", "."));
    if (!codigo || !producto) { setFormError("Elige un producto del proveedor"); return; }
    if (!Number.isInteger(cantidad) || cantidad < 1) { setFormError("La cantidad debe ser un número entero mayor que 0"); return; }
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) { setFormError("El precio no es un número válido"); return; }
    setGuardando(true); setFormError(null);
    try {
      await api.post("/api/pedidos-material", { proveedor_id: Number(proveedorId), codigo, producto, cantidad, precio, origen: form.origen });
      setForm({ codigo: "", producto: "", cantidad: "", precio: "", origen: form.origen });
      setAviso({ message: "Línea añadida al pedido", kind: "ok" });
      await load();
    } catch (e2) { setFormError(e2 instanceof Error ? e2.message : "No se pudo añadir la línea"); }
    finally { setGuardando(false); }
  };

  const borrar = async (l: Row) => {
    const aplicada = Number(l.aplicado ?? 0) === 1;
    const aviso = aplicada ? " Esta línea ya se sumó en «Material de limpieza»: al borrarla no se descuenta el stock." : "";
    if (!window.confirm(`¿Quitar «${String(l.producto)}» del pedido?${aviso}`)) return;
    try { await api.del(`/api/pedidos-material/${String(l.id)}`); setAviso({ message: "Línea eliminada del pedido", kind: "ok" }); await load(); }
    catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo eliminar la línea", kind: "error" }); }
  };

  const aplicar = async () => {
    if (!proveedorId) return;
    setAplicando(true);
    try {
      const r = await api.post<{ lineas?: number; creados?: number; actualizados?: number }>("/api/pedidos-material/aplicar", { proveedor_id: Number(proveedorId) });
      setAviso({
        message: `Pedido de ${etiquetaProveedor(provActual)} aplicado: ${r.lineas ?? 0} líneas · ${r.actualizados ?? 0} productos sumados en Material de limpieza${r.creados ? ` · ${r.creados} nuevos` : ""}`,
        kind: "ok",
      });
      await load();
    } catch (e) { setAviso({ message: e instanceof Error ? e.message : "No se pudo aplicar el pedido", kind: "error" }); }
    finally { setAplicando(false); }
  };

  const exportar = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`pedido-${String(provActual?.codigo ?? "material")}-${stamp}.csv`,
      ["Código", "Producto", "Proveedor", "Cantidad", "Precio (€)", "Importe (€)", "Origen", "Estado"],
      lineasProv.map(l => [
        String(l.codigo ?? ""), String(l.producto ?? ""), proveedorTexto(l), String(l.cantidad ?? 0),
        l.precio == null || l.precio === "" ? "" : formatNum(l.precio, 2),
        formatNum(importe(l.cantidad, l.precio), 2),
        origenTexto(l.origen),
        Number(l.aplicado ?? 0) === 1 ? "Aplicado" : "Pendiente",
      ]));
  };

  if (loading) return <div className="card loading">Cargando el pedido…</div>;
  if (error) return <div className="card empty">⚠️ {error}</div>;
  if (!proveedores.length) return <div className="card empty">
    <span className="icon">🚚</span>
    <strong>Todavía no hay proveedores</strong>
    <p>{admin ? "Los pedidos se hacen a un proveedor concreto. Crea uno y asígnale sus productos." : "Pide a un administrador que cree los proveedores y sus productos."}</p>
    {admin && onGoProveedores && <button className="btn" onClick={onGoProveedores}>＋ Crear el primer proveedor</button>}
  </div>;
  if (!provActual) return <div className="card empty"><span className="icon">🚚</span><strong>Selecciona un proveedor</strong><p>Elige el proveedor al que quieres hacer el pedido.</p></div>;

  return <>
    <div className="toolbar no-print" style={{ gap: 8 }}>
      <span className="provider-picker-label">Proveedor del pedido</span>
      <select className="input" style={{ maxWidth: 330 }} value={proveedorId} onChange={e => cambiarProveedor(e.target.value)} aria-label="Proveedor del pedido">
        {proveedores.map(p => <option key={String(p.id)} value={String(p.id)}>{String(p.codigo ?? "")} · {String(p.nombre ?? "")}</option>)}
      </select>
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        {formatNum(pendientes.length)} líneas pendientes · {formatNum(lineasProv.length - pendientes.length)} aplicadas
      </span>
      <button className="btn secondary" onClick={exportar} disabled={!lineasProv.length} title="Guarda el pedido de este proveedor como CSV, que Excel abre directamente">⬇️ Guardar en Excel (CSV)</button>
      {admin && <button className="btn" onClick={() => void aplicar()} disabled={aplicando || !pendientes.length}>
        {aplicando ? "Aplicando…" : `➕ Aplicar pedido (${pendientes.length})`}
      </button>}
    </div>

    {admin && <form className="card card-pad" style={{ maxWidth: 980 }} onSubmit={e => void agregar(e)}>
      <div className="section-head">
        <div>
          <h3>Añadir al pedido</h3>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>Pedido a <strong>{etiquetaProveedor(provActual)}</strong> · solo aparecen sus productos.</p>
        </div>
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="pd-producto">Producto</label>
          <select id="pd-producto" className="input" value={form.codigo} onChange={e => setProducto(e.target.value)} disabled={!productosProv.length} required>
            <option value="">— Elige un producto —</option>
            {productosProv.map(p => <option key={String(p.id)} value={String(p.codigo ?? "")}>{String(p.codigo ?? "")} · {String(p.producto ?? "")}</option>)}
          </select>
          <small>{productosProv.length ? "Solo se muestran los productos de este proveedor." : "Este proveedor no tiene productos: créalos en «Productos disponibles»."}</small>
        </div>
        <div className="field"><label htmlFor="pd-cantidad">Cantidad</label><input id="pd-cantidad" className="input" type="number" step={1} min={1} placeholder="Ej. 24" value={form.cantidad} onChange={e => setForm(f => ({ ...f, cantidad: e.target.value }))} required /></div>
        <div className="field"><label htmlFor="pd-precio">Precio (€)</label><input id="pd-precio" className="input" type="number" step="any" min={0} placeholder="Ej. 3,75" value={form.precio} onChange={e => setForm(f => ({ ...f, precio: e.target.value }))} /></div>
        <div className="field">
          <label htmlFor="pd-origen">Origen</label>
          <select id="pd-origen" className="input" value={form.origen} onChange={e => setForm(f => ({ ...f, origen: e.target.value }))}>
            {ORIGEN_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <small>Sirve para sumar las cantidades pendientes separadas por origen.</small>
        </div>
      </div>
      {formError && <div className="form-error">{formError}</div>}
      <div className="modal-footer"><button className="btn" disabled={guardando || !productosProv.length}>{guardando ? "Añadiendo…" : "＋ Añadir al pedido"}</button></div>
    </form>}

    <div className="card card-pad">
      <div className="section-head">
        <h3>Cantidades pendientes por origen</h3>
        <span className="badge info">🚚 {etiquetaProveedor(provActual)}</span>
      </div>
      <table>
        <thead><tr><th>Origen</th><th className="right">Líneas</th><th className="right">Unidades</th><th className="right">Importe (€)</th></tr></thead>
        <tbody>{totales.map(t => <tr key={t.value}>
          <td>{t.label}</td>
          <td className="right">{formatNum(t.n)}</td>
          <td className="right"><strong>{formatNum(t.uds)}</strong></td>
          <td className="right">{formatNum(t.euros, 2)}</td>
        </tr>)}</tbody>
        <tfoot><tr>
          <td><strong>Total pendiente</strong></td>
          <td className="right"><strong>{formatNum(pendientes.length)}</strong></td>
          <td className="right"><strong>{formatNum(totalUds)}</strong></td>
          <td className="right"><strong>{formatNum(totalEuros, 2)}</strong></td>
        </tr></tfoot>
      </table>
      {!pendientes.length && <p style={{ color: "var(--muted)", margin: "8px 0 0", fontSize: 12.5 }}>
        No hay líneas pendientes de este proveedor: lo que se pida aquí se sumará en «Material de limpieza» al pulsar «Aplicar pedido».
      </p>}
    </div>

    <div className="card">
      {!lineasProv.length
        ? <div className="empty"><span className="icon">🛒</span><strong>Este proveedor no tiene líneas de pedido</strong><p>{admin ? "Añade líneas con el formulario de arriba." : "Todavía no se han añadido líneas para este proveedor."}</p></div>
        : <div className="table-scroll"><table>
          <thead><tr><th>Código</th><th>Producto</th><th>Proveedor</th><th className="right">Cantidad</th><th className="right">Precio (€)</th><th className="right">Importe (€)</th><th>Origen</th><th>Estado</th>{admin && <th className="right">Acciones</th>}</tr></thead>
          <tbody>{lineasProv.map(l => {
            const aplicada = Number(l.aplicado ?? 0) === 1;
            return <tr key={String(l.id)} style={aplicada ? { opacity: 0.6 } : undefined}>
              <td><strong>{String(l.codigo ?? "—")}</strong></td>
              <td>{String(l.producto ?? "—")}</td>
              <td><span className="provider-mini">{String(l.proveedor_codigo ?? "—")}</span> {String(l.proveedor_nombre ?? "")}</td>
              <td className="right">{formatNum(l.cantidad)}</td>
              <td className="right">{precioTexto(l.precio)}</td>
              <td className="right">{formatNum(importe(l.cantidad, l.precio), 2)}</td>
              <td>{String(l.origen ?? "") === "empresa" ? <span className="badge warn">🏢 Empresa</span> : <span className="badge info">🏭 Fábrica</span>}</td>
              <td>{aplicada ? <span className="badge ok">✔ Sumado en material</span> : <span className="badge warn">Pendiente</span>}</td>
              {admin && <td className="right"><div className="row-actions">
                <button className="btn danger small" onClick={() => void borrar(l)}>🗑️ Quitar</button>
              </div></td>}
            </tr>;
          })}</tbody>
        </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {lineasProv.length} líneas de <strong>{etiquetaProveedor(provActual)}</strong> · Al aplicar, cada cantidad se <strong>suma</strong> a las unidades de «Material de limpieza» con el mismo código (y si el código aún no está, se da de alta ahí).
    </p>
    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}
