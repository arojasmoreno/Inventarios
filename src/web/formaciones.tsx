import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { FORMACIONES, ResourcePage } from "./resources";
import { Modal, Toast, downloadCsv, formatFecha, formatNum } from "./ui";
import { sumarIntervalo } from "../worker/limpieza-plan";

type Row = Record<string, unknown>;
type Aviso = { message: string; kind: "ok" | "error" };

const TIPOS: Record<string, { icon: string; label: string }> = {
  formacion: { icon: "🎓", label: "Formación" },
  revision: { icon: "🩺", label: "Revisión" },
  carnet: { icon: "🪪", label: "Carnet" },
};
const tipoDe = (t: unknown) => TIPOS[String(t ?? "")] ?? TIPOS.formacion;
const hoyISO = (): string => new Date().toISOString().slice(0, 10);

interface Matriz {
  centro: { id: number; nombre: string } | null;
  centros: Array<{ id: number; nombre: string }>;
  usuarios: Row[];
  catalogo: Row[];
  asignaciones: Row[];
  resumen: { vencidas: number; proximas: number; sin_caducidad: number; asignadas: number };
  puede_gestionar: boolean;
}

const diasHasta = (fecha: unknown): number | null => {
  if (typeof fecha !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(fecha)) return null;
  const destino = Date.UTC(Number(fecha.slice(0, 4)), Number(fecha.slice(5, 7)) - 1, Number(fecha.slice(8, 10)));
  const hoy = new Date();
  const ahora = Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), hoy.getUTCDate());
  return Math.round((destino - ahora) / 86400000);
};

/** Sección «Formaciones»: matriz de operarios por centro con la caducidad de
 *  cada formación, revisión y carnet, más el catálogo que fija la validez. */
