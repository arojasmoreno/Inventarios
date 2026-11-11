import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Modal, Toast, downloadCsv, formatFecha, formatNum } from "./ui";
import { bajoMinimo, faltanteHastaMinimo, sugerenciasReposicion } from "./reposicion";

type Row = Record<string, unknown>;
type Estado = "borrador" | "enviado" | "recibido" | "aplicado";
type Aviso = { message: string; kind: "ok" | "error" };

const ESTADOS: Array<{ id: Estado; label: string; icon: string; badge: string }> = [
  { id: "borrador", label: "Borrador", icon: "📝", badge: "muted" },
  { id: "enviado", label: "Enviado", icon: "📤", badge: "info" },
  { id: "recibido", label: "Recibido", icon: "📦", badge: "warn" },
  { id: "aplicado", label: "Aplicado", icon: "✅", badge: "ok" },
];
const estadoInfo = (e: unknown) => ESTADOS.find((x) => x.id === String(e)) ?? ESTADOS[0];
const origenTexto = (v: unknown): string => (String(v ?? "") === "fabrica" ? "Fábrica" : "Empresa");
const importe = (cantidad: unknown, precio: unknown): number => Number(cantidad ?? 0) * Number(precio ?? 0);

function EstadoBadge({ estado }: { estado: unknown }) {
  const info = estadoInfo(estado);
  return <span className={`badge ${info.badge}`}>{info.icon} {info.label}</span>;
}

/** Descarga la hoja del pedido en CSV, que Excel abre directamente: cabecera
 *  con centro, proveedor, albarán y estado, y una fila por producto. */
function descargarPedido(pedido: Row, lineas: Row[]): void {
  const unidades = lineas.reduce((n, l) => n + Number(l.cantidad ?? 0), 0);
  const euros = lineas.reduce((n, l) => n + importe(l.cantidad, l.precio), 0);
  const numero = String(pedido.numero ?? "pedido");
  downloadCsv(
    `pedido-${numero}-${String(pedido.centro_nombre ?? "").replace(/[^\w\-]+/g, "_")}.csv`,
    ["Pedido", numero, "", "", "", ""],
    [
      ["Centro", String(pedido.centro_nombre ?? ""), "", "", "", ""],
      ["Proveedor", String(pedido.proveedor_nombre ?? "—"), "", "", "", ""],
      ["Fecha", formatFecha(pedido.fecha), "", "", "", ""],
      ["Estado", estadoInfo(pedido.estado).label, "", "", "", ""],
      ["Albarán", String(pedido.albaran ?? "—"), "", "", "", ""],
      ["", "", "", "", "", ""],
      ["Código", "Producto", "Cantidad", "Precio (€)", "Importe (€)", "Origen"],
      ...lineas.map((l) => [
        String(l.codigo ?? ""), String(l.producto ?? ""), Number(l.cantidad ?? 0),
        l.precio == null || l.precio === "" ? "" : formatNum(l.precio, 2),
        formatNum(importe(l.cantidad, l.precio), 2), origenTexto(l.origen),
      ]),
      ["", "Total", unidades, "", formatNum(euros, 2), ""],
    ],
  );
}

interface Opciones {
  centros: Array<{ id: number; nombre: string }>;
  proveedores: Array<{ id: number; codigo: string; nombre: string }>;
  productos: Row[];
  puede_gestionar: boolean;
}

// ─────────────────────────────── Listado ─────────────────────────────────────
/** Pedidos de consumibles: cada centro genera el suyo, se manda a un proveedor,
 *  se recepciona con albarán y recuento y, al final, entra en el stock. */
