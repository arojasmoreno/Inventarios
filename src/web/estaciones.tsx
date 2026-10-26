import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import jsQR from "jsqr";
import { api } from "./api";
import { ColorSwatch, Modal, Toast, camposConError, downloadCsv, formatNum } from "./ui";
import { QrLoteModal, QrModal } from "./qr";

type Row = Record<string, unknown>;

// Endpoint de artículos según el tipo de consumible elegido.
const ART_ENDPOINT: Record<string, string> = {
  quimicos: "/api/quimicos",
  material_limpieza: "/api/material-limpieza",
  epis: "/api/epis",
  ropa_trabajo: "/api/ropa-trabajo",
  maquinaria: "/api/maquinaria",
};

const nombreEstacion = (e: Row): string => {
  const partes = [e.zona_nombre, e.subzona_nombre, e.soporte_nombre].filter((v): v is string => Boolean(v));
  return partes.join(" · ") || `Estación #${String(e.id)}`;
};

const etiquetaArt = (tipo: string, r: Row): string => {
  const cod = r.codigo ? `${String(r.codigo)} · ` : "";
  if (tipo === "quimicos") return `${cod}${String(r.nombre ?? "")} · lote ${String(r.numero_lote ?? "—")}`;
  if (tipo === "material_limpieza") return `${cod}${String(r.nombre ?? "")} · ${String(r.color ?? "")}`;
  if (tipo === "epis") return `${cod}${String(r.descripcion ?? r.modelo ?? r.nombre ?? "")}`;
  if (tipo === "ropa_trabajo") return `${cod}${String(r.prenda ?? "")}`;
  return `${cod}${String(r.nombre ?? "")}`;
};

const fechaCorta = (v: unknown) => String(v ?? "").replace("T", " ").slice(0, 16);