export function FormacionesPage({ user }: { user: { rol: string } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const [tab, setTab] = useState<"matriz" | "catalogo">(hash === "#/formaciones-catalogo" ? "catalogo" : "matriz");

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      <button className={"btn" + (tab === "matriz" ? "" : " secondary")} onClick={() => setTab("matriz")}>🗂️ Matriz por centro</button>
      <button className={"btn" + (tab === "catalogo" ? "" : " secondary")} onClick={() => setTab("catalogo")}>🎓 Catálogo y validez</button>
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        El catálogo fija los meses de validez · los avisos llegan 30 días antes
      </span>
    </div>
    {tab === "matriz" ? <MatrizFormaciones user={user} /> : <ResourcePage key="formaciones" config={FORMACIONES} user={user} />}
  </>;
}

function MatrizFormaciones({ user }: { user: { rol: string } }) {
  const [centroId, setCentroId] = useState("");
  const [datos, setDatos] = useState<Matriz | null>(null);
  const [alertas, setAlertas] = useState<Row[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [version, setVersion] = useState(0);
  const [celda, setCelda] = useState<{ usuario: Row; formacionId: number; asignacion: Row | null } | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const params = centroId ? `?centro_id=${centroId}` : "";
      const [m, a] = await Promise.all([
        api.get<Matriz>(`/api/formaciones/matriz${params}`),
        api.get<{ items: Row[] }>("/api/formaciones/alertas?dias=30"),
      ]);
      setDatos(m);
      setAlertas(a.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudieron cargar las formaciones");
    } finally {
      setCargando(false);
    }
  }, [centroId, version]);
  useEffect(() => { void cargar(); }, [cargar]);

  const porClave = useMemo(() => {
    const mapa = new Map<string, Row>();
    for (const fila of datos?.asignaciones ?? []) mapa.set(`${String(fila.usuario_id)}|${String(fila.formacion_id)}`, fila);
    return mapa;
  }, [datos]);

  const catalogo = datos?.catalogo ?? [];
  const usuarios = datos?.usuarios ?? [];

  const exportar = () => {
    if (!datos) return;
    const stamp = hoyISO();
    downloadCsv(`formaciones-${datos.centro ? datos.centro.nombre.replace(/[^\w\-]+/g, "_") : "todos"}-${stamp}.csv`,
      ["Operario", ...catalogo.map((f) => String(f.nombre ?? ""))],
      usuarios.map((u) => [
        String(u.nombre ?? ""),
        ...catalogo.map((f) => {
          const fila = porClave.get(`${String(u.id)}|${String(f.id)}`);
          if (!fila) return "";
          return fila.caducidad ? String(fila.caducidad) : "Sin caducidad";
        }),
      ]));
  };

  const abrirCelda = (usuario: Row, formacionId: number) => {
    const asignacion = porClave.get(`${String(usuario.id)}|${formacionId}`) ?? null;
    setCelda({ usuario, formacionId, asignacion });
  };

  if (error) return <div className="card empty">⚠️ {error}</div>;

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      <select className="input" style={{ maxWidth: 260 }} value={centroId} onChange={(e) => setCentroId(e.target.value)} aria-label="Centro de la matriz">
        <option value="">{user.rol === "admin" ? "Todos los operarios con centro" : "Mis centros"}</option>
        {(datos?.centros ?? []).map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
      </select>
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Pulsa una casilla para registrar o corregir la fecha</span>
      <div className="spacer" />
      <button className="btn secondary" onClick={exportar} disabled={!datos || !usuarios.length}>⬇️ Excel (CSV)</button>
    </div>

    {datos && <div className="kpis no-print">
      <div className={"kpi" + (datos.resumen.vencidas ? " alert" : "")}><div className="label">Vencidas</div><div className="value">{formatNum(datos.resumen.vencidas)}</div><div className="kpi-sub">hay que renovarlas</div></div>
      <div className={"kpi" + (datos.resumen.proximas ? " alert" : "")}><div className="label">Caducan en 30 días</div><div className="value">{formatNum(datos.resumen.proximas)}</div><div className="kpi-sub">aviso al administrador</div></div>
      <div className="kpi"><div className="label">Registradas</div><div className="value">{formatNum(datos.resumen.asignadas)}</div><div className="kpi-sub">{formatNum(usuarios.length)} operarios · {formatNum(catalogo.length)} tipos</div></div>
      <div className="kpi"><div className="label">Sin caducidad</div><div className="value">{formatNum(datos.resumen.sin_caducidad)}</div><div className="kpi-sub">no vencen nunca</div></div>
    </div>}

    <div className="card">
      <div className="section-head" style={{ padding: "14px 16px 0" }}>
        <h3>{datos?.centro ? `Formaciones de ${datos.centro.nombre}` : "Formaciones de todos los operarios"}</h3>
        {cargando && <span className="muted" style={{ fontSize: 12 }}>Actualizando…</span>}
      </div>
      {cargando && !datos ? <div className="loading">Cargando formaciones…</div>
        : !usuarios.length ? <div className="empty">
          <span className="icon">🎓</span>
          <strong>No hay operarios en este centro</strong>
          <p>Asigna usuarios al centro en «Gestión de centros → Usuarios» para poder registrar sus formaciones.</p>
        </div>
        : !catalogo.length ? <div className="empty">
          <span className="icon">📚</span>
          <strong>El catálogo está vacío</strong>
          <p>Abre la pestaña «🎓 Catálogo y validez» y crea las formaciones, revisiones y carnets con sus meses de validez.</p>
        </div>
        : <div className="table-scroll form-matrix-wrap">
          <table className="form-matrix">
            <thead>
              <tr>
                <th className="form-sticky">Operario</th>
                {catalogo.map((f) => {
                  const tipo = tipoDe(f.tipo);
                  const meses = Number(f.meses_validez ?? 0);
                  return <th key={String(f.id)} title={`${tipo.label} · ${meses > 0 ? `${meses} meses de validez` : "sin caducidad"}`}>
                    <span className="form-th-tipo">{tipo.icon}</span>
                    <span className="form-th-nombre">{String(f.nombre ?? "—")}</span>
                    <span className="form-th-meses">{meses > 0 ? `${meses} m` : "—"}</span>
                  </th>;
                })}
              </tr>
            </thead>
            <tbody>
              {usuarios.map((u) => <tr key={String(u.id)}>
                <td className="form-sticky">
                  <strong>{String(u.nombre ?? "—")}</strong>
                  <small>{String(u.username ?? "")}</small>
                </td>
                {catalogo.map((f) => {
                  const fila = porClave.get(`${String(u.id)}|${String(f.id)}`);
                  const dias = fila ? diasHasta(fila.caducidad) : null;
                  const estado = !fila ? "vacio"
                    : !fila.caducidad ? "sin"
                      : dias !== null && dias < 0 ? "vencida"
                        : dias !== null && dias <= 30 ? "proxima"
                          : "ok";
                  const texto = !fila ? "＋"
                    : !fila.caducidad ? "Sin caducidad"
                      : formatFecha(fila.caducidad);
                  const titulo = !fila
                    ? `Registrar ${String(f.nombre ?? "")} de ${String(u.nombre ?? "")}`
                    : `${String(f.nombre ?? "")} de ${String(u.nombre ?? "")}: realizada ${formatFecha(fila.fecha)}`
                      + (fila.caducidad ? ` · caduca ${formatFecha(fila.caducidad)}${dias !== null ? ` (${dias} días)` : ""}` : " · sin caducidad");
                  return <td key={String(f.id)} className="form-cell">
                    <button
                      type="button"
                      className={`form-chip ${estado}`}
                      title={titulo}
                      onClick={() => abrirCelda(u, Number(f.id))}
                    >{texto}</button>
                  </td>;
                })}
              </tr>)}
            </tbody>
          </table>
        </div>}
      <div className="cal-foot">
        <div className="form-legend">
          <span><i className="form-key ok" />En vigor</span>
          <span><i className="form-key proxima" />Caduca en 30 días</span>
          <span><i className="form-key vencida" />Vencida</span>
          <span><i className="form-key sin" />Sin caducidad</span>
        </div>
        <span className="cal-foot-note">Se guarda la última titulación de cada operario; las anteriores quedan en la auditoría.</span>
      </div>
    </div>

    <div className="card card-pad">
      <div className="section-head">
        <h3>🔔 Próximas a caducar (30 días) y vencidas</h3>
        <span className="muted" style={{ fontSize: 12.5 }}>{formatNum(alertas.length)} avisos</span>
      </div>
      {!alertas.length
        ? <p className="muted" style={{ margin: 0 }}>Ninguna formación, revisión o carnet caduca en el próximo mes.</p>
        : <div className="table-scroll"><table>
          <thead><tr><th>Operario</th><th>Tipo</th><th>Formación</th><th>Centro</th><th>Caduca</th></tr></thead>
          <tbody>{alertas.map((a) => {
            const tipo = tipoDe(a.tipo);
            const dias = Number(a.dias);
            return <tr key={String(a.id)}>
              <td><strong>{String(a.usuario ?? "—")}</strong></td>
              <td><span className="badge info">{tipo.icon} {tipo.label}</span></td>
              <td>{String(a.formacion ?? "—")}</td>
              <td>{String(a.centro_nombre ?? "—")}</td>
              <td>{dias < 0
                ? <span className="badge danger">Vencida · {formatFecha(a.caducidad)}</span>
                : <span className="badge warn">{formatFecha(a.caducidad)} · {formatNum(dias)} días</span>}</td>
            </tr>;
          })}</tbody>
        </table></div>}
    </div>

    {celda && datos && <AsignacionModal
      usuario={celda.usuario}
      formacionId={celda.formacionId}
      asignacion={celda.asignacion}
      catalogo={catalogo}
      centros={datos.centros}
      centroId={datos.centro?.id ?? null}
      puedeGestionar={datos.puede_gestionar}
      onClose={() => setCelda(null)}
      onSaved={(mensaje, kind) => {
        setCelda(null);
        setAviso({ message: mensaje, kind: kind ?? "ok" });
        setVersion((v) => v + 1);
      }}
    />}

    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}

function AsignacionModal({ usuario, formacionId, asignacion, catalogo, centros, centroId, puedeGestionar, onClose, onSaved }: {
  usuario: Row;
  formacionId: number;
  asignacion: Row | null;
  catalogo: Row[];
  centros: Array<{ id: number; nombre: string }>;
  centroId: number | null;
  puedeGestionar: boolean;
  onClose: () => void;
  onSaved: (mensaje: string, kind?: "ok" | "error") => void;
}) {
  const [formacionSel, setFormacionSel] = useState(String(formacionId));
  const [fecha, setFecha] = useState(String(asignacion?.fecha ?? hoyISO()).slice(0, 10));
  const [notas, setNotas] = useState(String(asignacion?.notas ?? ""));
  const [centroSel, setCentroSel] = useState(String(centroId ?? centros[0]?.id ?? ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const formacion = catalogo.find((f) => String(f.id) === formacionSel) ?? null;
  const meses = Number(formacion?.meses_validez ?? 0);
  const caducidad = meses > 0 && /^\d{4}-\d{2}-\d{2}$/.test(fecha)
    ? sumarIntervalo(fecha, { unidad: "meses", valor: meses })
    : null;

  const guardar = async () => {
    if (!puedeGestionar) { setError("Solo los responsables del centro pueden registrar formaciones"); return; }
    if (!formacionSel) { setError("Elige la formación"); return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) { setError("Indica la fecha de realización"); return; }
    setBusy(true);
    setError(null);
    try {
      const mismaFormacion = asignacion && Number(asignacion.formacion_id) === Number(formacionSel);
      // Una fecha posterior es una renovación: se guarda como registro nuevo
      // para no perder la anterior. Una fecha igual o anterior corrige la ficha.
      const esCorreccion = mismaFormacion && fecha <= String(asignacion.fecha).slice(0, 10);
      if (esCorreccion) {
        await api.put(`/api/formaciones/asignaciones/${String(asignacion.id)}`, { fecha, notas: notas.trim() || null });
      } else {
        await api.post("/api/formaciones/asignaciones", {
          usuario_id: Number(usuario.id),
          formacion_id: Number(formacionSel),
          fecha,
          notas: notas.trim() || null,
          centro_id: centroSel ? Number(centroSel) : null,
        });
      }
      onSaved(caducidad ? `Guardado · caduca el ${formatFecha(caducidad)}` : "Guardado · sin caducidad");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo guardar");
    } finally {
      setBusy(false);
    }
  };

  const borrar = async () => {
    if (!asignacion) return;
    if (!window.confirm(`¿Borrar el registro de «${String(formacion?.nombre ?? "")}» de ${String(usuario.nombre ?? "")}?`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/formaciones/asignaciones/${String(asignacion.id)}`);
      onSaved("Registro eliminado");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo borrar");
    } finally {
      setBusy(false);
    }
  };

  return <Modal
    title={`${String(formacion?.nombre ?? "Formación")} · ${String(usuario.nombre ?? "")}`}
    subtitle={asignacion ? `Registrada el ${formatFecha(asignacion.fecha)}` : "Nuevo registro"}
    onClose={onClose}
  >
    {error && <div className="form-error">{error}</div>}
    <div className="form-grid">
      <div className="field">
        <label htmlFor="fo-formacion">Formación, revisión o carnet</label>
        <select id="fo-formacion" className="input" value={formacionSel} onChange={(e) => setFormacionSel(e.target.value)}>
          {catalogo.map((f) => <option key={String(f.id)} value={String(f.id)}>
            {tipoDe(f.tipo).icon} {String(f.nombre)} {Number(f.meses_validez ?? 0) > 0 ? `(${Number(f.meses_validez)} m)` : "(sin caducidad)"}
          </option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="fo-fecha">Fecha de realización <span className="req">*</span></label>
        <input id="fo-fecha" className="input" type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} />
      </div>
      {centros.length > 0 && <div className="field">
        <label htmlFor="fo-centro">Centro</label>
        <select id="fo-centro" className="input" value={centroSel} onChange={(e) => setCentroSel(e.target.value)} disabled={Boolean(centroId)}>
          {centros.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
        </select>
      </div>}
      <div className="field full">
        <label htmlFor="fo-notas">Notas</label>
        <input id="fo-notas" className="input" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej. Pendiente de renovar en diciembre" maxLength={500} />
      </div>
    </div>
    <p className={`form-preview ${caducidad ? "" : "sin"}`}>
      {meses > 0
        ? caducidad ? <>Caduca el <strong>{formatFecha(caducidad)}</strong> ({meses} meses de validez)</> : "Indica una fecha válida para calcular la caducidad"
        : <>Sin caducidad: el catálogo no fija meses de validez para esta formación</>}
    </p>
    <div className="modal-footer">
      {asignacion && puedeGestionar && <button type="button" className="btn danger" onClick={() => void borrar()} disabled={busy}>🗑️ Borrar</button>}
      <div className="pedido-acciones">
        <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancelar</button>
        <button type="button" className="btn" onClick={() => void guardar()} disabled={busy || !puedeGestionar}>
          {busy ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </div>
  </Modal>;
}
