import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Modal, Toast, downloadCsv, formatFecha } from "./ui";

type Row = Record<string, unknown>;

interface Item { id: number; texto: string; tipo: "booleano" | "escala"; orden: number; }
interface Respuesta { item_id: number; texto: string; tipo: "booleano" | "escala"; valor: boolean | number; }

const fechaHora = (v: unknown): string => {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return "—";
  const [f, h] = v.replace("T", " ").split(" ");
  return `${formatFecha(f)}${h ? ` · ${h.slice(0, 5)}` : ""}`;
};

const leerRespuestas = (raw: unknown): Respuesta[] => {
  if (typeof raw !== "string" || !raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as Respuesta[]) : [];
  } catch { return []; }
};

// Respuestas que denotan un problema: un «no» o una puntuación baja.
const incidencias = (respuestas: Respuesta[]): Respuesta[] =>
  respuestas.filter((r) => (r.tipo === "booleano" ? r.valor === false : Number(r.valor) <= 2));

const completas = (items: Item[], valores: Record<number, boolean | number>): boolean =>
  items.length > 0 && items.every(i => valores[i.id] !== undefined);

/** Preguntas del cuestionario de una máquina (sí/no o puntuación 1-5). */
function Preguntas({ items, valores, onCambio }: { items: Item[]; valores: Record<number, boolean | number>; onCambio: (id: number, v: boolean | number) => void }) {
  return <div style={{ display: "grid", gap: 10 }}>
    {items.map(i => <div key={i.id} className="field" style={{ margin: 0 }}>
      <label style={{ fontWeight: 600 }}>{i.texto}</label>
      {i.tipo === "escala"
        ? <div className="chips" style={{ margin: 0 }}>
            {[1, 2, 3, 4, 5].map(n => <button key={n} type="button" className={"btn small" + (valores[i.id] === n ? "" : " secondary")} onClick={() => onCambio(i.id, n)} aria-pressed={valores[i.id] === n}>{n}</button>)}
            <span style={{ color: "var(--muted)", fontSize: 12, alignSelf: "center" }}>1 mal · 5 perfecta</span>
          </div>
        : <div className="chips" style={{ margin: 0 }}>
            <button type="button" className={"btn small" + (valores[i.id] === true ? "" : " secondary")} onClick={() => onCambio(i.id, true)} aria-pressed={valores[i.id] === true}>Sí</button>
            <button type="button" className={"btn small" + (valores[i.id] === false ? "" : " secondary")} onClick={() => onCambio(i.id, false)} aria-pressed={valores[i.id] === false}>No</button>
          </div>}
    </div>)}
  </div>;
}

const resumen = (respuestas: Respuesta[]): string => {
  if (!respuestas.length) return "—";
  const malas = incidencias(respuestas).length;
  return `${respuestas.length - malas}/${respuestas.length}${malas ? ` · ${malas} incidencia${malas === 1 ? "" : "s"}` : ""}`;
};

/** Sección «Uso y registro»: cada vez que alguien coge una máquina queda
 *  apuntado quién es, cuándo y cómo la recoge; al devolverla se responde el
 *  mismo cuestionario (cómo la deja). Cada máquina tiene sus propias preguntas. */