/** Página de estaciones: lista CRUD + modo estación (QR) para descontar stock. */
export function EstacionesPage({ user }: { user: { rol: string; nombre: string } }) {
  const [modoId, setModoId] = useState<number | null>(() => {
    if (typeof window === "undefined") return null; // render SSR
    const m = /consumo=(\d+)/.exec(window.location.hash);
    return m ? Number(m[1]) : null;
  });
  useEffect(() => {
    const onHash = () => {
      const m = /consumo=(\d+)/.exec(window.location.hash);
      setModoId(m ? Number(m[1]) : null);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  if (modoId !== null) {
    return <EstacionModo key={modoId} id={modoId} user={user} onExit={() => { window.location.hash = "#/estaciones"; }} />;
  }
  return <EstacionesLista user={user} onModo={(id) => { window.location.hash = `#/estaciones?consumo=${id}`; }} />;
}

// ---------------------------------------------------------------- Lista CRUD
function EstacionesLista({ user, onModo }: { user: { rol: string }; onModo: (id: number) => void }) {
  const [items, setItems] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [zonas, setZonas] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  // Filtros: la lista puede abrirse ya filtrada desde «Zonas» (#/estaciones?zona=ID).
  const [fCentro, setFCentro] = useState("all");
  const [fZona, setFZona] = useState<string>(() => {
    if (typeof window === "undefined") return "all"; // render SSR
    return /zona=(\d+)/.exec(window.location.hash)?.[1] ?? "all";
  });
  const [busyId, setBusyId] = useState<number | null>(null);
  const [fBajo, setFBajo] = useState(false);
  const [qrLote, setQrLote] = useState<Row[] | null>(null);
  const [editing, setEditing] = useState<Row | null | "new">(null);
  const [qrRow, setQrRow] = useState<Row | null>(null);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const canWrite = user.rol === "admin";
  // Los usuarios consultan las estaciones pero no exportan la tabla.
  const puedeDescargar = user.rol !== "usuario";

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [e, c, z] = await Promise.all([
        api.get<{ items: Row[] }>("/api/estaciones"),
        api.get<{ items: Row[] }>("/api/centros"),
        api.get<{ items: Row[] }>("/api/zonas"),
      ]);
      setItems(e.items); setCentros(c.items); setZonas(z.items);
    }
    catch (e) { setError(e instanceof Error ? e.message : "Error cargando estaciones"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((e) =>
      (fCentro === "all" || String(e.centro_id) === fCentro) &&
      (fZona === "all" || String(e.zona_id) === fZona) &&
      (!fBajo || (Number(e.articulo_stock_minimo ?? 0) > 0 && Number(e.articulo_stock ?? 0) <= Number(e.articulo_stock_minimo))) &&
      (!needle || [nombreEstacion(e), e.centro_nombre, e.tipo_nombre, e.articulo_nombre, e.articulo_codigo]
        .some((v) => String(v ?? "").toLowerCase().includes(needle))));
  }, [items, q, fCentro, fZona, fBajo]);

  // Estaciones cuyo artículo ha llegado al stock mínimo (o por debajo).
  const conStockBajo = useMemo(
    () => items.filter((e) => Number(e.articulo_stock_minimo ?? 0) > 0 && Number(e.articulo_stock ?? 0) <= Number(e.articulo_stock_minimo)),
    [items],
  );

  // Listado agrupado por centro › zona › subzona (enlazado con la página «Zonas»).
  const grupos = useMemo(() => {
    const map = new Map<string, { titulo: string; rows: Row[] }>();
    for (const e of filtered) {
      const partes = [e.centro_nombre, e.zona_nombre, e.subzona_nombre].map((v) => String(v ?? "—"));
      const key = partes.join("¦");
      let g = map.get(key);
      if (!g) { g = { titulo: partes.join(" › "), rows: [] }; map.set(key, g); }
      g.rows.push(e);
    }
    return [...map.values()];
  }, [filtered]);

  const zonasOptions = useMemo(
    () => zonas.filter((z) => fCentro === "all" || String(z.centro_id) === fCentro),
    [zonas, fCentro],
  );

  // Botón «−1»: descuenta de inmediato una unidad del consumible de la estación.
  const descontar1 = async (row: Row) => {
    const id = Number(row.id);
    setBusyId(id);
    try {
      const r = await api.post<{ mensaje?: string }>(`/api/estaciones/${id}/consumir`, { cantidad: 1 });
      setToast({ message: r.mensaje ?? "1 unidad descontada", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo descontar la unidad", kind: "error" }); }
    finally { setBusyId(null); }
  };

  const remove = async (row: Row) => {
    if (!window.confirm(`¿Eliminar la estación «${nombreEstacion(row)}»? Esta acción no se puede deshacer.`)) return;
    try {
      await api.del(`/api/estaciones/${String(row.id)}`);
      setToast({ message: "Estación eliminada", kind: "ok" });
      await load();
    } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); }
  };

  const exportCsv = () => {
    downloadCsv(`estaciones-${new Date().toISOString().slice(0, 10)}.csv`,
      ["Estación", "Centro", "Zona", "Subzona", "Soporte", "Tipo de consumible", "Artículo", "Stock", "Activa"],
      filtered.map((e) => [
        nombreEstacion(e), String(e.centro_nombre ?? ""), String(e.zona_nombre ?? ""), String(e.subzona_nombre ?? ""),
        String(e.soporte_nombre ?? ""), String(e.tipo_nombre ?? ""), String(e.articulo_nombre ?? ""),
        String(e.articulo_stock ?? "0"), Number(e.activo) === 1 ? "Sí" : "No",
      ]));
  };

  if (loading) return <div className="loading">Cargando estaciones…</div>;
  if (error) return <div className="card empty">⚠️ {error}</div>;
  return <>
    <div className="toolbar no-print">
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar estación…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 200 }} value={fCentro} onChange={(e) => { setFCentro(e.target.value); setFZona("all"); }} aria-label="Filtrar por centro">
        <option value="all">Todos los centros</option>
        {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <select className="input" style={{ maxWidth: 200 }} value={fZona} onChange={(e) => setFZona(e.target.value)} aria-label="Filtrar por zona">
        <option value="all">Todas las zonas</option>
        {zonasOptions.map((z) => <option key={String(z.id)} value={String(z.id)}>{String(z.nombre)}</option>)}
      </select>
      <button className="chip" style={{ padding: "7px 12px" }} onClick={() => setFBajo((v) => !v)} aria-pressed={fBajo}>
        📉 Stock bajo{conStockBajo.length ? ` (${conStockBajo.length})` : ""}
      </button>
      <div className="spacer" />
      <button className="btn secondary" onClick={() => setQrLote(filtered)} disabled={!filtered.length}>🖨️ QR ({filtered.length})</button>
      {puedeDescargar && <button className="btn secondary" onClick={exportCsv} disabled={!filtered.length}>⬇️ CSV</button>}
      {canWrite && <button className="btn" onClick={() => setEditing("new")}>＋ Nueva estación</button>}
    </div>
    <div className="card">
      {!filtered.length
        ? <div className="empty"><span className="icon">🚻</span><strong>No hay estaciones</strong>
            <p>{q || fCentro !== "all" || fZona !== "all" || fBajo
              ? "Ninguna estación coincide con la búsqueda o los filtros actuales."
              : "Crea estaciones de consumo: cada una apunta a una zona, subzona y soporte, y descuenta su artículo al escanear el QR."}</p></div>
        : <div className="table-scroll"><table>
          <thead><tr>
            <th>Estación</th><th>Centro</th><th>Tipo de consumible</th><th>Artículo</th>
            <th className="right">Stock</th><th>Estado</th><th>Último consumo</th><th className="right">Acciones</th>
          </tr></thead>
          <tbody>{grupos.map((g) => <Fragment key={g.titulo}>
            <tr className="grp"><td colSpan={8}>📍 {g.titulo} · {g.rows.length} estación{g.rows.length === 1 ? "" : "es"}</td></tr>
            {g.rows.map((e) => <tr key={String(e.id)}>
            <td>
              {/* Cuadrado con el color del consumible de la estación
                  (código de segregación del material). */}
              <ColorSwatch color={String(e.articulo_color ?? "")} />
              <strong>{nombreEstacion(e)}</strong>
              {/* Botón «−1» en la primera columna: en móvil se ve sin desplazar
                  la tabla y no hay que tocar la columna de acciones. */}
              <div className="row-actions" style={{ justifyContent: "flex-start", marginTop: 6 }}>
                <button className="btn small" title="Descuenta ahora 1 unidad del consumible de esta estación"
                  onClick={() => void descontar1(e)}
                  disabled={busyId === Number(e.id) || Number(e.activo) !== 1 || Number(e.articulo_stock ?? 0) < 1}>
                  {busyId === Number(e.id) ? "Descontando…" : "➖ −1 ud"}
                </button>
              </div>
            </td>
            <td>{String(e.centro_nombre ?? "—")}</td>
            <td>{String(e.tipo_nombre ?? "—")}</td>
            <td>{String(e.articulo_nombre ?? "—")}{e.articulo_codigo ? <span style={{ color: "var(--muted)" }}> · {String(e.articulo_codigo)}</span> : null}</td>
            <td className="right">{formatNum(e.articulo_stock)}
              {Number(e.articulo_stock_minimo ?? 0) > 0 && Number(e.articulo_stock ?? 0) <= Number(e.articulo_stock_minimo)
                ? <> <span className="badge danger">⚠️ mín. {formatNum(e.articulo_stock_minimo)}</span></> : null}</td>
            <td>{Number(e.activo) === 1 ? <span className="badge ok">Activa</span> : <span className="badge muted">Desactivada</span>}</td>
            <td>{e.ultimo_consumo_fecha
              ? <><span style={{ color: "var(--muted)", fontSize: 12 }}>{fechaCorta(e.ultimo_consumo_fecha)}</span><br /><span style={{ fontSize: 12 }}>{String(e.ultimo_consumo_detalle ?? "—")}</span></>
              : "—"}</td>
            <td className="right"><div className="row-actions">
              <button className="btn secondary small" onClick={() => setQrRow(e)}>🏷️ QR</button>
              <button className="btn secondary small" onClick={() => onModo(Number(e.id))}>▶ Consumir</button>
              {canWrite && <>
                <button className="btn secondary small" onClick={() => setEditing(e)}>✏️ Editar</button>
                <button className="btn danger small" onClick={() => void remove(e)}>🗑️ Borrar</button>
              </>}
            </div></td>
          </tr>)}
          </Fragment>)}</tbody>
        </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {filtered.length} de {items.length} estaciones · agrupadas por centro › zona › subzona · «➖ −1 ud» (primera columna) descuenta una unidad al instante y el QR abre el modo estación para descontar más unidades y poder deshacerlo.
    </p>
    {qrRow && <QrModal tipo="estacion" id={Number(qrRow.id)} title={nombreEstacion(qrRow)} onClose={() => setQrRow(null)} />}
    {qrLote && <QrLoteModal
      items={qrLote.map((e) => ({ id: Number(e.id), title: nombreEstacion(e) }))}
      subtitle="Una etiqueta por estación, lista para pegar en su soporte"
      onClose={() => setQrLote(null)} />}
    {editing && <EstacionForm initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={async (msg) => { setEditing(null); setToast({ message: msg, kind: "ok" }); await load(); }} />}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}

// ------------------------------------------------------------ Formulario CRUD
function EstacionForm({ initial, onClose, onSaved }: { initial: Row | null; onClose: () => void; onSaved: (msg: string) => void }) {
  const [centros, setCentros] = useState<Row[]>([]);
  const [zonas, setZonas] = useState<Row[]>([]);
  const [subzonas, setSubzonas] = useState<Row[]>([]);
  const [soportes, setSoportes] = useState<Row[]>([]);
  const [tipos, setTipos] = useState<Row[]>([]);
  const [articulos, setArticulos] = useState<Row[]>([]);
  const [values, setValues] = useState<Record<string, string | boolean>>(() => ({
    centro_id: initial ? String(initial.centro_id ?? "") : "",
    zona_id: initial ? String(initial.zona_id ?? "") : "",
    subzona_id: initial && initial.subzona_id != null ? String(initial.subzona_id) : "",
    soporte_id: initial && initial.soporte_id != null ? String(initial.soporte_id) : "",
    tipo_consumible_id: initial ? String(initial.tipo_consumible_id ?? "") : "",
    articulo_id: initial ? String(initial.articulo_id ?? "") : "",
    activo: initial ? Number(initial.activo) === 1 : true,
  }));
  const [formError, setFormError] = useState<string | null>(null);
  // Campos que han fallado al validar (se sombrean en rojo); la clave es el id del campo.
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<{ items: Row[] }>("/api/centros"),
      api.get<{ items: Row[] }>("/api/zonas"),
      api.get<{ items: Row[] }>("/api/subzonas"),
      api.get<{ items: Row[] }>("/api/soportes"),
      api.get<{ items: Row[] }>("/api/consumibles-tipos"),
    ]).then(([c, z, s, sp, t]) => {
      setCentros(c.items); setZonas(z.items); setSubzonas(s.items); setSoportes(sp.items); setTipos(t.items);
    }).catch(() => setFormError("No se pudieron cargar los catálogos"));
  }, []);

  const tipoId = String(values.tipo_consumible_id ?? "");
  const tipo = tipos.find((t) => String(t.id) === tipoId);
  const articuloTipo = String(tipo?.articulo_tipo ?? (initial ? initial.articulo_tipo : "") ?? "");

  // Carga los artículos del tipo elegido (dependencia tipo → artículo).
  useEffect(() => {
    const ep = ART_ENDPOINT[articuloTipo];
    if (!ep) { setArticulos([]); return; }
    let alive = true;
    api.get<{ items: Row[] }>(ep).then((r) => { if (alive) setArticulos(r.items); }).catch(() => { if (alive) setArticulos([]); });
    return () => { alive = false; };
  }, [articuloTipo]);

  const zonasDelCentro = useMemo(() => zonas.filter((z) => String(z.centro_id) === String(values.centro_id)), [zonas, values.centro_id]);
  const subsDeZona = useMemo(() => subzonas.filter((s) => String(s.zona_id) === String(values.zona_id)), [subzonas, values.zona_id]);

  const set = (k: string, v: string | boolean) => {
    const ef = ETIQUETAS[k]?.ef;
    if (ef) setCampoErr((prevErr) => prevErr.filter((x) => x !== ef));
    setValues((prev) => {
      const next = { ...prev, [k]: v };
      // Cascadas: cambiar centro limpia zona/subzona; cambiar zona limpia subzona.
      if (k === "centro_id") { next.zona_id = ""; next.subzona_id = ""; }
      if (k === "zona_id") next.subzona_id = "";
      if (k === "tipo_consumible_id") next.articulo_id = "";
      return next;
    });
  };

  const save = async () => {
    setSaving(true); setFormError(null);
    try {
      const payload = {
        centro_id: Number(values.centro_id),
        zona_id: Number(values.zona_id),
        subzona_id: values.subzona_id === "" ? null : Number(values.subzona_id),
        soporte_id: values.soporte_id === "" ? null : Number(values.soporte_id),
        tipo_consumible_id: Number(values.tipo_consumible_id),
        articulo_id: Number(values.articulo_id),
        activo: values.activo ? 1 : 0,
      };
      if (initial) { await api.put(`/api/estaciones/${String(initial.id)}`, payload); onSaved("Estación actualizada"); }
      else { await api.post("/api/estaciones", payload); onSaved("Estación creada"); }
    } catch (e) { const msg = e instanceof Error ? e.message : "No se pudo guardar la estación"; setFormError(msg); setCampoErr(camposConError(msg, Object.values(ETIQUETAS).map(({ ef, etiqueta }) => ({ clave: ef, etiqueta })))); }
    finally { setSaving(false); }
  };

  const sel = (id: string, label: string, value: string, opts: Array<{ v: string; l: string }>, onChange: (v: string) => void, placeholder = "— Sin asignar —") => {
    const hay = campoErr.includes(id);
    return <div className={"field" + (hay ? " error" : "")}><label htmlFor={id}>{label}</label>
      <select id={id} className={"input" + (hay ? " error" : "")} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
      </select>
    </div>;
  };

  return <Modal
    title={initial ? "Editar estación" : "Nueva estación de consumo"}
    subtitle="Centro → zona → subzona → soporte → tipo → artículo"
    onClose={onClose}
  >
    {formError && <div className="form-error">{formError}</div>}
    <div className="form-grid">
      {sel("ef-centro", "Centro *", String(values.centro_id), centros.map((c) => ({ v: String(c.id), l: String(c.nombre) })), (v) => set("centro_id", v), "— Elige centro —")}
      {sel("ef-zona", "Zona *", String(values.zona_id), zonasDelCentro.map((z) => ({ v: String(z.id), l: String(z.nombre) })), (v) => set("zona_id", v), zonasDelCentro.length ? "— Elige zona —" : "Primero el centro")}
      {sel("ef-sub", "Subzona", String(values.subzona_id), subsDeZona.map((s) => ({ v: String(s.id), l: String(s.nombre) })), (v) => set("subzona_id", v))}
      {sel("ef-soporte", "Soporte", String(values.soporte_id), soportes.map((s) => ({ v: String(s.id), l: String(s.nombre) })), (v) => set("soporte_id", v))}
      {sel("ef-tipo", "Tipo de consumible *", tipoId, tipos.map((t) => ({ v: String(t.id), l: String(t.nombre) })), (v) => set("tipo_consumible_id", v), "— Elige tipo —")}
      {sel("ef-art", "Artículo *", String(values.articulo_id), articulos.map((a) => ({ v: String(a.id), l: etiquetaArt(articuloTipo, a) })), (v) => set("articulo_id", v), articulos.length ? "— Elige artículo —" : "Primero el tipo")}
      <div className="full">
        <label className="field checkbox" htmlFor="ef-activo">
          <input id="ef-activo" type="checkbox" checked={values.activo === true} onChange={(e) => set("activo", e.target.checked)} />
          <span>Estación activa (responde al QR y permite consumir)</span>
        </label>
      </div>
    </div>
    <div className="modal-footer">
      <button className="btn secondary" onClick={onClose}>Cancelar</button>
      <button className="btn" onClick={() => void save()} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</button>
    </div>
  </Modal>;
}

