import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { formatFecha, formatNum } from "./ui";

type Row = Record<string, unknown>;
type Tab = "datos" | "epis" | "ropa" | "formaciones" | "movimientos";

const TIPOS_FORMACION: Record<string, { icon: string; label: string }> = {
  formacion: { icon: "🎓", label: "Formación" },
  revision: { icon: "🩺", label: "Revisión" },
  carnet: { icon: "🪪", label: "Carnet" },
};

interface Ficha {
  usuario: Row;
  centros: Row[];
  tallas: Row[];
  epis: Row[];
  ropa: Row[];
  formaciones: Row[];
  movimientos: Row[];
  resumen: { centros: number; epis: number; ropa: number; formaciones: number; vencidas: number; proximas: number };
  propio: boolean;
  puede_editar: boolean;
}

interface Lista {
  items: Row[];
  centros?: Array<{ id: number; nombre: string }>;
  solo_propia: boolean;
  puede_gestionar: boolean;
}

const ROL_LABEL: Record<string, string> = { admin: "Administrador", admin_centros: "Adm. de centros", usuario: "Usuario" };
const rolLabel = (r: unknown): string => ROL_LABEL[String(r ?? "")] ?? "Usuario";
const nombreCompleto = (u: Row | undefined): string => String(u?.nombre ?? "");