export function UsosMaquinaria({ user }: { user: { id: number; rol: string; nombre?: string } }) {
  const puedeGestionar = user.rol !== "usuario";
  const [maquinas, setMaquinas] = useState<Row[]>([]);
  const [usos, setUsos] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [estado, setEstado] = useState<"all" | "en_uso" | "devuelta">("all");
  const [centroId, setCentroId] = useState("all");
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  // Modales: recoger, devolver, detalle y cuestionario de la máquina.
  const [recoger, setRecoger] = useState<{ maquinaId: string; items: Item[]; respuestas: Record<number, boolean | number>; notas: string; error: string | null } | null>(null);
  const [devolver, setDevolver] = useState<{ uso: Row; items: Item[]; respuestas: Record<number, boolean | number>; notas: string; error: string | null } | null>(null);
  const [detalle, setDetalle] = useState<Row | null>(null);
  const [cuestionario, setCuestionario] = useState<{ maquinaId: number; nombre: string; items: Array<{ texto: string; tipo: "booleano" | "escala" }>; error: string | null } | null>(null);
  const [cargandoModal, setCargandoModal] = useState(false);
  const [busy, setBusy] = useState(false);

  const cargarUsos = useCallback(async () => {
    const r = await api.get<{ items: Row[] }>("/api/maquinaria-usos?limit=1000");
    setUsos(r.items);
  }, []);

  const cargarTodo = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      await cargarUsos();
      const r = await api.get<{ items: Row[] }>("/api/maquinaria");
      setMaquinas(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el registro de uso");
    } finally { setLoading(false); }
  }, [cargarUsos]);

  useEffect(() => { void cargarTodo(); }, [cargarTodo]);
  useEffect(() => {
    void Promise.all([
      api.get<{ items: Row[] }>("/api/centros").then(r => setCentros(r.items)).catch(() => setCentros([])),
    ]);
  }, []);

  const filtrados = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return usos.filter(r =>
      (estado === "all" || String(r.estado) === estado) &&
      (centroId === "all" || String(r.centro_id ?? "") === centroId) &&
      (!needle || ["maquina_nombre", "numero_serie", "tipo", "usuario_nombre", "username", "centro_nombre"]
        .some(k => String(r[k] ?? "").toLowerCase().includes(needle))));
  }, [usos, q, estado, centroId]);

  const abiertos = usos.filter(r => r.estado === "en_uso");
  const mias = abiertos.filter(r => Number(r.usuario_id) === user.id);
  const disponibles = maquinas.filter(m => !m.en_uso_por || Number(m.uso_usuario_id) === user.id);

  const pedirChecklist = async (maquinaId: number): Promise<Item[]> => {
    const r = await api.get<{ items: Item[] }>(`/api/maquinaria-usos/checklist/${maquinaId}`);
    return r.items;
  };

  const abrirRecoger = async (maquinaId = "") => {
    setCargandoModal(true);
    try {
      const items = maquinaId ? await pedirChecklist(Number(maquinaId)) : [];
      setRecoger({ maquinaId, items, respuestas: {}, notas: "", error: null });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "No se pudo cargar el cuestionario", kind: "error" });
    } finally { setCargandoModal(false); }
  };

  const elegirMaquina = async (maquinaId: string) => {
    if (!recoger) return;
    if (!maquinaId) { setRecoger({ ...recoger, maquinaId: "", items: [], respuestas: {} }); return; }
    setCargandoModal(true);
    try {
      const items = await pedirChecklist(Number(maquinaId));
      setRecoger({ ...recoger, maquinaId, items, respuestas: {}, error: null });
    } catch (e) {
      setRecoger({ ...recoger, maquinaId, items: [], error: e instanceof Error ? e.message : "No se pudo cargar el cuestionario" });
    } finally { setCargandoModal(false); }
  };

  const abrirDevolver = async (uso: Row) => {
    setCargandoModal(true);
    try {
      const items = await pedirChecklist(Number(uso.maquina_id));
      setDevolver({ uso, items, respuestas: {}, notas: "", error: null });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "No se pudo cargar el cuestionario", kind: "error" });
    } finally { setCargandoModal(false); }
  };

  const abrirCuestionario = async (maquinaId: number, nombre: string) => {
    setCargandoModal(true);
    try {
      const items = await pedirChecklist(maquinaId);
      setCuestionario({ maquinaId, nombre, items: items.map(i => ({ texto: i.texto, tipo: i.tipo })), error: null });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "No se pudo cargar el cuestionario", kind: "error" });
    } finally { setCargandoModal(false); }
  };

  const respuestasDe = (items: Item[], valores: Record<number, boolean | number>) =>
    items.map(i => ({ item_id: i.id, valor: valores[i.id] }));

  const guardarRecogida = async () => {
    if (!recoger) return;
    setBusy(true);
    try {
      await api.post("/api/maquinaria-usos", {
        maquina_id: Number(recoger.maquinaId),
        respuestas: respuestasDe(recoger.items, recoger.respuestas),
        notas: recoger.notas,
      });
      setRecoger(null);
      setToast({ message: "Máquina recogida: registro abierto", kind: "ok" });
      await cargarTodo();
    } catch (e) {
      setRecoger({ ...recoger, error: e instanceof Error ? e.message : "No se pudo registrar la recogida" });
    } finally { setBusy(false); }
  };

  const guardarDevolucion = async () => {
    if (!devolver) return;
    setBusy(true);
    try {
      await api.post(`/api/maquinaria-usos/${String(devolver.uso.id)}/devolucion`, {
        respuestas: respuestasDe(devolver.items, devolver.respuestas),
        notas: devolver.notas,
      });
      setDevolver(null);
      setToast({ message: "Devolución registrada", kind: "ok" });
      await cargarTodo();
    } catch (e) {
      setDevolver({ ...devolver, error: e instanceof Error ? e.message : "No se pudo registrar la devolución" });
    } finally { setBusy(false); }
  };

  const guardarCuestionario = async () => {
    if (!cuestionario) return;
    setBusy(true);
    try {
      await api.put(`/api/maquinaria-usos/checklist/${cuestionario.maquinaId}`, { items: cuestionario.items });
      setCuestionario(null);
      setToast({ message: "Cuestionario actualizado", kind: "ok" });
    } catch (e) {
      setCuestionario({ ...cuestionario, error: e instanceof Error ? e.message : "No se pudo guardar el cuestionario" });
    } finally { setBusy(false); }
  };

  const exportCsv = () => downloadCsv(`registro-maquinaria-${new Date().toISOString().slice(0, 10)}.csv`,
    ["Máquina", "Nº serie", "Tipo", "Usuario", "Centro", "Recogida", "Devolución", "Estado", "Recogida (respuestas)", "Notas recogida", "Devolución (respuestas)", "Notas devolución"],
    filtrados.map(r => {
      const rec = leerRespuestas(r.respuestas_recogida);
      const dev = leerRespuestas(r.respuestas_devolucion);
      const texto = (rs: Respuesta[]) => rs.map(x => `${x.texto}: ${x.tipo === "booleano" ? (x.valor ? "Sí" : "No") : `${String(x.valor)}/5`}`).join(" | ");
      return [
        String(r.maquina_nombre ?? ""), String(r.numero_serie ?? ""), String(r.tipo ?? ""),
        String(r.usuario_nombre ?? ""), String(r.centro_nombre ?? ""),
        fechaHora(r.fecha_recogida), fechaHora(r.fecha_devolucion),
        r.estado === "en_uso" ? "En uso" : "Devuelta",
        texto(rec), String(r.notas_recogida ?? ""), texto(dev), String(r.notas_devolucion ?? ""),
      ];
    }));

  return <>
    <div className="toolbar no-print" style={{ flexWrap: "wrap" }}>
      <input className="input" style={{ maxWidth: 240 }} placeholder="🔍 Buscar máquina u operario…" value={q} onChange={e => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 170 }} value={estado} onChange={e => setEstado(e.target.value as typeof estado)} aria-label="Filtrar por estado">
        <option value="all">Todos los usos</option>
        <option value="en_uso">En uso</option>
        <option value="devuelta">Devueltas</option>
      </select>
      {centros.length > 1 && <select className="input" style={{ maxWidth: 180 }} value={centroId} onChange={e => setCentroId(e.target.value)} aria-label="Filtrar por centro">
        <option value="all">Todos los centros</option>
        {centros.map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>}
      <div className="spacer" />
      {puedeGestionar && <button className="btn secondary" onClick={exportCsv} disabled={!filtrados.length}>⬇️ CSV</button>}
      <button className="btn" onClick={() => void abrirRecoger()} disabled={cargandoModal || !disponibles.length}>＋ Recoger máquina</button>
    </div>

    {abiertos.length > 0 && <div className="banner" style={{ marginBottom: 12, background: "#fef3c7", color: "#92400e" }}>
      🔧 <strong>{abiertos.length}</strong> máquina{abiertos.length === 1 ? "" : "s"} en uso
      {abiertos.length <= 3 && <>: {abiertos.map(r => `${String(r.maquina_nombre)} (${String(r.usuario_nombre)})`).join(" · ")}</>}
      {mias.length > 0 && <> · tienes <strong>{mias.length}</strong> en tu poder</>}
    </div>}

    <div className="card">
      {loading ? <div className="loading">Cargando…</div>
        : error ? <div className="empty">⚠️ {error}</div>
        : !filtrados.length ? <div className="empty"><span className="icon">🔧</span><strong>Sin registros de uso</strong><p>{q || estado !== "all" || centroId !== "all" ? "Prueba con otra búsqueda u otro filtro." : "Pulsa «Recoger máquina» para apuntar el primer uso."}</p></div>
        : <div className="table-scroll"><table>
            <thead><tr><th>Máquina</th><th>Usuario</th><th>Recogida</th><th>Devolución</th><th>Estado</th><th>Cuestionario</th><th className="right">Acciones</th></tr></thead>
            <tbody>{filtrados.map(r => {
              const rec = leerRespuestas(r.respuestas_recogida);
              const dev = leerRespuestas(r.respuestas_devolucion);
              const malas = incidencias(rec).length + incidencias(dev).length;
              const enUso = r.estado === "en_uso";
              return <tr key={String(r.id)}>
                <td>{String(r.maquina_nombre ?? "—")}{r.numero_serie ? <span style={{ color: "var(--muted)" }}> · {String(r.numero_serie)}</span> : null}</td>
                <td>{String(r.usuario_nombre ?? "—")}{Number(r.usuario_id) === user.id ? <span className="badge info" style={{ marginLeft: 6 }}>tú</span> : null}</td>
                <td>{fechaHora(r.fecha_recogida)}</td>
                <td>{enUso ? "—" : fechaHora(r.fecha_devolucion)}</td>
                <td><span className={`badge ${enUso ? "warn" : "ok"}`}>{enUso ? "En uso" : "Devuelta"}</span></td>
                <td>{resumen(rec)}{dev.length ? <> · {resumen(dev)}</> : null}{malas > 0 ? <span className="badge danger" style={{ marginLeft: 6 }}>⚠️ {malas}</span> : null}</td>
                <td className="right"><div className="row-actions">
                  <button className="btn secondary small" onClick={() => setDetalle(r)}>👁️ Ver</button>
                  {enUso && (Number(r.usuario_id) === user.id || puedeGestionar) && <button className="btn small" onClick={() => void abrirDevolver(r)} disabled={cargandoModal}>✅ Devolver</button>}
                </div></td>
              </tr>;
            })}</tbody>
          </table></div>}
    </div>
    <p className="no-print" style={{ color: "var(--muted)", margin: 0 }}>
      {filtrados.length} de {usos.length} registros · quién coge cada máquina, cuándo y cómo la recoge y la deja
    </p>

    {recoger && <Modal title="Recoger máquina" subtitle="Queda apuntado tu nombre, la fecha y cómo la recoges" onClose={() => setRecoger(null)} wide>
      {recoger.error && <div className="form-error">{recoger.error}</div>}
      <div className="form-grid">
        <div className="full field">
          <label>Máquina<span className="req">*</span></label>
          <select className="input" value={recoger.maquinaId} onChange={e => void elegirMaquina(e.target.value)} disabled={cargandoModal}>
            <option value="">Elige una máquina…</option>
            {disponibles.map(m => <option key={String(m.id)} value={String(m.id)}>
              {String(m.nombre)}{m.numero_serie ? ` · ${String(m.numero_serie)}` : ""}{Number(m.uso_usuario_id) === user.id ? " (en tu poder)" : ""}
            </option>)}
          </select>
          {!disponibles.length && <p style={{ color: "var(--muted)", margin: "6px 0 0" }}>Todas tus máquinas están en uso por otras personas.</p>}
        </div>
      </div>
      {recoger.maquinaId && (cargandoModal ? <div className="loading">Cargando cuestionario…</div> : <>
        <div className="section-head" style={{ marginTop: 8 }}><h3 style={{ fontSize: 14 }}>Cuestionario de recogida</h3>
          {puedeGestionar && <button className="btn secondary small" onClick={() => {
            const m = maquinas.find(x => String(x.id) === recoger.maquinaId);
            setRecoger(null);
            void abrirCuestionario(Number(recoger.maquinaId), String(m?.nombre ?? "Máquina"));
          }}>⚙️ Editar cuestionario</button>}
        </div>
        <Preguntas items={recoger.items} valores={recoger.respuestas}
          onCambio={(id, v) => setRecoger({ ...recoger, respuestas: { ...recoger.respuestas, [id]: v }, error: null })} />
        <div className="field" style={{ marginTop: 12 }}>
          <label>Notas de la recogida</label>
          <textarea className="input" rows={2} value={recoger.notas} onChange={e => setRecoger({ ...recoger, notas: e.target.value })} placeholder="Depósitos, accesorios, incidencias al cogerla…" />
        </div>
      </>)}
      <div className="modal-footer">
        <button type="button" className="btn secondary" onClick={() => setRecoger(null)}>Cancelar</button>
        <button type="button" className="btn" onClick={() => void guardarRecogida()} disabled={busy || !recoger.maquinaId || !completas(recoger.items, recoger.respuestas)}>
          {busy ? "Guardando…" : "Recoger y abrir registro"}
        </button>
      </div>
    </Modal>}

    {devolver && <Modal title={`Devolver «${String(devolver.uso.maquina_nombre)}»`} subtitle={`Recogida por ${String(devolver.uso.usuario_nombre)} el ${fechaHora(devolver.uso.fecha_recogida)}`} onClose={() => setDevolver(null)} wide>
      {devolver.error && <div className="form-error">{devolver.error}</div>}
      {cargandoModal ? <div className="loading">Cargando cuestionario…</div> : <>
        <div className="section-head" style={{ marginTop: 8 }}><h3 style={{ fontSize: 14 }}>Cuestionario de devolución</h3></div>
        <Preguntas items={devolver.items} valores={devolver.respuestas}
          onCambio={(id, v) => setDevolver({ ...devolver, respuestas: { ...devolver.respuestas, [id]: v }, error: null })} />
        <div className="field" style={{ marginTop: 12 }}>
          <label>Notas de la devolución</label>
          <textarea className="input" rows={2} value={devolver.notas} onChange={e => setDevolver({ ...devolver, notas: e.target.value })} placeholder="Cómo la dejas, piezas cambiadas, incidencias…" />
        </div>
      </>}
      <div className="modal-footer">
        <button type="button" className="btn secondary" onClick={() => setDevolver(null)}>Cancelar</button>
        <button type="button" className="btn" onClick={() => void guardarDevolucion()} disabled={busy || !completas(devolver.items, devolver.respuestas)}>{busy ? "Guardando…" : "Registrar devolución"}</button>
      </div>
    </Modal>}

    {detalle && <Modal title={`Uso de «${String(detalle.maquina_nombre)}»`} subtitle={`${String(detalle.usuario_nombre)} · ${String(detalle.centro_nombre ?? "sin centro")}`} onClose={() => setDetalle(null)} wide>
      <div className="form-grid">
        <div className="field"><label>Recogida</label><p style={{ margin: 0 }}>{fechaHora(detalle.fecha_recogida)}</p></div>
        <div className="field"><label>Devolución</label><p style={{ margin: 0 }}>{detalle.estado === "en_uso" ? <span className="badge warn">En uso</span> : fechaHora(detalle.fecha_devolucion)}</p></div>
      </div>
      {[["Cuestionario de recogida", leerRespuestas(detalle.respuestas_recogida), detalle.notas_recogida],
        ["Cuestionario de devolución", leerRespuestas(detalle.respuestas_devolucion), detalle.notas_devolucion]].map(([titulo, rs, notas]) => {
        const respuestas = rs as Respuesta[];
        if (!respuestas.length && !notas) return null;
        return <div key={String(titulo)} style={{ marginTop: 12 }}>
          <div className="section-head"><h3 style={{ fontSize: 14 }}>{String(titulo)}</h3><span className="badge muted">{resumen(respuestas)}</span></div>
          <div className="table-scroll"><table><tbody>{respuestas.map(r => <tr key={`${String(titulo)}-${r.item_id}`}>
            <td>{r.texto}</td>
            <td className="right">{r.tipo === "booleano"
              ? <span className={`badge ${r.valor ? "ok" : "danger"}`}>{r.valor ? "Sí" : "No"}</span>
              : <span className={`badge ${Number(r.valor) <= 2 ? "danger" : Number(r.valor) === 3 ? "warn" : "ok"}`}>{String(r.valor)}/5</span>}</td>
          </tr>)}</tbody></table></div>
          {notas ? <p style={{ margin: "8px 0 0", color: "var(--muted)" }}>📝 {String(notas)}</p> : null}
        </div>;
      })}
      <div className="modal-footer">
        {detalle.estado === "en_uso" && (Number(detalle.usuario_id) === user.id || puedeGestionar) &&
          <button className="btn" onClick={() => { const r = detalle; setDetalle(null); void abrirDevolver(r); }}>✅ Devolver ahora</button>}
        <button className="btn secondary" onClick={() => setDetalle(null)}>Cerrar</button>
      </div>
    </Modal>}

    {cuestionario && <Modal title={`Cuestionario de «${cuestionario.nombre}»`} subtitle="Preguntas que se responden al recoger y al devolver la máquina" onClose={() => setCuestionario(null)} wide>
      {cuestionario.error && <div className="form-error">{cuestionario.error}</div>}
      <div style={{ display: "grid", gap: 8 }}>
        {cuestionario.items.map((it, i) => <div key={i} style={{ display: "grid", gridTemplateColumns: "1fr 150px 40px", gap: 8, alignItems: "center" }}>
          <input className="input" value={it.texto} maxLength={120} placeholder="Pregunta" aria-label={`Pregunta ${i + 1}`}
            onChange={e => setCuestionario({ ...cuestionario, items: cuestionario.items.map((x, j) => j === i ? { ...x, texto: e.target.value } : x) })} />
          <select className="input" value={it.tipo} aria-label={`Tipo de la pregunta ${i + 1}`}
            onChange={e => setCuestionario({ ...cuestionario, items: cuestionario.items.map((x, j) => j === i ? { ...x, tipo: e.target.value as "booleano" | "escala" } : x) })}>
            <option value="booleano">Sí / No</option>
            <option value="escala">Puntuación 1-5</option>
          </select>
          <button type="button" className="btn danger small" title="Quitar pregunta" disabled={cuestionario.items.length <= 1}
            onClick={() => setCuestionario({ ...cuestionario, items: cuestionario.items.filter((_, j) => j !== i) })}>🗑️</button>
        </div>)}
      </div>
      <button type="button" className="btn secondary" style={{ marginTop: 10 }} disabled={cuestionario.items.length >= 20}
        onClick={() => setCuestionario({ ...cuestionario, items: [...cuestionario.items, { texto: "", tipo: "booleano" }] })}>＋ Añadir pregunta</button>
      <div className="modal-footer">
        <button type="button" className="btn secondary" onClick={() => setCuestionario(null)}>Cancelar</button>
        <button type="button" className="btn" onClick={() => void guardarCuestionario()} disabled={busy}>{busy ? "Guardando…" : "Guardar cuestionario"}</button>
      </div>
    </Modal>}

    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