// Campo del formulario → id del control y etiqueta, para localizar el campo
// que ha fallado en un mensaje de validación y sombrearlo en rojo.
const ETIQUETAS: Record<string, { ef: string; etiqueta: string }> = {
  centro_id: { ef: "ef-centro", etiqueta: "Centro" },
  zona_id: { ef: "ef-zona", etiqueta: "Zona" },
  subzona_id: { ef: "ef-sub", etiqueta: "Subzona" },
  soporte_id: { ef: "ef-soporte", etiqueta: "Soporte" },
  tipo_consumible_id: { ef: "ef-tipo", etiqueta: "Tipo de consumible" },
  articulo_id: { ef: "ef-art", etiqueta: "Artículo" },
};

// ------------------------------------------------------------- Modo estación
type Detector = { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type BarcodeDetectorCtor = new (o: { formats: string[] }) => Detector;

function EstacionModo({ id, user, onExit }: { id: number; user: { nombre: string }; onExit: () => void }) {
  const [item, setItem] = useState<Row | null>(null);
  const [historial, setHistorial] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const [cantidad, setCantidad] = useState("1");
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [it, hist] = await Promise.all([
        api.get<{ item: Row }>(`/api/estaciones/${id}`),
        api.get<{ items: Row[] }>(`/api/estaciones/${id}/movimientos?limit=5`).catch(() => ({ items: [] as Row[] })),
      ]);
      setItem(it.item); setHistorial(hist.items);
    }
    catch (e) { setItem(null); setError(e instanceof Error ? e.message : "Estación no encontrada"); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setScanning(false);
  }, []);
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const handleCode = (raw: string) => {
    const m = /estaciones\?consumo=(\d+)/.exec(raw);
    if (!m) { setError("Ese QR no es el de una estación"); return; }
    const nuevo = Number(m[1]);
    stopScan();
    if (nuevo === id) { void load(); } else { window.location.hash = `#/estaciones?consumo=${nuevo}`; }
  };

  const startScan = async () => {
    setError(null); setMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no permite acceder a la cámara; introduce el enlace del QR a mano.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream; setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (Ctor) {
        const detector = new Ctor({ formats: ["qr_code"] });
        const tick = async () => {
          if (!streamRef.current) return;
          try {
            const found = await detector.detect(video);
            if (found.length) { handleCode(found[0].rawValue); return; }
          } catch { /* fotograma aún no analizable */ }
          window.setTimeout(() => { void tick(); }, 300);
        };
        void tick();
      } else {
        // Fallback p.ej. iPhone/Safari: decodifica los fotogramas con jsQR.
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tickJs = () => {
          if (!streamRef.current) return;
          if (video.readyState >= 2 && video.videoWidth > 0) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx?.drawImage(video, 0, 0);
            const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            if (img) { const code = jsQR(img.data, img.width, img.height); if (code?.data) { handleCode(code.data); return; } }
          }
          window.setTimeout(tickJs, 250);
        };
        tickJs();
      }
    } catch { setError("No se pudo acceder a la cámara"); stopScan(); }
  };

  const consumir = async () => {
    if (!item) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<{ mensaje?: string }>(`/api/estaciones/${id}/consumir`, { cantidad: Number(cantidad) });
      setMsg({ message: r.mensaje ?? "Stock descontado", kind: "ok" });
      await load();
    } catch (e) { setMsg({ message: e instanceof Error ? e.message : "No se pudo descontar el stock", kind: "error" }); }
    finally { setBusy(false); }
  };

  const deshacer = async () => {
    setBusy(true); setError(null); setMsg(null);
    try {
      const r = await api.post<{ mensaje?: string }>(`/api/estaciones/${id}/deshacer`, {});
      setMsg({ message: r.mensaje ?? "Consumo deshecho", kind: "ok" });
      await load();
    } catch (e) { setMsg({ message: e instanceof Error ? e.message : "No se pudo deshacer el consumo", kind: "error" }); }
    finally { setBusy(false); }
  };

  if (error && !item) return <div className="station-card">
    <div className="station-error">{error}</div>
    <button className="btn secondary" style={{ marginTop: 14 }} onClick={onExit}>← Volver a estaciones</button>
  </div>;
  if (!item) return <div className="loading">Cargando estación…</div>;

  const ultimo = item.ultimo_consumo_id != null;
  return <div className="station-card">
    <div className="station-head">
      <span className="station-icon">🚻</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="station-title">{nombreEstacion(item)}</div>
        <div className="station-muted">{String(item.centro_nombre ?? "—")}{item.tipo_nombre ? ` · ${String(item.tipo_nombre)}` : ""}</div>
      </div>
      <button className="station-exit" onClick={onExit}>✕ Salir</button>
    </div>

    <div className="station-stock">
      <div className="station-stock-label">{String(item.articulo_nombre ?? "Artículo")}</div>
      <div className="station-stock-value">{formatNum(item.articulo_stock)}</div>
      <div className="station-stock-label">unidades disponibles</div>
      {item.articulo_lote ? <div className="station-muted">Lote: {String(item.articulo_lote)}</div> : null}
      {!item.articulo_lote && item.articulo_color ? <div className="station-muted">Color: {String(item.articulo_color)}</div> : null}
      {Number(item.articulo_stock_minimo ?? 0) > 0 && Number(item.articulo_stock ?? 0) <= Number(item.articulo_stock_minimo)
        ? <div className="station-error" style={{ marginTop: 4 }}>⚠️ Stock mínimo: {formatNum(item.articulo_stock_minimo)} ud.</div> : null}
    </div>

    {Number(item.activo) !== 1 && <div className="station-feedback station-error">Esta estación está desactivada: no admite consumos.</div>}
    {msg && <div className={`station-feedback ${msg.kind === "ok" ? "station-ok" : "station-error"}`}>{msg.message}</div>}
    {error && <div className="station-feedback station-error">{error}</div>}

    <div className="station-controls" style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div className="field" style={{ width: 140 }}>
        <label htmlFor="st-cant-modo">Cantidad</label>
        <input id="st-cant-modo" className="input" type="number" min={1} max={100} step={1} value={cantidad} onChange={(e) => setCantidad(e.target.value)} />
      </div>
      <button className="station-btn" onClick={() => void consumir()} disabled={busy || Number(item.activo) !== 1 || !(Number(cantidad) >= 1)}>
        {busy ? "Procesando…" : `Descontar ${Number(cantidad) >= 1 ? cantidad : ""} unidad${Number(cantidad) === 1 ? "" : "es"}`}
      </button>
    </div>

    <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10 }} aria-label="Cantidades rápidas">
      <span className="station-muted" style={{ alignSelf: "center" }}>Rápida:</span>
      {[1, 2, 5].map((n) => <button key={n} className={"btn " + (Number(cantidad) === n ? "" : "secondary")} style={{ minWidth: 58, justifyContent: "center" }}
        onClick={() => setCantidad(String(n))}>{n} ud.</button>)}
    </div>

    <div className="station-last">
      {ultimo
        ? <>
            <div className="station-muted">Último consumo: <strong>{String(item.ultimo_consumo_detalle ?? "")}</strong> · {formatNum(item.ultimo_consumo_cantidad)} ud. · {fechaCorta(item.ultimo_consumo_fecha)}</div>
            <button className="btn secondary" onClick={() => void deshacer()} disabled={busy}>↩ Deshacer último consumo</button>
          </>
        : <div className="station-muted">Sin consumos pendientes de deshacer en esta estación.</div>}
    </div>

    {historial.length > 0 && <div style={{ marginTop: 12, borderTop: "1px dashed var(--border)", paddingTop: 10 }}>
      <div className="station-muted" style={{ marginBottom: 6 }}>Últimos movimientos</div>
      {historial.map((h) => <div key={String(h.id)} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 12.5, padding: "2px 0" }}>
        <span style={{ color: "var(--muted)", whiteSpace: "nowrap" }}>{fechaCorta(h.created_at)}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "left" }}>
          {String(h.descripcion ?? "—")}{h.usuario_nombre ? <span style={{ color: "var(--muted)" }}> · {String(h.usuario_nombre)}</span> : null}
        </span>
        <strong style={{ whiteSpace: "nowrap" }}>{String(h.accion) === "deshacer_consumo" ? "+" : "−"}{formatNum(h.cantidad)}</strong>
      </div>)}
    </div>}

    <div className="station-scan" style={{ marginTop: 14 }}>
      {scanning
        ? <div><video ref={videoRef} className="scan-video" muted playsInline /><div><button className="btn secondary small" style={{ marginTop: 8 }} onClick={stopScan}>Detener cámara</button></div></div>
        : <>
            <button className="btn secondary" onClick={() => void startScan()}>📷 Escanear otra estación</button>
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <input className="input" placeholder="https://…/#/estaciones?consumo=1" value={manual} onChange={(e) => setManual(e.target.value)} />
              <button className="btn secondary" onClick={() => handleCode(manual.trim())} disabled={!manual.trim()}>Cargar</button>
            </div>
          </>}
    </div>
    <div className="station-muted" style={{ marginTop: 14 }}>Sesión: <span className="station-user">{user.nombre}</span></div>
  </div>;
}