export function PedidosPage({ user }: { user: { rol: string } }) {
  const [opciones, setOpciones] = useState<Opciones | null>(null);
  const [centroFiltro, setCentroFiltro] = useState("");
  const [estadoFiltro, setEstadoFiltro] = useState("");
  const [items, setItems] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [detalleId, setDetalleId] = useState<number | null>(null);
  const [nuevo, setNuevo] = useState(false);

  const cargar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (centroFiltro) params.set("centro_id", centroFiltro);
      if (estadoFiltro) params.set("estado", estadoFiltro);
      const [lista, ops] = await Promise.all([
        api.get<{ items: Row[]; total: number; puede_gestionar: boolean; centros: Opciones["centros"] }>(`/api/pedidos${params.size ? `?${params.toString()}` : ""}`),
        api.get<Opciones>("/api/pedidos/opciones"),
      ]);
      setItems(lista.items);
      setTotal(lista.total);
      setOpciones(ops);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar los pedidos");
    } finally {
      setLoading(false);
    }
  }, [centroFiltro, estadoFiltro]);
  useEffect(() => { void cargar(); }, [cargar]);

  const proveedores = opciones?.proveedores ?? [];
  const centros = opciones?.centros ?? [];
  const puedeGestionar = opciones?.puede_gestionar ?? user.rol !== "usuario";

  const resumen = useMemo(() => {
    const abiertos = items.filter((p) => String(p.estado) !== "aplicado");
    return {
      abiertos: abiertos.length,
      unidades: items.reduce((n, p) => n + Number(p.unidades ?? 0), 0),
      importe: items.reduce((n, p) => n + Number(p.importe ?? 0), 0),
      reclamaciones: items.reduce((n, p) => n + Number(p.reclamaciones ?? 0), 0),
    };
  }, [items]);

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      <select className="input" style={{ maxWidth: 240 }} value={centroFiltro} onChange={(e) => setCentroFiltro(e.target.value)} aria-label="Filtrar por centro">
        <option value="">Todos los centros</option>
        {centros.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
      </select>
      <select className="input" style={{ maxWidth: 200 }} value={estadoFiltro} onChange={(e) => setEstadoFiltro(e.target.value)} aria-label="Filtrar por estado">
        <option value="">Todos los estados</option>
        {ESTADOS.map((e) => <option key={e.id} value={e.id}>{e.icon} {e.label}</option>)}
      </select>
      <div className="spacer" />
      {puedeGestionar && <button className="btn" onClick={() => setNuevo(true)} disabled={!centros.length || !proveedores.length} title={!proveedores.length ? "Da de alta un proveedor para poder pedir" : undefined}>＋ Nuevo pedido</button>}
    </div>

    {!proveedores.length && !loading && <div className="banner warn no-print">
      Todavía no hay proveedores: créalos en la pestaña «Proveedores» para poder generar pedidos.
    </div>}

    <div className="kpis no-print">
      <div className="kpi"><div className="label">Pedidos abiertos</div><div className="value">{formatNum(resumen.abiertos)}</div><div className="kpi-sub">sin aplicar al stock</div></div>
      <div className="kpi"><div className="label">Unidades pedidas</div><div className="value">{formatNum(resumen.unidades)}</div><div className="kpi-sub">en los pedidos listados</div></div>
      <div className="kpi"><div className="label">Importe</div><div className="value">{formatNum(resumen.importe, 2)} €</div><div className="kpi-sub">precio de catálogo</div></div>
      <div className={"kpi" + (resumen.reclamaciones ? " alert" : "")}><div className="label">Líneas a reclamar</div><div className="value">{formatNum(resumen.reclamaciones)}</div><div className="kpi-sub">con diferencia al recibir</div></div>
    </div>

    <div className="card">
      {loading ? <div className="loading">Cargando pedidos…</div>
        : error ? <div className="empty">⚠️ {error}</div>
        : !items.length ? <div className="empty">
          <span className="icon">🧾</span>
          <strong>No hay pedidos</strong>
          <p>{puedeGestionar ? "Crea el primer pedido: elige centro, proveedor y productos; después lo descargas en Excel y lo mandas." : "Todavía no se han creado pedidos para tus centros."}</p>
          {puedeGestionar && centros.length > 0 && proveedores.length > 0 && <button className="btn" onClick={() => setNuevo(true)}>＋ Crear pedido</button>}
        </div>
        : <div className="table-scroll"><table>
          <thead><tr>
            <th>Pedido</th><th>Fecha</th><th>Centro</th><th>Proveedor</th>
            <th className="right">Líneas</th><th className="right">Unidades</th><th className="right">Importe (€)</th>
            <th>Estado</th><th>Albarán</th><th className="right">Acciones</th>
          </tr></thead>
          <tbody>{items.map((p) => {
            const reclamaciones = Number(p.reclamaciones ?? 0);
            return <tr key={String(p.id)}>
              <td><strong>{String(p.numero ?? "—")}</strong>{reclamaciones > 0 && <div><span className="badge danger">⚠️ {reclamaciones} a reclamar</span></div>}</td>
              <td>{formatFecha(p.fecha)}</td>
              <td>{String(p.centro_nombre ?? "—")}</td>
              <td>{String(p.proveedor_codigo ?? "")}{p.proveedor_codigo ? " · " : ""}{String(p.proveedor_nombre ?? "—")}</td>
              <td className="right">{formatNum(p.lineas)}</td>
              <td className="right">{formatNum(p.unidades)}</td>
              <td className="right">{formatNum(p.importe, 2)}</td>
              <td><EstadoBadge estado={p.estado} /></td>
              <td>{p.albaran ? String(p.albaran) : "—"}</td>
              <td className="right"><div className="row-actions">
                <button className="btn secondary small" onClick={() => setDetalleId(Number(p.id))}>Abrir</button>
                <button className="btn secondary small" title="Descargar el pedido en Excel" onClick={() => void abrirYDescargar(Number(p.id), setAviso)}>⬇️ Excel</button>
              </div></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {formatNum(total)} pedidos · Cada centro genera su pedido, que se manda a un proveedor. Al recibirlo se apunta el <strong>número de albarán</strong> y se cuenta lo que ha llegado; después se suma al stock.
    </p>

    {nuevo && opciones && <NuevoPedidoModal
      opciones={opciones}
      onClose={() => setNuevo(false)}
      onCreado={(mensaje) => { setNuevo(false); setAviso({ message: mensaje, kind: "ok" }); void cargar(); }}
    />}

    {detalleId !== null && <PedidoDetalleModal
      id={detalleId}
      productos={opciones?.productos ?? []}
      onClose={() => setDetalleId(null)}
      onAviso={setAviso}
      onCambio={() => void cargar()}
    />}

    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}

/** Abre el pedido y descarga su Excel sin salir del listado. */
async function abrirYDescargar(id: number, onAviso: (a: Aviso) => void): Promise<void> {
  try {
    const r = await api.get<{ pedido: Row; lineas: Row[] }>(`/api/pedidos/${id}`);
    descargarPedido(r.pedido, r.lineas);
  } catch (e) {
    onAviso({ message: e instanceof Error ? e.message : "No se pudo descargar el pedido", kind: "error" });
  }
}

// ─────────────────────────────── Nuevo pedido ───────────────────────────────
function NuevoPedidoModal({ opciones, onClose, onCreado }: {
  opciones: Opciones;
  onClose: () => void;
  onCreado: (mensaje: string) => void;
}) {
  const [centroId, setCentroId] = useState(String(opciones.centros[0]?.id ?? ""));
  const [proveedorId, setProveedorId] = useState(String(opciones.proveedores[0]?.id ?? ""));
  const [notas, setNotas] = useState("");
  const [q, setQ] = useState("");
  // Origen de las líneas del pedido (fábrica o empresa gestora).
  const [origen, setOrigen] = useState("empresa");
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [sugeridos, setSugeridos] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Solo los productos del proveedor elegido: un pedido va a un proveedor.
  const productosProveedor = useMemo(() => opciones.productos.filter((p) => String(p.proveedor_id ?? "") === proveedorId), [opciones.productos, proveedorId]);

  const filtrados = useMemo(() => {
    const n = q.trim().toLowerCase();
    return productosProveedor
      .filter((p) => !n || [p.codigo, p.producto].some((k) => String(k ?? "").toLowerCase().includes(n)))
      .slice(0, 60);
  }, [productosProveedor, q]);

  const lineas = useMemo(() => {
    const elegidas: Row[] = [];
    for (const p of productosProveedor) {
      const cantidad = Number(cantidades[String(p.id)] ?? 0);
      if (Number.isInteger(cantidad) && cantidad > 0) {
        elegidas.push({ codigo: p.codigo, producto: p.producto, cantidad, precio: p.precio ?? null });
      }
    }
    return elegidas;
  }, [cantidades, productosProveedor]);

  const totalUds = lineas.reduce((n, l) => n + Number(l.cantidad ?? 0), 0);

  // Productos del proveedor que están en su mínimo o por debajo: son los que
  // interesa reponer, y de ahí sale la cantidad propuesta (mínimo − almacén).
  const aReponer = useMemo(() => bajoMinimo(productosProveedor), [productosProveedor]);

  const sugerir = () => {
    const propuesta = sugerenciasReposicion(productosProveedor);
    setCantidades((prev) => {
      const salida = { ...prev };
      let nuevos = 0;
      for (const [id, cantidad] of Object.entries(propuesta)) {
        if (Number(salida[id] ?? 0) > 0) continue; // no pisa lo que ya escribió el usuario
        salida[id] = cantidad;
        nuevos += 1;
      }
      setSugeridos(nuevos);
      return salida;
    });
  };

  const guardar = async () => {
    if (!centroId) { setError("Elige el centro"); return; }
    if (!proveedorId) { setError("Elige el proveedor"); return; }
    if (!lineas.length) { setError("Indica la cantidad de al menos un producto"); return; }
    setBusy(true); setError(null);
    try {
      const r = await api.post<{ numero?: string }>("/api/pedidos", {
        centro_id: Number(centroId),
        proveedor_id: Number(proveedorId),
        notas: notas.trim() || null,
        lineas: lineas.map((l) => ({
          codigo: String(l.codigo ?? ""), producto: String(l.producto ?? ""),
          cantidad: Number(l.cantidad ?? 0), precio: l.precio ?? null, origen,
        })),
      });
      onCreado(`Pedido ${r.numero ?? ""} creado con ${lineas.length} líneas`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo crear el pedido");
    } finally {
      setBusy(false);
    }
  };

  return <Modal title="Nuevo pedido" subtitle="Centro y proveedor, con las cantidades de cada producto" onClose={onClose} wide>
    {error && <div className="form-error">{error}</div>}
    <div className="form-grid">
      <div className="field">
        <label htmlFor="pe-centro">Centro <span className="req">*</span></label>
        <select id="pe-centro" className="input" value={centroId} onChange={(e) => setCentroId(e.target.value)}>
          {opciones.centros.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pe-proveedor">Proveedor <span className="req">*</span></label>
        <select id="pe-proveedor" className="input" value={proveedorId} onChange={(e) => {
          setProveedorId(e.target.value);
          setCantidades({});
          setQ("");
          setError(null);
        }}>
          {opciones.proveedores.map((p) => <option key={p.id} value={p.id}>{p.codigo} · {p.nombre}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pe-origen">Origen de las líneas</label>
        <select id="pe-origen" className="input" value={origen} onChange={(e) => setOrigen(e.target.value)}>
          <option value="empresa">🏢 Empresa</option>
          <option value="fabrica">🏭 Fábrica</option>
        </select>
        <small>Se aplica a todas las líneas del pedido; después puede ajustarse al recibirlo.</small>
      </div>
      <div className="field full">
        <label htmlFor="pe-notas">Notas del pedido</label>
        <input id="pe-notas" className="input" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej. Reponer antes del cambio de turno" maxLength={500} />
      </div>
    </div>

    <div className="section-head" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
      <h3>Productos a pedir</h3>
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar producto…" value={q} onChange={(e) => setQ(e.target.value)} />
      <button type="button" className="btn secondary" onClick={sugerir} disabled={!aReponer.length}
        title={aReponer.length ? "Rellena la cantidad que falta hasta el stock mínimo de cada producto" : "Ningún producto de este proveedor está por debajo de su mínimo"}>
        ✨ Sugerir por mínimos ({formatNum(aReponer.length)})
      </button>
    </div>
    {sugeridos > 0 && <p className="muted" style={{ margin: "0 0 8px", fontSize: 12.5 }}>
      Se han propuesto cantidades para {formatNum(sugeridos)} productos: lo que falta para llegar a su mínimo.
    </p>}
    {!productosProveedor.length
      ? <div className="banner warn">Este proveedor no tiene productos: crea los suyos en «Productos disponibles» para poder pedirlos.</div>
      : <div className="table-scroll" style={{ maxHeight: 320, border: "1px solid var(--border)", borderRadius: 10 }}>
        <table className="tabla-frec">
          <thead><tr><th>Código</th><th>Producto</th><th className="right">Precio (€)</th><th className="right">En almacén</th><th className="right">Mínimo</th><th style={{ width: 110 }}>Cantidad</th></tr></thead>
          <tbody>{filtrados.map((p) => {
            const falta = faltanteHastaMinimo(p.unidades_almacen, p.stock_minimo);
            return <tr key={String(p.id)}>
            <td><strong>{String(p.codigo ?? "—")}</strong></td>
            <td style={{ whiteSpace: "normal" }}>{String(p.producto ?? "—")}</td>
            <td className="right">{p.precio == null || p.precio === "" ? "—" : formatNum(p.precio, 2)}</td>
            <td className="right">{formatNum(p.unidades_almacen)}{falta > 0 && <div><span className="badge danger" title={`Faltan ${falta} para el mínimo`}>⚠️ reponer</span></div>}</td>
            <td className="right">{Number(p.stock_minimo ?? 0) > 0 ? formatNum(p.stock_minimo) : "—"}</td>
            <td>
              <input
                className="input"
                type="number"
                min={0}
                step={1}
                aria-label={`Cantidad de ${String(p.producto ?? "")}`}
                value={cantidades[String(p.id)] ?? ""}
                placeholder="0"
                onChange={(e) => setCantidades((prev) => ({ ...prev, [String(p.id)]: e.target.value }))}
              />
            </td>
          </tr>;
          })}</tbody>
        </table>
      </div>}

    <p className="muted" style={{ margin: "12px 0 0", fontSize: 12.5 }}>
      {lineas.length} productos · {formatNum(totalUds)} unidades seleccionadas
    </p>

    <div className="modal-footer">
      <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancelar</button>
      <button type="button" className="btn" onClick={() => void guardar()} disabled={busy || !lineas.length}>
        {busy ? "Creando…" : "Crear pedido"}
      </button>
    </div>
  </Modal>;
}

// ────────────────────────────── Detalle ─────────────────────────────────────
interface Detalle { pedido: Row; lineas: Row[]; puede_gestionar: boolean }

function PedidoDetalleModal({ id, productos, onClose, onAviso, onCambio }: {
  id: number;
  productos: Row[];
  onClose: () => void;
  onAviso: (a: Aviso) => void;
  onCambio: () => void;
}) {
  const [detalle, setDetalle] = useState<Detalle | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [albaran, setAlbaran] = useState("");
  const [recuento, setRecuento] = useState<Record<string, string>>({});
  const [reclamar, setReclamar] = useState<Set<number>>(new Set());
  const [motivo, setMotivo] = useState("");
  const [editadas, setEditadas] = useState<Record<string, string>>({});
  const [nueva, setNueva] = useState({ codigo: "", cantidad: "", precio: "" });

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const r = await api.get<Detalle>(`/api/pedidos/${id}`);
      setDetalle(r);
      setAlbaran(String(r.pedido.albaran ?? ""));
      const cuenta: Record<string, string> = {};
      const marcas = new Set<number>();
      for (const l of r.lineas) {
        const key = String(l.id);
        cuenta[key] = String(l.cantidad_recibida ?? l.cantidad ?? 0);
        if (Number(l.reclamar) === 1) marcas.add(Number(l.id));
      }
      setRecuento(cuenta);
      setReclamar(marcas);
      setEditadas({});
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo abrir el pedido");
    } finally {
      setCargando(false);
    }
  }, [id]);
  useEffect(() => { void cargar(); }, [cargar]);

  const pedido = detalle?.pedido ?? null;
  const lineas = detalle?.lineas ?? [];
  const estado = String(pedido?.estado ?? "borrador") as Estado;
  const gestionable = detalle?.puede_gestionar ?? false;
  // Productos que aún se pueden añadir: solo los del proveedor del pedido.
  const productosPedido = useMemo(() => {
    const proveedorId = String(pedido?.proveedor_id ?? "");
    return productos.filter((p) => String(p.proveedor_id ?? "") === proveedorId
      && !lineas.some((l) => String(l.codigo ?? "").trim().toUpperCase() === String(p.codigo ?? "").trim().toUpperCase()));
  }, [productos, pedido?.proveedor_id, lineas]);

  const ejecutar = async (accion: () => Promise<unknown>, mensaje: string) => {
    setBusy(true);
    try {
      await accion();
      onAviso({ message: mensaje, kind: "ok" });
      await cargar();
      onCambio();
    } catch (e) {
      onAviso({ message: e instanceof Error ? e.message : "No se pudo completar la acción", kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const enviar = () => {
    if (!window.confirm("Se cerrará el pedido y quedará como enviado al proveedor. ¿Continuar?")) return;
    void ejecutar(() => api.post(`/api/pedidos/${id}/enviar`, {}), "Pedido enviado al proveedor");
  };

  const recibir = () => {
    if (!albaran.trim()) { onAviso({ message: "Indica el número de albarán", kind: "error" }); return; }
    const lineasRecuento = lineas.map((l) => ({
      id: Number(l.id),
      cantidad_recibida: Number(recuento[String(l.id)] ?? 0),
      reclamar: reclamar.has(Number(l.id)),
    }));
    if (lineasRecuento.some((l) => !Number.isInteger(l.cantidad_recibida) || l.cantidad_recibida < 0)) {
      onAviso({ message: "Las cantidades contadas deben ser números enteros", kind: "error" });
      return;
    }
    void ejecutar(() => api.post(`/api/pedidos/${id}/recibir`, { albaran: albaran.trim(), lineas: lineasRecuento }),
      "Recepción guardada con el recuento");
  };

  const aplicar = () => {
    const unidades = lineas.reduce((n, l) => n + Number(recuento[String(l.id)] ?? l.cantidad_recibida ?? 0), 0);
    if (!window.confirm(`Se sumarán ${unidades} unidades al stock de material de limpieza. Esta acción no se puede deshacer. ¿Continuar?`)) return;
    void ejecutar(() => api.post(`/api/pedidos/${id}/aplicar`, {}), "Pedido aplicado al stock");
  };

  const guardarReclamacion = () => {
    if (!motivo.trim()) { onAviso({ message: "Escribe el motivo de la reclamación", kind: "error" }); return; }
    void ejecutar(() => api.post(`/api/pedidos/${id}/reclamar`, { motivo: motivo.trim() }), "Reclamación guardada");
  };

  const guardarLineas = async () => {
    const cambios = Object.entries(editadas);
    if (!cambios.length) return;
    setBusy(true);
    try {
      for (const [lineaId, cantidad] of cambios) {
        await api.put(`/api/pedidos/${id}/lineas/${lineaId}`, { cantidad: Number(cantidad) });
      }
      onAviso({ message: "Líneas actualizadas", kind: "ok" });
      await cargar();
      onCambio();
    } catch (e) {
      onAviso({ message: e instanceof Error ? e.message : "No se pudieron guardar las líneas", kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const borrarLinea = (lineaId: number, producto: string) => {
    if (!window.confirm(`¿Quitar «${producto}» del pedido?`)) return;
    void ejecutar(() => api.del(`/api/pedidos/${id}/lineas/${lineaId}`), "Línea eliminada");
  };

  const anadirLinea = () => {
    const producto = productosPedido.find((p) => String(p.codigo ?? "") === nueva.codigo);
    if (!producto) { onAviso({ message: "Elige un producto del catálogo de este proveedor", kind: "error" }); return; }
    const cantidad = Number(nueva.cantidad);
    if (!Number.isInteger(cantidad) || cantidad < 1) { onAviso({ message: "La cantidad debe ser mayor que 0", kind: "error" }); return; }
    void ejecutar(() => api.post(`/api/pedidos/${id}/lineas`, {
      codigo: producto.codigo, producto: producto.producto, cantidad,
      precio: nueva.precio.trim() === "" ? null : Number(nueva.precio.replace(",", ".")),
      origen: "empresa",
    }), "Línea añadida");
    setNueva({ codigo: "", cantidad: "", precio: "" });
  };

  const borrarPedido = () => {
    if (!window.confirm("¿Eliminar este pedido en borrador? No se puede deshacer.")) return;
    void ejecutar(async () => { await api.del(`/api/pedidos/${id}`); onClose(); }, "Pedido eliminado");
  };

  const totalPedido = lineas.reduce((n, l) => n + Number(l.cantidad ?? 0), 0);
  const totalRecibido = lineas.reduce((n, l) => n + Number(l.cantidad_recibida ?? 0), 0);
  const diferencias = lineas.filter((l) => l.cantidad_recibida != null && Number(l.cantidad_recibida) !== Number(l.cantidad));

  return <Modal
    title={pedido ? `Pedido ${String(pedido.numero)}` : "Pedido"}
    subtitle={pedido ? `${String(pedido.centro_nombre ?? "")} · ${String(pedido.proveedor_nombre ?? "sin proveedor")} · ${formatFecha(pedido.fecha)}` : "Cargando…"}
    onClose={onClose}
    wide
  >
    {cargando ? <div className="loading">Abriendo el pedido…</div>
      : error ? <div className="form-error">{error}</div>
      : !pedido ? null
      : <>
        <div className="pedido-head">
          <div className="pedido-estados">
            {ESTADOS.map((e, i) => {
              const actual = ESTADOS.findIndex((x) => x.id === estado);
              return <span key={e.id} className={"pedido-paso" + (i <= actual ? " on" : "") + (i === actual ? " actual" : "")}>
                {e.icon} {e.label}
              </span>;
            })}
          </div>
          <div className="pedido-resumen">
            <span><strong>{formatNum(lineas.length)}</strong> líneas</span>
            <span><strong>{formatNum(totalPedido)}</strong> pedidas</span>
            {estado !== "borrador" && <span><strong>{formatNum(totalRecibido)}</strong> recibidas</span>}
            {pedido.albaran ? <span>Albarán <strong>{String(pedido.albaran)}</strong></span> : null}
            {pedido.notas ? <span className="muted">{String(pedido.notas)}</span> : null}
          </div>
        </div>

        {pedido.reclamacion ? <div className="banner warn">⚠️ Reclamación: {String(pedido.reclamacion)}</div> : null}

        <div className="table-scroll" style={{ border: "1px solid var(--border)", borderRadius: 10 }}>
          <table className="tabla-frec">
            <thead><tr>
              <th>Código</th><th>Producto</th><th className="right">Pedido</th>
              {estado !== "borrador" && <><th className="right">Recibido</th><th className="right">Diferencia</th><th>Reclamar</th></>}
              <th className="right">Precio (€)</th><th className="right">Importe (€)</th>
              {estado === "borrador" && gestionable && <th className="right">Quitar</th>}
            </tr></thead>
            <tbody>{lineas.map((l) => {
              const lineaId = Number(l.id);
              const pedida = Number(l.cantidad ?? 0);
              const recibida = l.cantidad_recibida == null ? null : Number(l.cantidad_recibida);
              const diferencia = recibida === null ? null : recibida - pedida;
              return <tr key={lineaId}>
                <td><strong>{String(l.codigo ?? "—")}</strong></td>
                <td style={{ whiteSpace: "normal" }}>{String(l.producto ?? "—")}</td>
                <td className="right">
                  {estado === "borrador" && gestionable
                    ? <input
                      className="input pedido-qty"
                      type="number"
                      min={1}
                      value={editadas[String(lineaId)] ?? String(pedida)}
                      onChange={(e) => setEditadas((prev) => ({ ...prev, [String(lineaId)]: e.target.value }))}
                      aria-label={`Cantidad pedida de ${String(l.producto ?? "")}`}
                    />
                    : formatNum(pedida)}
                </td>
                {estado !== "borrador" && <>
                  <td className="right">
                    {estado === "enviado" || estado === "recibido"
                      ? <input
                        className="input pedido-qty"
                        type="number"
                        min={0}
                        value={recuento[String(lineaId)] ?? ""}
                        onChange={(e) => setRecuento((prev) => ({ ...prev, [String(lineaId)]: e.target.value }))}
                        aria-label={`Cantidad contada de ${String(l.producto ?? "")}`}
                      />
                      : formatNum(recibida ?? 0)}
                  </td>
                  <td className="right">{diferencia === null ? "—" : diferencia === 0 ? "✔" : <span className={diferencia < 0 ? "badge danger" : "badge warn"}>{diferencia > 0 ? "+" : ""}{diferencia}</span>}</td>
                  <td>{diferencia === null ? "—" : <label className="pedido-check">
                    <input
                      type="checkbox"
                      checked={reclamar.has(lineaId)}
                      disabled={estado === "aplicado" || !gestionable}
                      onChange={(e) => setReclamar((prev) => {
                        const siguiente = new Set(prev);
                        if (e.target.checked) siguiente.add(lineaId); else siguiente.delete(lineaId);
                        return siguiente;
                      })}
                    />
                  </label>}</td>
                </>}
                <td className="right">{l.precio == null || l.precio === "" ? "—" : formatNum(l.precio, 2)}</td>
                <td className="right">{formatNum(importe(l.cantidad, l.precio), 2)}</td>
                {estado === "borrador" && gestionable && <td className="right">
                  <button className="btn danger small" onClick={() => borrarLinea(lineaId, String(l.producto ?? ""))} disabled={busy}>🗑️</button>
                </td>}
              </tr>;
            })}</tbody>
            <tfoot><tr>
              <td colSpan={2}><strong>Total</strong></td>
              <td className="right"><strong>{formatNum(totalPedido)}</strong></td>
              {estado !== "borrador" && <><td className="right"><strong>{formatNum(totalRecibido)}</strong></td><td colSpan={2} /></>}
              <td />
              <td className="right"><strong>{formatNum(lineas.reduce((n, l) => n + importe(l.cantidad, l.precio), 0), 2)}</strong></td>
              {estado === "borrador" && gestionable && <td />}
            </tr></tfoot>
          </table>
        </div>

        {estado === "borrador" && gestionable && <>
          {Object.keys(editadas).length > 0 && <p className="muted" style={{ fontSize: 12.5 }}>
            Tienes {Object.keys(editadas).length} línea(s) con la cantidad cambiada.{" "}
            <button type="button" className="btn small" onClick={() => void guardarLineas()} disabled={busy}>Guardar cantidades</button>
          </p>}
          <div className="pedido-manual">
            <div className="field" style={{ minWidth: 240 }}>
              <label htmlFor="pe-ncod">Producto del proveedor</label>
              <select id="pe-ncod" className="input" value={nueva.codigo} disabled={!productosPedido.length} onChange={(e) => {
                const p = productosPedido.find((x) => String(x.codigo ?? "") === e.target.value);
                setNueva({ codigo: e.target.value, cantidad: nueva.cantidad, precio: p?.precio == null ? "" : String(p.precio) });
              }}>
                <option value="">— Elige un producto —</option>
                {productosPedido.map((p) => <option key={String(p.id)} value={String(p.codigo ?? "")}>{String(p.codigo ?? "")} · {String(p.producto ?? "")}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="pe-ncant">Cantidad</label><input id="pe-ncant" className="input" type="number" min={1} value={nueva.cantidad} onChange={(e) => setNueva({ ...nueva, cantidad: e.target.value })} /></div>
            <div className="field"><label htmlFor="pe-nprec">Precio (€)</label><input id="pe-nprec" className="input" type="number" step="any" min={0} value={nueva.precio} onChange={(e) => setNueva({ ...nueva, precio: e.target.value })} /></div>
            <button type="button" className="btn secondary" onClick={anadirLinea} disabled={busy || !nueva.codigo}>＋ Añadir línea</button>
          </div>
        </>}

        {gestionable && (estado === "enviado" || estado === "recibido") && <>
          <div className="pedido-recepcion">
            <div className="field">
              <label htmlFor="pe-albaran">Número de albarán <span className="req">*</span></label>
              <input id="pe-albaran" className="input" value={albaran} onChange={(e) => setAlbaran(e.target.value)} placeholder="Ej. ALB-2026-0451" maxLength={60} />
            </div>
            <button type="button" className="btn secondary" onClick={recibir} disabled={busy}>
              {busy ? "Guardando…" : estado === "enviado" ? "Guardar recepción y recuento" : "Corregir recepción"}
            </button>
            {estado === "recibido" && <button type="button" className="btn" onClick={aplicar} disabled={busy}>
              {busy ? "Aplicando…" : "➕ Sumar al stock"}
            </button>}
          </div>
          <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
            Escribe lo que realmente ha llegado en la columna «Recibido». Marca «reclamar» en las líneas con diferencia y, si hace falta, deja el motivo.
          </p>
          {diferencias.length > 0 && <div className="banner warn">
            {diferencias.length} línea(s) con diferencia entre lo pedido y lo contado.
          </div>}
        </>}
        {gestionable && estado !== "borrador" && <div className="pedido-manual">
          <div className="field" style={{ flex: 1 }}>
            <label htmlFor="pe-motivo">Reclamación al proveedor</label>
            <input id="pe-motivo" className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Faltan 2 garrafas del código M-004" maxLength={500} />
          </div>
          <button type="button" className="btn secondary" onClick={guardarReclamacion} disabled={busy}>Guardar reclamación</button>
        </div>}

        <div className="modal-footer">
          {estado === "borrador" && gestionable && <button type="button" className="btn danger" onClick={borrarPedido} disabled={busy}>🗑️ Eliminar pedido</button>}
          <div className="pedido-acciones">
            <button type="button" className="btn secondary" onClick={() => descargarPedido(pedido, lineas)}>⬇️ Descargar Excel</button>
            {estado === "borrador" && gestionable && <button type="button" className="btn" onClick={enviar} disabled={busy || !lineas.length}>📤 Marcar enviado</button>}
            {estado === "aplicado" && <span className="badge ok">✅ Sumado al stock</span>}
          </div>
        </div>
      </>}
  </Modal>;
}
