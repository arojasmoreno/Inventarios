import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Toast } from "./ui";

type Row = Record<string, unknown>;

// Prendas fijas del formulario de entrega (tal y como en la hoja de reparto).
const PRENDAS = [
  "Camiseta", "Pantalón", "Zapatos seguridad", "Botas de agua", "Guantes anticorte",
  "Casaca", "Pantalón casaca", "Chaqueton", "Polar", "Chaleco",
];

interface Linea { talla: string; av: string; aux: string; manga: string; color: string; }
const lineaVacia = (): Linea => ({ talla: "", av: "", aux: "", manga: "", color: "" });
const flagDe = (v: string): number | null => (v === "" ? null : v === "sí" ? 1 : 0);
const flagA = (v: unknown): string => (v === null || v === undefined ? "" : Number(v) === 1 ? "sí" : "no");
const fmtFlag = (v: unknown): string => (v === null || v === undefined ? "—" : Number(v) === 1 ? "Sí" : "No");
const hoy = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** Pestaña «Entregar ropa»: centro → trabajador → tabla de prendas; el
 *  registro se muestra después tabulado por operario. */
export function EntregaPage({ user }: { user: { rol: string; centro_id: number | null } }) {
  const canWrite = user.rol === "admin" || user.rol === "admin_centros";

  const [centros, setCentros] = useState<Row[]>([]);
  const [trabajadores, setTrabajadores] = useState<Row[]>([]);
  const [centroId, setCentroId] = useState<string>(user.centro_id ? String(user.centro_id) : "");
  const [usuarioId, setUsuarioId] = useState("");
  const [fecha, setFecha] = useState(hoy);
  const [lineas, setLineas] = useState<Record<string, Linea>>(() =>
    Object.fromEntries(PRENDAS.map((p) => [p, lineaVacia()])));

  const [list, setList] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [regCentro, setRegCentro] = useState("all");
  const [regOperario, setRegOperario] = useState("all");
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadTrabajadores = useCallback(async (centro: string) => {
    if (!centro) { setTrabajadores([]); return; }
    try {
      const r = await api.get<{ items: Row[] }>(`/api/ropa-entregas/trabajadores?centro_id=${centro}`);
      setTrabajadores(r.items);
    } catch { setTrabajadores([]); }
  }, []);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Row[] }>("/api/ropa-entregas");
      setList(r.items);
    } catch { setError("No se pudo cargar el registro de entregas"); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    void api.get<{ items: Row[] }>("/api/centros").then((r) => setCentros(r.items)).catch(() => setCentros([]));
    void load();
    if (user.centro_id) void loadTrabajadores(String(user.centro_id));
  }, [load, loadTrabajadores, user.centro_id]);

  const onChangeCentro = (valor: string) => {
    setCentroId(valor); setUsuarioId(""); setTrabajadores([]);
    void loadTrabajadores(valor);
  };

  const lineaConDatos = (l: Linea): boolean =>
    Boolean(l.talla.trim() || l.color.trim() || l.av || l.aux || l.manga);

  const guardar = async () => {
    setError(null);
    if (!centroId) { setError("Elige el centro de trabajo"); return; }
    if (!usuarioId) { setError("Elige el trabajador de ese centro"); return; }
    const enviadas = PRENDAS.filter((p) => lineaConDatos(lineas[p])).map((p) => {
      const l = lineas[p];
      return {
        prenda: p,
        talla: l.talla.trim() || null,
        alta_visibilidad: flagDe(l.av),
        auxiliar_servicios: flagDe(l.aux),
        manga_larga: flagDe(l.manga),
        color: l.color.trim() || null,
      };
    });
    if (!enviadas.length) { setError("Rellena los datos de al menos una prenda"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ creadas: number; actualizadas: number }>("/api/ropa-entregas", {
        centro_id: Number(centroId), usuario_id: Number(usuarioId), fecha, lineas: enviadas,
      });
      const total = r.creadas + r.actualizadas;
      setToast(`Entrega guardada · ${total} prenda${total === 1 ? "" : "s"}`);
      setLineas(Object.fromEntries(PRENDAS.map((p) => [p, lineaVacia()])));
      // La vista pasa a mostrar al operario recién guardado, tabulado.
      setRegCentro(centroId); setRegOperario(usuarioId);
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar la entrega"); }
    finally { setBusy(false); }
  };

  const editar = async (row: Row) => {
    setError(null);
    const centro = String(row.centro_id ?? "");
    setCentroId(centro);
    setUsuarioId(String(row.usuario_id ?? ""));
    setFecha(String(row.fecha ?? hoy()).slice(0, 10));
    if (centro) await loadTrabajadores(centro);
    const nuevas: Record<string, Linea> = Object.fromEntries(PRENDAS.map((p) => [p, lineaVacia()]));
    nuevas[String(row.prenda)] = {
      talla: row.talla == null ? "" : String(row.talla),
      av: flagA(row.alta_visibilidad),
      aux: flagA(row.auxiliar_servicios),
      manga: flagA(row.manga_larga),
      color: row.color == null ? "" : String(row.color),
    };
    setLineas(nuevas);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const borrar = async (row: Row) => {
    if (!window.confirm(`¿Eliminar la entrega de «${String(row.prenda)}» a ${String(row.usuario_nombre ?? "este operario")}? Esta acción no se puede deshacer.`)) return;
    try {
      await api.del(`/api/ropa-entregas/${String(row.id)}`);
      setToast("Entrega eliminada");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo eliminar"); }
  };

  // Vista tabulada por operario (filtros opcionales de centro y trabajador).
  const filtradas = useMemo(() => list.filter((r) =>
    (regCentro === "all" || String(r.centro_id) === regCentro) &&
    (regOperario === "all" || String(r.usuario_id) === regOperario)), [list, regCentro, regOperario]);
  const grupos = useMemo(() => {
    const porId = new Map<string, Row[]>();
    for (const r of [...filtradas].sort((a, b) =>
      String(b.fecha).localeCompare(String(a.fecha)) ||
      PRENDAS.indexOf(String(a.prenda)) - PRENDAS.indexOf(String(b.prenda)))) {
      const key = String(r.usuario_id);
      if (!porId.has(key)) porId.set(key, []);
      porId.get(key)!.push(r);
    }
    return [...porId.entries()].map(([id, rows]) => ({ id, rows }));
  }, [filtradas]);
  const operariosOpts = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of filtradas) seen.set(String(r.usuario_id), String(r.usuario_nombre ?? `#${r.usuario_id}`));
    return [...seen.entries()].map(([id, nombre]) => ({ id, nombre }));
  }, [filtradas]);

  const selCls = "input";
  const flagOpts = (v: string, onChange: (x: string) => void) => (
    <select className={selCls} value={v} onChange={(e) => onChange(e.target.value)} aria-label="Sí / No">
      <option value="">—</option>
      <option value="sí">Sí</option>
      <option value="no">No</option>
    </select>
  );

  return <>
    {canWrite && <div className="card card-pad">
      <div className="section-head"><h3>Nueva entrega de ropa</h3>
        <span className="badge muted">Prenda · talla · A/V · auxiliar · manga larga · color</span></div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Elige el centro de trabajo y el trabajador; después rellena la tabla con los datos de cada prenda.</p>
      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-grid" style={{ marginBottom: 14 }}>
        <div className="field"><label htmlFor="en-centro">Centro de trabajo<span className="req">*</span></label>
          <select id="en-centro" className={selCls} value={centroId} onChange={(e) => onChangeCentro(e.target.value)}>
            <option value="">— Elige un centro —</option>
            {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
          </select></div>
        <div className="field"><label htmlFor="en-trab">Trabajador<span className="req">*</span></label>
          <select id="en-trab" className={selCls} value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)} disabled={!centroId}>
            <option value="">{centroId ? (trabajadores.length ? "— Elige un trabajador —" : "Sin trabajadores en ese centro") : "Primero elige un centro"}</option>
            {trabajadores.map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.nombre)} ({String(t.username)})</option>)}
          </select></div>
        <div className="field"><label htmlFor="en-fecha">Fecha de entrega</label>
          <input id="en-fecha" className={selCls} type="date" value={fecha} onChange={(e) => setFecha(e.target.value || hoy())} /></div>
      </div>
      <div className="table-scroll">
        <table className="entrega-table entrega-form">
          <thead><tr>
            <th>Prenda</th><th>Talla</th><th>A/V (si/No)</th><th>Auxiliar servicios (si/No)</th><th>Manga larga (si/no)</th><th>Color (indicar)</th>
          </tr></thead>
          <tbody>{PRENDAS.map((p) => {
            const l = lineas[p];
            const set = (patch: Partial<Linea>) => setLineas((prev) => ({ ...prev, [p]: { ...prev[p], ...patch } }));
            return <tr key={p}>
              <td><strong>{p}</strong></td>
              <td><input className={selCls} value={l.talla} maxLength={40} placeholder="Ej. M, 42…" onChange={(e) => set({ talla: e.target.value })} /></td>
              <td>{flagOpts(l.av, (v) => set({ av: v }))}</td>
              <td>{flagOpts(l.aux, (v) => set({ aux: v }))}</td>
              <td>{flagOpts(l.manga, (v) => set({ manga: v }))}</td>
              <td><input className={selCls} value={l.color} maxLength={40} placeholder="Ej. Azul…" onChange={(e) => set({ color: e.target.value })} /></td>
            </tr>;
          })}</tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button className="btn secondary" onClick={() => setLineas(Object.fromEntries(PRENDAS.map((p) => [p, lineaVacia()])) as Record<string, Linea>)}>Limpiar tabla</button>
        <button className="btn" onClick={() => void guardar()} disabled={busy}>{busy ? "Guardando…" : "💾 Guardar entrega"}</button>
      </div>
    </div>}

    <div className="card card-pad">
      <div className="section-head"><h3>Entregas registradas</h3>
        <div className="toolbar">
          <select className={selCls} style={{ width: 170 }} value={regCentro} onChange={(e) => { setRegCentro(e.target.value); setRegOperario("all"); }}>
            <option value="all">Todos los centros</option>
            {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
          </select>
          <select className={selCls} style={{ width: 190 }} value={regOperario} onChange={(e) => setRegOperario(e.target.value)}>
            <option value="all">Todos los trabajadores</option>
            {operariosOpts.map((o) => <option key={o.id} value={o.id}>{o.nombre}</option>)}
          </select>
        </div>
      </div>
      {loading ? <div className="loading">Cargando…</div> : !grupos.length
        ? <div className="empty"><span className="icon">👕</span><strong>No hay entregas registradas</strong><p>{regCentro !== "all" || regOperario !== "all" ? "Prueba con otros filtros." : "Rellena el formulario para registrar la primera entrega."}</p></div>
        : grupos.map((g) => <div className="entrega-grupo" key={g.id}>
            <div className="section-head" style={{ marginTop: 6 }}>
              <h3 style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span aria-hidden="true">👷</span>{String(g.rows[0].usuario_nombre ?? `#${g.id}`)}
                <span className="badge muted" style={{ fontWeight: 500 }}>{String(g.rows[0].centro_nombre ?? "—")}</span>
              </h3>
              <span className="muted" style={{ fontSize: 12.5 }}>{g.rows.length} prendas</span>
            </div>
            <div className="table-scroll">
              <table className="entrega-table">
                <thead><tr>
                  <th>Prenda</th><th>Talla</th><th>A/V (si/No)</th><th>Auxiliar servicios (si/No)</th><th>Manga larga (si/no)</th><th>Color (indicar)</th><th>Fecha</th>
                  {canWrite && <th className="right">Acciones</th>}
                </tr></thead>
                <tbody>{g.rows.map((r) => <tr key={String(r.id)}>
                  <td>{String(r.prenda)}</td>
                  <td>{r.talla == null ? "—" : String(r.talla)}</td>
                  <td>{fmtFlag(r.alta_visibilidad)}</td>
                  <td>{fmtFlag(r.auxiliar_servicios)}</td>
                  <td>{fmtFlag(r.manga_larga)}</td>
                  <td>{r.color == null ? "—" : String(r.color)}</td>
                  <td>{String(r.fecha ?? "—").slice(0, 10).split("-").reverse().join("/")}</td>
                  {canWrite && <td className="right"><div className="row-actions">
                    <button className="btn secondary small" onClick={() => void editar(r)}>✏️ Editar</button>
                    <button className="btn danger small" onClick={() => void borrar(r)}>🗑️ Borrar</button>
                  </div></td>}
                </tr>)}</tbody>
              </table>
            </div>
          </div>)}
    </div>
    {toast && <Toast message={toast} kind="ok" onClose={() => setToast(null)} />}
  </>;
}