function isoDeHash(): number | null {
  if (typeof window === "undefined") return null;
  const q = window.location.hash.split("?")[1];
  if (!q) return null;
  const id = Number(new URLSearchParams(q).get("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Sección «Operarios»: ficha unificada de cada persona con sus datos, lo que
 *  se le ha entregado, sus formaciones y sus últimos movimientos. */
export function OperariosPage({ user }: { user: { id: number; nombre: string; rol: string } }) {
  const propio = user.rol === "usuario";
  const [lista, setLista] = useState<Lista | null>(null);
  const [q, setQ] = useState("");
  const [centroId, setCentroId] = useState("");
  const [selId, setSelId] = useState<number | null>(propio ? user.id : isoDeHash());
  const [ficha, setFicha] = useState<Ficha | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const cargarLista = useCallback(async () => {
    if (propio) return;
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (centroId) params.set("centro_id", centroId);
      setLista(await api.get<Lista>(`/api/operarios${params.size ? `?${params.toString()}` : ""}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar los operarios");
    }
  }, [centroId, propio, q]);

  useEffect(() => {
    const t = setTimeout(() => { void cargarLista(); }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [cargarLista, q]);

  const cargarFicha = useCallback(async () => {
    if (!selId) { setFicha(null); setCargando(false); return; }
    setCargando(true);
    setError(null);
    try {
      setFicha(await api.get<Ficha>(`/api/operarios/${selId}`));
      if (typeof window !== "undefined" && !propio) {
        const nuevo = `#/operarios?id=${selId}`;
        if (window.location.hash !== nuevo) window.history.replaceState(null, "", nuevo);
      }
    } catch (e) {
      setFicha(null);
      setError(e instanceof Error ? e.message : "No se pudo cargar la ficha");
    } finally {
      setCargando(false);
    }
  }, [propio, selId]);
  useEffect(() => { void cargarFicha(); }, [cargarFicha]);

  const seleccionar = (id: number) => setSelId(id);

  if (error && !ficha) return <div className="card empty">⚠️ {error}</div>;

  return <>
    {!propio && <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      <input className="input" style={{ maxWidth: 280 }} placeholder="🔍 Buscar por nombre, usuario, email o puesto…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 240 }} value={centroId} onChange={(e) => setCentroId(e.target.value)} aria-label="Filtrar por centro">
        <option value="">Todos los centros</option>
        {(lista?.centros ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
      </select>
      <span className="muted" style={{ fontSize: 12.5 }}>{formatNum(lista?.items.length ?? 0)} operarios</span>
    </div>}

    <div className={"op-layout" + (propio ? " solo" : "")}>
      {!propio && <aside className="card op-list">
        <div className="op-list-head"><strong>Operarios</strong><span>{formatNum(lista?.items.length ?? 0)}</span></div>
        {!lista ? <div className="loading">Cargando…</div>
          : !lista.items.length ? <p className="tablas-vacio">Ningún operario coincide.</p>
          : <ul>{lista.items.map((o) => {
            const activo = Number(o.id) === selId;
            return <li key={String(o.id)}>
              <button type="button" className={"op-item" + (activo ? " active" : "")} onClick={() => seleccionar(Number(o.id))}>
                <span className="op-avatar">{nombreCompleto(o).charAt(0).toUpperCase() || "?"}</span>
                <span className="op-item-info">
                  <strong>{nombreCompleto(o) || String(o.username ?? "—")}</strong>
                  <small>{String(o.puesto ?? o.username ?? "")}</small>
                  <small className="op-item-centros">{String(o.centros_nombre ?? "Sin centro")}</small>
                </span>
                {Number(o.formaciones_vencidas ?? 0) > 0 && <span className="badge danger" title="Formaciones vencidas">{formatNum(o.formaciones_vencidas)}</span>}
              </button>
            </li>;
          })}</ul>}
      </aside>}

      <section className="op-main">
        {!selId
          ? <div className="card empty"><span className="icon">🪪</span><strong>Elige un operario</strong><p>Selecciona a alguien del listado para ver su ficha completa.</p></div>
          : cargando && !ficha ? <div className="card loading">Cargando la ficha…</div>
          : ficha ? <FichaOperario ficha={ficha} propio={propio} onCambio={() => { void cargarFicha(); void cargarLista(); }} />
          : <div className="card empty">⚠️ No se pudo cargar la ficha.</div>}
      </section>
    </div>
  </>;
}

function FichaOperario({ ficha, propio, onCambio }: { ficha: Ficha; propio: boolean; onCambio: () => void }) {
  const [tab, setTab] = useState<Tab>("datos");
  const u = ficha.usuario;
  const inicial = nombreCompleto(u).charAt(0).toUpperCase() || "?";

  const tabs = useMemo(() => ([
    { id: "datos" as Tab, label: "Datos personales", icon: "👤", n: null as number | null },
    { id: "epis" as Tab, label: "EPIs entregados", icon: "🦺", n: ficha.epis.length },
    { id: "ropa" as Tab, label: "Ropa entregada", icon: "🥼", n: ficha.ropa.length },
    { id: "formaciones" as Tab, label: "Formaciones", icon: "🎓", n: ficha.formaciones.length },
    { id: "movimientos" as Tab, label: "Movimientos", icon: "🔄", n: ficha.movimientos.length },
  ]), [ficha]);

  return <>
    <div className="card op-header">
      <div className="op-header-main">
        <span className="op-avatar big">{inicial}</span>
        <div>
          <h2>{nombreCompleto(u) || String(u.username ?? "")}</h2>
          <p className="op-sub">
            <span>@{String(u.username ?? "—")}</span>
            {u.puesto ? <span>· {String(u.puesto)}</span> : null}
            {u.email ? <span>· {String(u.email)}</span> : null}
            {u.telefono ? <span>· {String(u.telefono)}</span> : null}
          </p>
          <div className="op-badges">
            <span className={"badge " + (String(u.rol) === "admin" ? "info" : String(u.rol) === "admin_centros" ? "warn" : "muted")}>{rolLabel(u.rol)}</span>
            <span className={"badge " + (Number(u.activo) === 1 ? "ok" : "danger")}>{Number(u.activo) === 1 ? "● Activo" : "● Inactivo"}</span>
            {propio && <span className="badge muted">Tu ficha</span>}
          </div>
        </div>
      </div>
      <div className="op-header-stats">
        <div><span>Centros</span><strong>{formatNum(ficha.resumen.centros)}</strong></div>
        <div><span>EPIs</span><strong>{formatNum(ficha.resumen.epis)}</strong></div>
        <div><span>Ropa</span><strong>{formatNum(ficha.resumen.ropa)}</strong></div>
        <div><span>Formaciones</span><strong>{formatNum(ficha.resumen.formaciones)}</strong></div>
        <div className={ficha.resumen.vencidas ? "alert" : ""}><span>Vencidas</span><strong>{formatNum(ficha.resumen.vencidas)}</strong></div>
        <div className={ficha.resumen.proximas ? "alert" : ""}><span>Caducan 30 d</span><strong>{formatNum(ficha.resumen.proximas)}</strong></div>
      </div>
      <div className="op-center-chips">
        {ficha.centros.length
          ? ficha.centros.map((c) => <span key={String(c.id)} className="chip on" title="Centro asignado">🏢 {String(c.nombre)}</span>)
          : <span className="badge muted">Sin centro asignado</span>}
        {ficha.puede_editar && <a className="btn secondary small" href="#/gestion-centros">✏️ Editar datos</a>}
      </div>
    </div>

    <div className="card op-tabs-card">
      <div className="op-tabs" role="tablist" aria-label="Ficha del operario">
        {tabs.map((t) => <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          className={tab === t.id ? "active" : ""}
          onClick={() => setTab(t.id)}
        >
          {t.icon} {t.label}{t.n !== null ? ` (${formatNum(t.n)})` : ""}
        </button>)}
      </div>

      <div className="op-tab-body">
        {tab === "datos" && <>
          <div className="stat-grid">
            <div className="stat"><div className="k">Usuario</div><div className="v" style={{ fontSize: 16 }}>{String(u.username ?? "—")}</div></div>
            <div className="stat"><div className="k">Puesto</div><div className="v" style={{ fontSize: 16 }}>{String(u.puesto ?? "—")}</div></div>
            <div className="stat"><div className="k">Email</div><div className="v" style={{ fontSize: 16 }}>{String(u.email ?? "—")}</div></div>
            <div className="stat"><div className="k">Teléfono</div><div className="v" style={{ fontSize: 16 }}>{String(u.telefono ?? "—")}</div></div>
            <div className="stat"><div className="k">Alta en la aplicación</div><div className="v" style={{ fontSize: 16 }}>{formatFecha(u.created_at)}</div></div>
            <div className="stat"><div className="k">Centros</div><div className="v" style={{ fontSize: 16 }}>{ficha.centros.length ? ficha.centros.map((c) => String(c.nombre)).join(" · ") : "—"}</div></div>
          </div>
          <div className="section-head" style={{ marginTop: 18 }}><h3>Tallas de equipación</h3></div>
          {!ficha.tallas.length
            ? <p className="muted" style={{ margin: 0 }}>Sin tallas registradas. Se apuntan al entregar ropa o desde «Equipación → Tallas operarios».</p>
            : <div className="table-scroll"><table>
              <thead><tr><th>Prenda</th><th>Talla</th><th>Fecha</th><th>Notas</th></tr></thead>
              <tbody>{ficha.tallas.map((t) => <tr key={String(t.id)}>
                <td>{String(t.prenda ?? "—")}</td>
                <td><span className="badge info">{String(t.talla ?? "—")}</span></td>
                <td>{formatFecha(t.fecha)}</td>
                <td style={{ whiteSpace: "normal" }}>{String(t.notas ?? "—")}</td>
              </tr>)}</tbody>
            </table></div>}
        </>}

        {tab === "epis" && <TablaEntregas
          filas={ficha.epis}
          cabecera="EPIs entregados"
          vacio="Todavía no se le ha entregado ningún EPI."
          columnas={["Fecha", "EPI", "Cantidad", "Talla", "Centro"]}
          celdas={(e) => [formatFecha(e.fecha), String(e.prenda ?? "—"), formatNum(e.cantidad), String(e.talla ?? "—"), String(e.centro_nombre ?? "—")]}
        />}

        {tab === "ropa" && <TablaEntregas
          filas={ficha.ropa}
          cabecera="Ropa entregada"
          vacio="Todavía no se le ha entregado ropa de trabajo."
          columnas={["Fecha", "Prenda", "Cantidad", "Talla", "Color", "Centro"]}
          celdas={(e) => [
            formatFecha(e.fecha), String(e.prenda ?? "—"), formatNum(e.cantidad),
            String(e.talla ?? "—"), String(e.color ?? "—"), String(e.centro_nombre ?? "—"),
          ]}
        />}

        {tab === "formaciones" && <>
          <div className="section-head">
            <h3>Formaciones, carnets y revisiones</h3>
            <a className="btn secondary small" href="#/formaciones">Ver matriz</a>
          </div>
          {!ficha.formaciones.length
            ? <p className="muted" style={{ margin: 0 }}>Sin formaciones registradas.</p>
            : <div className="table-scroll"><table>
              <thead><tr><th>Tipo</th><th>Formación</th><th>Realizada</th><th>Caduca</th><th>Estado</th><th>Centro</th></tr></thead>
              <tbody>{ficha.formaciones.map((f) => {
                const tipo = TIPOS_FORMACION[String(f.tipo ?? "")] ?? TIPOS_FORMACION.formacion;
                const dias = f.caducidad ? Number(f.dias) : null;
                return <tr key={String(f.id)}>
                  <td><span className="badge info">{tipo.icon} {tipo.label}</span></td>
                  <td><strong>{String(f.nombre ?? "—")}</strong></td>
                  <td>{formatFecha(f.fecha)}</td>
                  <td>{f.caducidad ? formatFecha(f.caducidad) : "—"}</td>
                  <td>{dias === null
                    ? <span className="badge muted">Sin caducidad</span>
                    : dias < 0
                      ? <span className="badge danger">Vencida hace {formatNum(Math.abs(dias))} d</span>
                      : dias <= 30
                        ? <span className="badge warn">Caduca en {formatNum(dias)} d</span>
                        : <span className="badge ok">En vigor · {formatNum(dias)} d</span>}</td>
                  <td>{String(f.centro_nombre ?? "—")}</td>
                </tr>;
              })}</tbody>
            </table></div>}
        </>}

        {tab === "movimientos" && <>
          <div className="section-head">
            <h3>Últimos 10 movimientos</h3>
            <a className="btn secondary small" href="#/gestion-informes">Ver toda la auditoría</a>
          </div>
          {!ficha.movimientos.length
            ? <p className="muted" style={{ margin: 0 }}>Sin movimientos registrados.</p>
            : <div className="table-scroll"><table>
              <thead><tr><th>Fecha</th><th>Acción</th><th>Detalle</th><th className="right">Cantidad</th></tr></thead>
              <tbody>{ficha.movimientos.map((m) => <tr key={String(m.id)}>
                <td>{String(m.created_at ?? "").replace("T", " ").slice(0, 16)}</td>
                <td><span className={"badge " + (String(m.accion) === "consumo" ? "info" : String(m.accion) === "entrada" ? "ok" : String(m.accion) === "borrado" ? "danger" : "warn")}>
                  {String(m.accion ?? "—").replaceAll("_", " ")}
                </span></td>
                <td style={{ whiteSpace: "normal" }}>{String(m.descripcion ?? m.motivo ?? "—")}</td>
                <td className="right">{m.cantidad == null ? "—" : formatNum(m.cantidad)}</td>
              </tr>)}</tbody>
            </table></div>}
        </>}
      </div>
    </div>
    <p className="no-print muted" style={{ margin: 0, fontSize: 12 }}>
      {propio ? "Solo tienes acceso a tu propia ficha." : "Los administradores ven las fichas de todos los operarios de sus centros."}
      {" "}Los datos se actualizan al instante con cada entrega, formación o movimiento.
      <button type="button" className="login-link" style={{ display: "inline", width: "auto", marginLeft: 6 }} onClick={onCambio}>↻ Actualizar</button>
    </p>
  </>;
}

function TablaEntregas({ filas, cabecera, vacio, columnas, celdas }: {
  filas: Row[];
  cabecera: string;
  vacio: string;
  columnas: string[];
  celdas: (fila: Row) => Array<string | number>;
}) {
  return <>
    <div className="section-head"><h3>{cabecera}</h3><span className="muted" style={{ fontSize: 12.5 }}>{formatNum(filas.length)} entregas</span></div>
    {!filas.length
      ? <p className="muted" style={{ margin: 0 }}>{vacio}</p>
      : <div className="table-scroll"><table>
        <thead><tr>{columnas.map((c, i) => <th key={c} className={i >= 2 && i <= 4 ? "right" : undefined}>{c}</th>)}</tr></thead>
        <tbody>{filas.map((f) => <tr key={String(f.id)}>
          {celdas(f).map((v, i) => <td key={i} className={i >= 2 && i <= 4 ? "right" : undefined}>{v}</td>)}
        </tr>)}</tbody>
      </table></div>}
  </>;
}
