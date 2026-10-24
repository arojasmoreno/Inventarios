import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { Toast, downloadCsv, formatNum } from "./ui";

type Row = Record<string, unknown>;

// Artículos del inventario entregables: ropa de trabajo y EPIs.
interface Art {
  tipo: "ropa_trabajo" | "epis";
  id: number;
  codigo: string;
  nombre: string;
  stock: number;
}
interface Linea {
  tipo: "ropa_trabajo" | "epis";
  id: number;
  cantidad: number;
}

const artKey = (a: Art | Linea) => `${a.tipo}:${a.id}`;
const hoy = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const etiqueta = (a: Art) => `${a.codigo ? `${a.codigo} · ` : ""}${a.nombre}`;
const tipoLabel = (v: unknown) => (v === "epis" ? "EPI" : "Ropa");

/** Sección Entregas: registra la equipación (ropa y EPIs del inventario) que
 *  recibe cada operario y el día; el stock se descuenta automáticamente. */
export function EntregaPage({ user }: { user: { rol: string; centro_id: number | null } }) {
  const canWrite = user.rol === "admin" || user.rol === "admin_centros";

  const [centros, setCentros] = useState<Row[]>([]);
  const [trabajadores, setTrabajadores] = useState<Row[]>([]);
  const [centroId, setCentroId] = useState<string>(user.centro_id ? String(user.centro_id) : "");
  const [usuarioId, setUsuarioId] = useState("");
  const [fecha, setFecha] = useState(hoy);

  const [catalogo, setCatalogo] = useState<Art[]>([]);
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [selArt, setSelArt] = useState("");
  const [cant, setCant] = useState("1");

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

  // Catálogo entregable (ropa + EPIs) con su stock actual.
  const loadCatalogo = useCallback(async () => {
    try {
      const [ropa, epis] = await Promise.all([
        api.get<{ items: Row[] }>("/api/ropa-trabajo"),
        api.get<{ items: Row[] }>("/api/epis"),
      ]);
      const arts: Art[] = [
        ...ropa.items.map((r) => ({
          tipo: "ropa_trabajo" as const, id: Number(r.id),
          codigo: r.codigo == null ? "" : String(r.codigo),
          nombre: String(r.prenda ?? `#${r.id}`), stock: Number(r.stock ?? 0),
        })),
        ...epis.items.map((r) => ({
          tipo: "epis" as const, id: Number(r.id),
          codigo: r.codigo == null ? "" : String(r.codigo),
          nombre: String(r.descripcion ?? r.modelo ?? r.nombre ?? `#${r.id}`), stock: Number(r.stock ?? 0),
        })),
      ];
      setCatalogo(arts);
    } catch { setCatalogo([]); }
  }, []);

  useEffect(() => {
    void api.get<{ items: Row[] }>("/api/centros").then((r) => setCentros(r.items)).catch(() => setCentros([]));
    void load();
    void loadCatalogo();
    if (user.centro_id) void loadTrabajadores(String(user.centro_id));
  }, [load, loadCatalogo, loadTrabajadores, user.centro_id]);

  const onChangeCentro = (valor: string) => {
    setCentroId(valor); setUsuarioId(""); setTrabajadores([]);
    void loadTrabajadores(valor);
  };

  // Stock disponible de un artículo: total menos lo ya puesto en el formulario.
  const disponible = useCallback((a: Art, excludeKey?: string): number => {
    const usado = lineas.filter((l) => artKey(l) === artKey(a) && artKey(l) !== excludeKey)
      .reduce((s, l) => s + l.cantidad, 0);
    return a.stock - usado;
  }, [lineas]);

  const articulosDisp = useMemo(() => catalogo.filter((a) => !lineas.some((l) => artKey(l) === artKey(a))), [catalogo, lineas]);

  const anadirLinea = () => {
    setError(null);
    const art = catalogo.find((a) => artKey(a) === selArt);
    if (!art) { setError("Elige un artículo del inventario"); return; }
    const n = Number(cant);
    if (!Number.isInteger(n) || n < 1) { setError("La cantidad debe ser al menos 1"); return; }
    if (n > disponible(art)) { setError(`Stock insuficiente para «${etiqueta(art)}»: quedan ${disponible(art)} uds.`); return; }
    setLineas((prev) => [...prev, { tipo: art.tipo, id: art.id, cantidad: n }]);
    setSelArt(""); setCant("1");
  };

  const guardar = async () => {
    setError(null);
    if (!centroId) { setError("Elige el centro de trabajo"); return; }
    if (!usuarioId) { setError("Elige el trabajador de ese centro"); return; }
    if (!lineas.length) { setError("Añade al menos un artículo del inventario"); return; }
    setBusy(true);
    try {
      const r = await api.post<{ creadas: number }>("/api/ropa-entregas", {
        centro_id: Number(centroId), usuario_id: Number(usuarioId), fecha,
        lineas: lineas.map((l) => ({ articulo_tipo: l.tipo, articulo_id: l.id, cantidad: l.cantidad })),
      });
      setToast(`Entrega guardada · ${r.creadas} artículo${r.creadas === 1 ? "" : "s"} descontado${r.creadas === 1 ? "" : "s"} del inventario`);
      setLineas([]); setSelArt(""); setCant("1");
      // La vista pasa a mostrar al operario recién guardado, tabulado.
      setRegCentro(centroId); setRegOperario(usuarioId);
      await Promise.all([load(), loadCatalogo()]);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo guardar la entrega"); }
    finally { setBusy(false); }
  };

  const borrar = async (row: Row) => {
    if (!window.confirm(`¿Eliminar la entrega de «${String(row.prenda)}» a ${String(row.usuario_nombre ?? "este operario")}? Si viene del inventario, su stock se reintegrará.`)) return;
    try {
      await api.del(`/api/ropa-entregas/${String(row.id)}`);
      setToast("Entrega eliminada");
      await Promise.all([load(), loadCatalogo()]);
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo eliminar"); }
  };

  // Vista tabulada por operario (filtros opcionales de centro y trabajador).
  const filtradas = useMemo(() => list.filter((r) =>
    (regCentro === "all" || String(r.centro_id) === regCentro) &&
    (regOperario === "all" || String(r.usuario_id) === regOperario)), [list, regCentro, regOperario]);
  const grupos = useMemo(() => {
    const porId = new Map<string, Row[]>();
    for (const r of [...filtradas].sort((a, b) =>
      String(b.fecha).localeCompare(String(a.fecha)) || String(a.prenda).localeCompare(String(b.prenda)))) {
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

  // CSV del registro (respeta los filtros de centro y trabajador).
  const exportCsv = () => downloadCsv(`entregas-${hoy()}.csv`,
    ["Operario", "Centro", "Artículo", "Tipo", "Cantidad", "Talla", "Color", "Fecha"],
    filtradas.map((r) => [
      String(r.usuario_nombre ?? ""), String(r.centro_nombre ?? ""), String(r.prenda ?? ""),
      tipoLabel(r.articulo_tipo), String(r.cantidad ?? 1),
      r.talla == null ? "" : String(r.talla), r.color == null ? "" : String(r.color), String(r.fecha ?? ""),
    ]));

  // Resguardo imprimible de las entregas de un operario (para su firma).
  const imprimirResguardo = (g: { id: string; rows: Row[] }) => {
    const esc = (v: unknown) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const primero = g.rows[0];
    const filas = g.rows.map((r) =>
      `<tr><td>${esc(r.prenda)}</td><td>${tipoLabel(r.articulo_tipo)}</td><td class="r">${formatNum(r.cantidad ?? 1)}</td><td>${r.talla == null ? "—" : esc(r.talla)}</td><td>${r.color == null ? "—" : esc(r.color)}</td><td>${esc(String(r.fecha ?? "").slice(0, 10).split("-").reverse().join("/"))}</td></tr>`
    ).join("");
    const win = window.open("", "_blank");
    if (!win) { setError("Permite las ventanas emergentes para imprimir el resguardo"); return; }
    win.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8" /><title>Resguardo · ${esc(primero.usuario_nombre)}</title>
      <style>body{font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a;padding:28px;margin:0}h1{font-size:17px;margin:0 0 4px}.meta{color:#475569;font-size:13px;margin-bottom:18px}table{width:100%;border-collapse:collapse;font-size:13px}th,td{border:1px solid #cbd5e1;padding:7px 9px;text-align:left}th{background:#f1f5f9}.r{text-align:right}.firma{display:flex;justify-content:space-between;gap:40px;margin-top:56px;font-size:13px}.firma div{flex:1;border-top:1px solid #334155;padding-top:6px}.pie{margin-top:26px;font-size:11px;color:#94a3b8}@media print{body{padding:0}}</style></head><body>
      <h1>Resguardo de equipación</h1>
      <div class="meta"><strong>Operario:</strong> ${esc(primero.usuario_nombre)} · <strong>Centro:</strong> ${esc(primero.centro_nombre ?? "—")} · <strong>Fecha:</strong> ${esc(hoy().split("-").reverse().join("/"))}</div>
      <table><thead><tr><th>Artículo</th><th>Tipo</th><th class="r">Cant.</th><th>Talla</th><th>Color</th><th>Fecha entrega</th></tr></thead><tbody>${filas}</tbody></table>
      <div class="firma"><div>Firma del recibido</div><div>VoBo administración</div></div>
      <div class="pie">Documento generado por Inventarios · ${esc(hoy().split("-").reverse().join("/"))}</div>
      </body></html>`);
    win.document.close();
    win.focus();
    win.print();
  };

  const selCls = "input";

  return <>
    {canWrite && <div className="card card-pad">
      <div className="section-head"><h3>Nueva entrega de equipación</h3>
        <span className="badge muted">Artículo · cantidad · descuenta stock</span></div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Elige el centro y el trabajador; añade los artículos de ropa o EPIs del inventario con su cantidad. El stock se descuenta automáticamente.</p>
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
      <div className="form-grid" style={{ marginBottom: 14 }}>
        <div className="field" style={{ gridColumn: "span 2" }}><label htmlFor="en-art">Artículo del inventario</label>
          <select id="en-art" className={selCls} value={selArt} onChange={(e) => setSelArt(e.target.value)}>
            <option value="">— Elige ropa o EPIs —</option>
            {articulosDisp.map((a) => <option key={artKey(a)} value={artKey(a)} disabled={disponible(a) < 1}>
              {tipoLabel(a.tipo)} · {etiqueta(a)} (stock {a.stock})
            </option>)}
          </select></div>
        <div className="field" style={{ maxWidth: 130 }}><label htmlFor="en-cant">Cantidad</label>
          <input id="en-cant" className={selCls} type="number" min={1} step={1} value={cant} onChange={(e) => setCant(e.target.value)} /></div>
        <div className="field" style={{ alignSelf: "end" }}>
          <button className="btn secondary" onClick={anadirLinea} disabled={!selArt}>＋ Añadir línea</button></div>
      </div>
      {!lineas.length
        ? <p style={{ color: "var(--muted)" }}>Todavía no has añadido artículos a esta entrega.</p>
        : <div className="table-scroll" style={{ marginBottom: 12 }}>
            <table className="entrega-table">
              <thead><tr><th>Artículo</th><th>Tipo</th><th className="right">Cantidad</th><th className="right">Stock restante</th><th className="right">Quitar</th></tr></thead>
              <tbody>{lineas.map((l) => {
                const art = catalogo.find((a) => artKey(a) === artKey(l));
                return <tr key={artKey(l)}>
                  <td><strong>{art ? etiqueta(art) : `#${l.id}`}</strong></td>
                  <td><span className={`badge ${l.tipo === "epis" ? "info" : "warn"}`}>{tipoLabel(l.tipo)}</span></td>
                  <td className="right">{formatNum(l.cantidad)}</td>
                  <td className="right">{art ? formatNum(disponible(art, artKey(l)) - l.cantidad) : "—"}</td>
                  <td className="right"><button className="btn danger small" onClick={() => setLineas((prev) => prev.filter((x) => artKey(x) !== artKey(l)))}>✕ Quitar</button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>}
      <div className="modal-footer">
        {lineas.length > 0 && <button className="btn secondary" onClick={() => setLineas([])}>Limpiar líneas</button>}
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
          <div className="spacer" />
          <button className="btn secondary small" onClick={exportCsv} disabled={!filtradas.length}>⬇️ CSV</button>
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
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="btn secondary small" onClick={() => imprimirResguardo(g)}>🖨️ Resguardo</button>
                <span className="muted" style={{ fontSize: 12.5 }}>{g.rows.length} entrega{g.rows.length === 1 ? "s" : ""}</span>
              </div>
            </div>
            <div className="table-scroll">
              <table className="entrega-table">
                <thead><tr>
                  <th>Artículo</th><th>Tipo</th><th className="right">Cant.</th><th>Talla</th><th>Color</th><th>Fecha</th>
                  {canWrite && <th className="right">Acciones</th>}
                </tr></thead>
                <tbody>{g.rows.map((r) => <tr key={String(r.id)}>
                  <td>{String(r.prenda)}</td>
                  <td><span className={`badge ${r.articulo_tipo === "epis" ? "info" : "warn"}`}>{tipoLabel(r.articulo_tipo)}</span></td>
                  <td className="right">{formatNum(r.cantidad ?? 1)}</td>
                  <td>{r.talla == null ? "—" : String(r.talla)}</td>
                  <td>{r.color == null ? "—" : String(r.color)}</td>
                  <td>{String(r.fecha ?? "—").slice(0, 10).split("-").reverse().join("/")}</td>
                  {canWrite && <td className="right"><div className="row-actions">
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
