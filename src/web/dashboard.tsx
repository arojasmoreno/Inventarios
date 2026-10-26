import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { ColorSwatch, Toast, downloadCsv, formatFecha, formatNum } from "./ui";

type Row = Record<string, unknown>;

/** Respuesta de GET /api/informes con los datos agregados del dashboard. */
interface DashboardData {
  generado: string;
  centro: { id: number; nombre: string } | null;
  centros: { id: number; nombre: string }[];
  resumen: {
    quimicos: { registros: number; garrafas: number; litros: number };
    material: { registros: number; unidades: number };
    maquinaria: { registros: number; unidades: number };
    epis: { registros: number; unidades: number };
    ropa: { registros: number; unidades: number };
  };
  stock_bajo: { quimicos: number; material: number; epis: number; ropa: number; total: number };
  caducidad: { vencidas: number; en30: number; en90: number };
  quimicos: Row[]; material: Row[]; maquinaria: Row[]; epis: Row[]; ropas: Row[];
  por_color: { color: string; unidades: number; registros: number }[];
  por_tipo: { tipo: string; unidades: number; registros: number }[];
  consumos_por_zona: { centro: string; zona: string; movimientos: number; unidades: number; ultimo: string | null }[];
  consumos_por_subzona: { zona: string; subzona: string; movimientos: number; unidades: number; ultimo: string | null }[];
  entregas_por_operario: { operario_id: number; operario: string; username: string; entregas: number; unidades: number; ultima: string | null }[];
  por_centro: Row[];
  por_origen: Row[];
  consumo_por_dia: { fecha: string; unidades: number; movimientos: number }[];
  actividad: { accion: string; registros: number }[];
  globales: Row;
}

const ORIGEN_LABEL: Record<string, string> = { fabrica: "🏭 Fábrica", empresa: "🏢 Empresa" };
const ORIGEN_COLOR: Record<string, string> = { fabrica: "#2563eb", empresa: "#d97706" };
const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const COLORES_SERIE = ["#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#64748b"];

const suma = (rows: Row[], key: string): number => rows.reduce((acc, r) => acc + Number(r[key] ?? 0), 0);
const origenDe = (r: Row): string => (String(r.origen ?? "") === "empresa" ? "empresa" : "fabrica");
const etiquetaOrigen = (v: unknown): string => ORIGEN_LABEL[String(v ?? "")] ?? "—";

/** Gráfico de dona (SVG puro, sin librerías): repartos en % y valores. */
function Donut({ partes, centro }: { partes: { label: string; value: number; color: string }[]; centro?: string }) {
  const total = partes.reduce((a, p) => a + Number(p.value || 0), 0);
  let acc = 0;
  return <div className="donut-wrap">
    <svg viewBox="0 0 42 42" className="donut" role="img" aria-label={partes.map(p => `${p.label}: ${formatNum(p.value)}`).join(" · ")}>
      <g transform="rotate(-90 21 21)">
        <circle cx="21" cy="21" r="15.9155" fill="none" stroke="#eef2f7" strokeWidth="7" />
        {total > 0 && partes.filter(p => Number(p.value) > 0).map(p => {
          const pct = (Number(p.value) / total) * 100;
          const off = -acc;
          acc += pct;
          return <circle key={p.label} cx="21" cy="21" r="15.9155" fill="none" stroke={p.color} strokeWidth="7"
            strokeDasharray={`${pct} ${Math.max(0, 100 - pct)}`} strokeDashoffset={off} />;
        })}
      </g>
      <text x="21" y="20" textAnchor="middle" dominantBaseline="middle" fontSize="7.5" fontWeight="700" fill="currentColor">{formatNum(total)}</text>
      <text x="21" y="26.5" textAnchor="middle" dominantBaseline="middle" fontSize="3.2" fill="#64748b">{centro ?? "total"}</text>
    </svg>
    <ul className="donut-legend">
      {partes.map(p => <li key={p.label}>
        <span className="dot" style={{ background: p.color }} />
        <span className="donut-label">{p.label}</span>
        <strong>{formatNum(p.value)}</strong>
        <small>{total > 0 ? `${Math.round((Number(p.value) / total) * 100)} %` : "—"}</small>
      </li>)}
    </ul>
  </div>;
}

/** Gráfico de barras verticales (serie de días / meses). */
function Barras({ items, color = "#16a34a", unidad = "ud." }: { items: { label: string; value: number; title?: string }[]; color?: string; unidad?: string }) {
  const max = Math.max(1, ...items.map(i => Number(i.value)));
  if (!items.length) return <p className="muted" style={{ margin: 0 }}>Sin datos todavía.</p>;
  return <div className="chart">{items.map(it => (
    <div className="chart-col" key={it.label} title={it.title ?? `${it.label}: ${formatNum(it.value)} ${unidad}`}>
      <div className="chart-bars">
        <div className="bar" style={{ height: `${Math.max(3, Math.round((Number(it.value) / max) * 100))}%`, background: color }} />
      </div>
      <span className="chart-label">{it.label}</span>
    </div>))}</div>;
}

/** Barras horizontales (comparativas de una misma magnitud). */
function HBarras({ items, alt = false, sufijo = "" }: { items: { label: string; sub?: string; value: number }[]; alt?: boolean; sufijo?: string }) {
  const max = Math.max(1, ...items.map(i => Number(i.value)));
  if (!items.length) return <p className="muted" style={{ margin: 0 }}>Sin datos todavía.</p>;
  return <div className="hbars">{items.map(it => (
    <div className="hbar" key={it.label} title={`${it.label}: ${formatNum(it.value)} ${sufijo}`}>
      <span className="hbar-label">{it.label}{it.sub ? <><br /><small style={{ color: "var(--muted)", fontWeight: 400 }}>{it.sub}</small></> : null}</span>
      <span className="hbar-track"><span className={"hbar-fill" + (alt ? " alt" : "")} style={{ width: `${Math.max(3, Math.round((Number(it.value) / max) * 100))}%` }} /></span>
      <span className="hbar-value">{formatNum(it.value)}{sufijo ? <small> {sufijo}</small> : null}</span>
    </div>))}</div>;
}

/** Dashboard de Gestión de informes: la fotografía completa del inventario —
 *  KPIs, gráficos y tablas — con filtros por planta y por origen. */
export function Dashboard({ user }: { user: { rol: string } }) {
  // Los usuarios ven el dashboard pero no pueden descargarlo (CSV ni PDF).
  const puedeDescargar = user.rol !== "usuario";
  const [centroId, setCentroId] = useState("all");
  const [origenId, setOrigenId] = useState("all");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Envío del dashboard por correo: solo cuando un administrador lo pide.
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const esAdmin = user.rol === "admin";

  const enviarPorCorreo = async () => {
    setEnviando(true);
    try {
      const r = await api.post<{ ok: boolean; enviado: boolean; enviados?: number; destinatarios?: number; message?: string }>("/api/alertas/enviar", {});
      setAviso({
        message: r.enviado
          ? `Dashboard enviado a ${Number(r.enviados ?? 0)} de ${Number(r.destinatarios ?? 0)} administradores`
          : r.message ?? "Sin alertas: no hay nada que enviar.",
        kind: "ok",
      });
    } catch (e) {
      setAviso({ message: e instanceof Error ? e.message : "No se pudo enviar el dashboard", kind: "error" });
    } finally {
      setEnviando(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setData(await api.get<DashboardData>(`/api/informes?centro_id=${encodeURIComponent(centroId)}`)); }
    catch (e) { setError(e instanceof Error ? e.message : "No se pudo cargar el dashboard"); }
    finally { setLoading(false); }
  }, [centroId]);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <div className="loading">Generando dashboard…</div>;
  if (error || !data) return <div className="card empty"><span className="icon">⚠️</span>{error ?? "No hay datos"}</div>;

  // ---- Filtros: planta (server) y origen (cliente sobre los consumibles) ----
  const enOrigen = (row: Row) => origenId === "all" || origenDe(row) === origenId;
  const quimicos = data.quimicos.filter(enOrigen), material = data.material.filter(enOrigen);
  const alcance = data.centro ? data.centro.nombre : "todos los centros";
  const alcanceTexto = origenId === "all" ? alcance : `${alcance} · ${ORIGEN_LABEL[origenId]}`;

  const rQ = { registros: quimicos.length, garrafas: suma(quimicos, "num_garrafas"), litros: Number(suma(quimicos, "total_litros").toFixed(2)) };
  const rM = { registros: material.length, unidades: suma(material, "cantidad") };
  const estado = (q: Row) => String(q.estado_caducidad ?? "ok");
  const caducidad = {
    vencidas: quimicos.filter(q => estado(q) === "vencida").length,
    en30: quimicos.filter(q => estado(q) === "30").length,
    en90: quimicos.filter(q => estado(q) === "90").length,
  };

  // Listas de alertas (stock bajo mínimo y caducidades) calculadas con el filtro.
  const bajoDe = (rows: Row[], key: string, categoria: string, nombre: (r: Row) => string): Row[] =>
    rows.filter(r => Number(r.stock_minimo ?? 0) > 0 && Number(r[key] ?? 0) <= Number(r.stock_minimo))
      .map(r => ({ categoria, nombre: nombre(r), codigo: r.codigo ?? "", stock: Number(r[key] ?? 0), minimo: Number(r.stock_minimo ?? 0) }));
  // En los químicos el stock mínimo está en litros y pertenece al PRODUCTO: se
  // compara con la suma de los litros de sus lotes (la ficha manda sobre los
  // lotes dados de alta con un mínimo anterior).
  const bajoDeQuimicos = (rows: Row[]): Row[] => {
    const grupos = new Map<string, { nombre: string; codigo: unknown; litros: number; ficha: number | null; max: number }>();
    for (const r of rows) {
      const clave = `${String(r.nombre ?? "").trim().toLowerCase()}|${String(r.marca ?? "").trim().toLowerCase()}`;
      const g = grupos.get(clave) ?? { nombre: String(r.nombre ?? ""), codigo: r.codigo ?? "", litros: 0, ficha: null, max: 0 };
      g.litros += Number(r.litros_por_garrafa ?? 0) * Number(r.num_garrafas ?? 0);
      const min = Number(r.stock_minimo ?? 0);
      if (String(r.numero_lote ?? "").trim() === "") { g.ficha = min; if (r.codigo != null) g.codigo = r.codigo; }
      else g.max = Math.max(g.max, min);
      grupos.set(clave, g);
    }
    return [...grupos.values()].flatMap((g) => {
      const minimo = g.ficha ?? g.max;
      return minimo > 0 && g.litros <= minimo
        ? [{ categoria: "Químicos", nombre: g.nombre, codigo: g.codigo, stock: g.litros, minimo }]
        : [];
    });
  };
  const stockBajo: Row[] = [
    ...bajoDeQuimicos(quimicos),
    ...bajoDe(material, "cantidad", "Material", r => String(r.nombre ?? "")),
    ...bajoDe(data.epis, "stock", "EPIs", r => String(r.descripcion ?? r.codigo ?? "")),
    ...bajoDe(data.ropas, "stock", "Ropa", r => String(r.prenda ?? "")),
  ];
  const proximas = quimicos.filter(q => estado(q) !== "ok")
    .sort((a, b) => String(a.fecha_caducidad).localeCompare(String(b.fecha_caducidad)));

  // Desgloses.
  const porColorMap = new Map<string, { color: string; unidades: number; registros: number }>();
  for (const m of material) { const c = String(m.color); const e = porColorMap.get(c) ?? { color: c, unidades: 0, registros: 0 }; e.unidades += Number(m.cantidad ?? 0); e.registros++; porColorMap.set(c, e); }
  const porColor = [...porColorMap.values()].sort((a, b) => b.unidades - a.unidades);
  const porSituacion = new Map<string, number>();
  for (const m of data.maquinaria) { const e = String(m.estado ?? "Sin estado"); porSituacion.set(e, (porSituacion.get(e) ?? 0) + 1); }

  const porOrigen = data.por_origen.filter(r => origenId === "all" || String(r.origen) === origenId);
  const partesOrigen = porOrigen.map((r, i) => ({
    label: etiquetaOrigen(r.origen), value: Number(r.quimicos_registros ?? 0) + Number(r.material_registros ?? 0),
    color: ORIGEN_COLOR[String(r.origen)] ?? COLORES_SERIE[i % COLORES_SERIE.length],
  }));
  const partesCaducidad = [
    { label: "Vencida", value: caducidad.vencidas, color: "#dc2626" },
    { label: "≤ 30 días", value: caducidad.en30, color: "#d97706" },
    { label: "≤ 90 días", value: caducidad.en90, color: "#2563eb" },
    { label: "En vigor", value: quimicos.length - caducidad.vencidas - caducidad.en30 - caducidad.en90, color: "#16a34a" },
  ];
  const partesSituacion = [...porSituacion.entries()].map(([estado_, n], i) => ({
    label: estado_, value: n, color: estado_ === "Operativo" ? "#16a34a" : estado_ === "Averiado" ? "#dc2626" : estado_ === "En reparación" ? "#d97706" : estado_ === "Baja" ? "#64748b" : COLORES_SERIE[i % COLORES_SERIE.length],
  }));

  // Consumo diario (30 días) y caducidades de los próximos 12 meses.
  const consumo30 = suma(data.consumo_por_dia as unknown as Row[], "unidades");
  const movimientos30 = suma(data.consumo_por_dia as unknown as Row[], "movimientos");
  const hoy = new Date();
  const conteoMes = new Map<string, number>();
  for (const q of quimicos) { const k = String(q.fecha_caducidad ?? "").slice(0, 7); if (/^\d{4}-\d{2}/.test(k)) conteoMes.set(k, (conteoMes.get(k) ?? 0) + 1); }
  const porMes: { label: string; value: number }[] = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    porMes.push({ label: `${MESES[d.getMonth()]}${d.getMonth() === 0 ? ` ${String(d.getFullYear()).slice(2)}` : ""}`, value: conteoMes.get(k) ?? 0 });
  }

  // Comparativa por planta (global: sirve para contrastar plantas entre sí).
  const centrosRows: Row[] = data.por_centro.map(r => ({
    ...r,
    litros: Number(r.quimicos_litros ?? 0),
    unidades: Number(r.material_unidades ?? 0) + Number(r.epis_unidades ?? 0) + Number(r.ropa_unidades ?? 0),
  }));
  const alertas = stockBajo.length + caducidad.vencidas + Number(data.globales?.maquinas_paradas ?? 0);
  const stamp = new Date().toISOString().slice(0, 10);

  // Valor del inventario: precio unitario (opcional) × cantidad de cada
  // artículo. Los productos sin precio no suman al total.
  const valorDe = (rows: Row[], cantidadKey: string): number => rows.reduce((acc, a) =>
    acc + (a.precio == null || a.precio === "" ? 0 : Number(a.precio) * Number(a[cantidadKey] ?? 0)), 0);
  const valorInventario = valorDe(quimicos, "num_garrafas") + valorDe(material, "cantidad")
    + valorDe(data.epis, "stock") + valorDe(data.ropas, "stock");
  const conPrecio = [quimicos, material, data.epis, data.ropas]
    .reduce((n, rows) => n + rows.filter(a => a.precio != null && a.precio !== "").length, 0);
  const totalArticulos = quimicos.length + material.length + data.epis.length + data.ropas.length;

  const csvPlantas = () => downloadCsv(`dashboard-plantas-${stamp}.csv`,
    ["Planta", "Químicos (prod.)", "Garrafas", "Litros", "Material (ref.)", "Material (uds.)", "Maquinaria", "EPIs (uds.)", "Ropa (uds.)", "Estaciones activas", "Stock bajo", "Caducadas", "Consumo 30 d (uds.)"],
    centrosRows.map(r => [String(r.nombre), formatNum(r.quimicos_registros), formatNum(r.quimicos_garrafas), formatNum(r.litros, 2),
      formatNum(r.material_registros), formatNum(r.material_unidades), formatNum(r.maquinaria_unidades), formatNum(r.epis_unidades),
      formatNum(r.ropa_unidades), formatNum(r.estaciones_activas), formatNum(r.consumo_30d), formatNum(r.stock_bajo), formatNum(r.caducadas)]));
  const csvOrigen = () => downloadCsv(`dashboard-origen-${stamp}.csv`,
    ["Origen", "Químicos (prod.)", "Garrafas", "Litros", "Material (ref.)", "Material (uds.)"],
    porOrigen.map(r => [String(r.origen) === "empresa" ? "Empresa" : "Fabrica", formatNum(r.quimicos_registros),
      formatNum(r.quimicos_garrafas), formatNum(r.quimicos_litros, 2), formatNum(r.material_registros), formatNum(r.material_unidades)]));

  return <>
    <div className="toolbar no-print">
      <label htmlFor="dash-centro" style={{ fontWeight: 600 }}>Planta:</label>
      <select id="dash-centro" className="input" style={{ maxWidth: 240 }} value={centroId} onChange={e => setCentroId(e.target.value)}>
        <option value="all">Todas las plantas</option>
        {data.centros.map(c => <option key={c.id} value={String(c.id)}>{c.nombre}</option>)}
      </select>
      <label htmlFor="dash-origen" style={{ fontWeight: 600 }}>Origen:</label>
      <select id="dash-origen" className="input" style={{ maxWidth: 190 }} value={origenId} onChange={e => setOrigenId(e.target.value)}>
        <option value="all">Todo el origen</option>
        <option value="fabrica">🏭 Fábrica</option>
        <option value="empresa">🏢 Empresa</option>
      </select>
      <div className="spacer" />
      {puedeDescargar && <button className="btn secondary" onClick={() => window.print()}>🖨️ Imprimir / PDF</button>}
    </div>

    <div className="card card-pad">
      <div className="section-head" style={{ marginBottom: 6 }}>
        <div><h2 style={{ fontSize: 19, marginBottom: 2 }}>📊 Dashboard de gestión</h2>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13 }}>
            Alcance: <strong>{alcanceTexto}</strong> · Generado el {formatFecha(data.generado.slice(0, 10))} a las {data.generado.slice(11, 16)} h
          </p></div>
        {/* Esquina superior derecha del dashboard: el envío es solo bajo petición. */}
        {esAdmin && <button className="btn secondary no-print" onClick={() => void enviarPorCorreo()} disabled={enviando}
          title="Envía este dashboard y las alertas por correo a los administradores">
          {enviando ? "Enviando…" : "📧 Enviar por correo"}
        </button>}
      </div>
      <div className="chips" style={{ marginBottom: 0 }}>
        <span className="badge">👥 {formatNum(data.globales?.usuarios ?? 0)} usuarios activos</span>
        <span className="badge">🏙️ {formatNum(data.globales?.centros ?? 0)} plantas</span>
        <span className="badge">🧭 {formatNum(data.globales?.zonas ?? 0)} zonas</span>
        <span className="badge">🚻 {formatNum(data.globales?.estaciones_activas ?? 0)} / {formatNum(data.globales?.estaciones ?? 0)} estaciones activas</span>
        <span className="badge">📚 {formatNum(data.globales?.documentos ?? 0)} documentos</span>
        <span className="badge">🦺 {formatNum(data.globales?.entregas ?? 0)} entregas de equipación</span>
        <span className={Number(data.globales?.maquinas_paradas ?? 0) > 0 ? "badge danger" : "badge ok"}>
          🧭 {formatNum(data.globales?.maquinas_paradas ?? 0)} máquinas paradas
        </span>
      </div>
    </div>

    {caducidad.vencidas > 0 && <div className="banner danger">⚠️ {caducidad.vencidas} producto{caducidad.vencidas > 1 ? "s" : ""} químico{caducidad.vencidas > 1 ? "s" : ""} con la caducidad vencida en {alcanceTexto}. Retíralo{caducidad.vencidas > 1 ? "s" : ""} del almacén.</div>}
    {caducidad.en30 > 0 && <div className="banner warn">⏳ {caducidad.en30} lote{caducidad.en30 > 1 ? "s" : ""} caduca{caducidad.en30 > 1 ? "n" : ""} en menos de 30 días.</div>}

    <div className="kpis">
      <div className="kpi"><div className="label">Químicos</div><div className="value">{formatNum(rQ.litros, 2)} L</div>
        <div className="kpi-sub">{formatNum(rQ.garrafas)} garrafas · {formatNum(rQ.registros)} productos</div></div>
      <div className="kpi"><div className="label">Material de limpieza</div><div className="value">{formatNum(rM.unidades)} uds.</div>
        <div className="kpi-sub">{formatNum(rM.registros)} referencias · {formatNum(porColor.length)} colores</div></div>
      <div className="kpi"><div className="label">Maquinaria</div><div className="value">{formatNum(data.resumen.maquinaria.unidades)} uds.</div>
        <div className="kpi-sub">{formatNum(data.resumen.maquinaria.registros)} máquinas · {formatNum(porSituacion.get("Operativo") ?? 0)} operativas</div></div>
      <div className="kpi"><div className="label">EPIs · Ropa</div><div className="value">{formatNum(data.resumen.epis.unidades + data.resumen.ropa.unidades)} uds.</div>
        <div className="kpi-sub">{formatNum(data.resumen.epis.registros)} EPIs · {formatNum(data.resumen.ropa.registros)} prendas</div></div>
      <div className="kpi"><div className="label">Consumo 30 días</div><div className="value">{formatNum(consumo30)} uds.</div>
        <div className="kpi-sub">{formatNum(movimientos30)} movimientos de estaciones</div></div>
      <div className="kpi"><div className="label">Valor del inventario</div><div className="value">{formatNum(valorInventario, 2)} €</div>
        <div className="kpi-sub">{formatNum(conPrecio)} de {formatNum(totalArticulos)} artículos con precio</div></div>
      <div className={"kpi" + (alertas > 0 ? " alert" : "")}><div className="label">Alertas</div><div className="value">{formatNum(alertas)}</div>
        <div className="kpi-sub">stock {formatNum(stockBajo.length)} · caducidad {formatNum(caducidad.vencidas)} · máquinas {formatNum(data.globales?.maquinas_paradas ?? 0)}</div></div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>🏭 Origen de los consumibles</h3>
          {puedeDescargar && <button className="btn secondary small no-print" onClick={csvOrigen} disabled={!porOrigen.length}>⬇️ CSV</button>}</div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Químicos y material de limpieza, por ficha, en {alcanceTexto}.</p>
        <Donut partes={partesOrigen.length ? partesOrigen : [{ label: "Sin datos", value: 0, color: "#cbd5e1" }]} centro="artículos" />
        <div className="table-scroll" style={{ marginTop: 10 }}>
          <table><thead><tr><th>Origen</th><th className="right\">Químicos</th><th className="right\">Garrafas</th><th className="right\">Litros</th><th className="right\">Material ref.</th><th className="right\">Material uds.</th></tr></thead>
            <tbody>{porOrigen.map(r => <tr key={String(r.origen)}>
              <td><span className={"badge " + (String(r.origen) === "empresa" ? "warn" : "info")}>{etiquetaOrigen(r.origen)}</span></td>
              <td className="right">{formatNum(r.quimicos_registros)}</td>
              <td className="right">{formatNum(r.quimicos_garrafas)}</td>
              <td className="right">{formatNum(r.quimicos_litros, 2)}</td>
              <td className="right">{formatNum(r.material_registros)}</td>
              <td className="right">{formatNum(r.material_unidades)}</td>
            </tr>)}</tbody></table>
        </div>
      </div>

      <div className="card card-pad">
        <div className="section-head"><h3>🧪 Estado de caducidad de los químicos</h3></div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Distribución de {formatNum(quimicos.length)} productos por su fecha de caducidad.</p>
        <Donut partes={partesCaducidad} centro="lotes" />
        <div className="chips" style={{ margin: "10px 0 0" }}>
          <span className="badge danger">Vencidas: {formatNum(caducidad.vencidas)}</span>
          <span className="badge warn">≤ 30 días: {formatNum(caducidad.en30)}</span>
          <span className="badge info">≤ 90 días: {formatNum(caducidad.en90)}</span>
          <span className="badge ok">En vigor: {formatNum(quimicos.length - caducidad.vencidas - caducidad.en30 - caducidad.en90)}</span>
        </div>
      </div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>📈 Consumo por día (30 días)</h3>
          <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Total {formatNum(consumo30)} uds.</span></div>
        <Barras items={data.consumo_por_dia.map(d => ({
          label: String(d.fecha).slice(8, 10) + "/" + String(d.fecha).slice(5, 7),
          value: Number(d.unidades), title: `${formatFecha(d.fecha)}: ${formatNum(d.unidades)} uds. en ${formatNum(d.movimientos)} movimientos`,
        }))} />
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>Los días sin barra no tuvieron consumo registrado.</p>
      </div>

      <div className="card card-pad">
        <div className="section-head"><h3>📅 Caducidades por mes (próximos 12 meses)</h3>
          <span style={{ color: "var(--muted)", fontSize: 12.5 }}>{formatNum(porMes.reduce((a, m) => a + m.value, 0))} lotes</span></div>
        <Barras items={porMes} color="#d97706" unidad="lotes" />
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>Planifica la rotación y los pedidos antes de cada mes marcado.</p>
      </div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>🏙️ Inventario por planta</h3>
          {puedeDescargar && <button className="btn secondary small no-print" onClick={csvPlantas} disabled={!centrosRows.length}>⬇️ CSV</button>}</div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Comparativa global entre plantas (sin aplicar el filtro de cabecera).</p>
        <div className="section-head" style={{ marginBottom: 4 }}><h3 style={{ fontSize: 13 }}>🧪 Litros de químicos</h3></div>
        <HBarras items={centrosRows.map(c => ({ label: String(c.nombre), value: Number(c.litros) }))} sufijo="L" />
        <div className="section-head" style={{ margin: "14px 0 4px" }}><h3 style={{ fontSize: 13 }}>🧽 Unidades de material</h3></div>
        <HBarras items={centrosRows.map(c => ({ label: String(c.nombre), value: Number(c.unidades) }))} alt sufijo="uds." />
      </div>

      <div className="card card-pad">
        <div className="section-head"><h3>🧭 Maquinaria por situación</h3></div>
        <Donut partes={partesSituacion.length ? partesSituacion : [{ label: "Sin maquinaria", value: 0, color: "#cbd5e1" }]} centro="máquinas" />
        <div className="section-head" style={{ margin: "14px 0 4px" }}><h3 style={{ fontSize: 13 }}>🏷️ Unidades por tipo</h3></div>
        <HBarras alt items={data.por_tipo.map(t => ({ label: t.tipo, value: Number(t.unidades) }))} sufijo="uds." />
      </div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>🧽 Material de limpieza por color</h3></div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Código de color de uso (segregación de material).</p>
        <div className="chips">{porColor.map(c => <span key={c.color} className="badge"><ColorSwatch color={c.color} />{c.color}: {formatNum(c.unidades)} uds.</span>)}
          {!porColor.length && <span className="muted">Sin material en este filtro.</span>}</div>
        <HBarras items={porColor.map(c => ({ label: c.color, value: Number(c.unidades) }))} sufijo="uds." />
      </div>

      <div className="card card-pad">
        <div className="section-head"><h3>📍 Consumos por zona</h3></div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Unidades consumidas en las estaciones de {alcance}.</p>
        <HBarras items={data.consumos_por_zona.slice(0, 12).map(z => ({ label: String(z.zona), sub: String(z.centro), value: Number(z.unidades) }))} sufijo="uds." />
      </div>
    </div>

    <div className="dash-grid">
      <div className="card card-pad">
        <div className="section-head"><h3>🦺 Entregas de equipación por operario</h3></div>
        {data.entregas_por_operario.length
          ? <HBarras items={data.entregas_por_operario.slice(0, 12).map(e => ({ label: String(e.operario), sub: String(e.username), value: Number(e.unidades) }))} sufijo="uds." />
          : <p className="muted" style={{ margin: 0 }}>Sin entregas registradas en {alcance}.</p>}
      </div>

      <div className="card card-pad">
        <div className="section-head"><h3>🗂️ Actividad de los últimos 30 días</h3></div>
        <p style={{ color: "var(--muted)", fontSize: 12.5, marginTop: 0 }}>Movimientos registrados en toda la aplicación (alcance global).</p>
        {data.actividad.length ? <div className="chips" style={{ marginBottom: 0 }}>
          {data.actividad.map(a => <span key={a.accion} className="badge">
            {a.accion === "consumo" ? "🚰" : a.accion === "entrada" ? "📥" : a.accion === "salida" ? "📤" : a.accion === "alta" ? "➕" : a.accion === "edicion" ? "✏️" : a.accion === "borrado" ? "🗑️" : "🔄"}
            {" "}{a.accion.replaceAll("_", " ")}: {formatNum(a.registros)}</span>)}
        </div> : <p className="muted" style={{ margin: 0 }}>Sin movimientos en los últimos 30 días.</p>}
        {data.consumos_por_subzona.length > 0 && <>
          <div className="section-head" style={{ margin: "16px 0 4px" }}><h3 style={{ fontSize: 13 }}>🧱 Subzonas más consumidoras</h3></div>
          <div className="chips" style={{ marginBottom: 0 }}>
            {data.consumos_por_subzona.slice(0, 10).map((s, i) => <span key={`${String(s.zona)}-${String(s.subzona)}-${i}`} className="badge">
              🧱 {String(s.zona)} › {String(s.subzona)}: {formatNum(s.unidades)}</span>)}
          </div>
        </>}
      </div>
    </div>

    <div className="card">
      <div className="card-pad section-head"><h3>🏙️ Resumen por planta</h3>
        {puedeDescargar && <button className="btn secondary small no-print" onClick={csvPlantas} disabled={!centrosRows.length}>⬇️ CSV</button>}</div>
      {!centrosRows.length ? <div className="empty">Sin plantas dadas de alta.</div> : <div className="table-scroll"><table>
        <thead><tr><th>Planta</th><th className="right\">Químicos</th><th className="right\">Garrafas</th><th className="right\">Litros</th>
          <th className="right\">Material</th><th className="right\">Maquinaria</th><th className="right\">EPIs</th><th className="right\">Ropa</th>
          <th className="right\">Estaciones</th><th className="right\">Consumo 30 d</th><th className="right\">Stock bajo</th><th className="right">Caducadas</th></tr></thead>
        <tbody>{centrosRows.map(r => <tr key={String(r.id)}>
          <td><strong>{String(r.nombre)}</strong></td>
          <td className="right">{formatNum(r.quimicos_registros)}</td>
          <td className="right">{formatNum(r.quimicos_garrafas)}</td>
          <td className="right">{formatNum(r.litros, 2)}</td>
          <td className="right">{formatNum(r.material_unidades)}</td>
          <td className="right">{formatNum(r.maquinaria_unidades)}</td>
          <td className="right">{formatNum(r.epis_unidades)}</td>
          <td className="right">{formatNum(r.ropa_unidades)}</td>
          <td className="right">{formatNum(r.estaciones_activas)}</td>
          <td className="right">{formatNum(r.consumo_30d)}</td>
          <td className="right">{Number(r.stock_bajo) > 0 ? <span className="badge danger">{formatNum(r.stock_bajo)}</span> : "—"}</td>
          <td className="right">{Number(r.caducadas) > 0 ? <span className="badge danger">{formatNum(r.caducadas)}</span> : "—"}</td>
        </tr>)}
        <tr><td><strong>Total</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "quimicos_registros"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "quimicos_garrafas"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "litros"), 2)}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "material_unidades"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "maquinaria_unidades"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "epis_unidades"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "ropa_unidades"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "estaciones_activas"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "consumo_30d"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "stock_bajo"))}</strong></td>
          <td className="right"><strong>{formatNum(suma(centrosRows, "caducadas"))}</strong></td>
        </tr></tbody></table></div>}
    </div>

    <div className="dash-grid">
      <div className="card">
        <div className="card-pad section-head"><h3>⏳ Caducidades próximas ({formatNum(proximas.length)})</h3></div>
        {!proximas.length ? <div className="empty" style={{ padding: 20 }}>Ningún lote vencido ni por vencer en 90 días. ✅</div>
          : <div className="table-scroll"><table>
            <thead><tr><th>Producto</th><th>Lote</th><th>Caducidad</th><th>Estado</th><th>Origen</th></tr></thead>
            <tbody>{proximas.slice(0, 12).map(q => { const e = estado(q); const cls = e === "vencida" ? "danger" : e === "30" ? "warn" : "info";
              const txt = e === "vencida" ? "Vencida" : e === "30" ? "≤ 30 días" : "≤ 90 días"; return <tr key={String(q.id)}>
                <td>{String(q.nombre ?? "")}</td><td>{String(q.numero_lote ?? "—")}</td>
                <td>{formatFecha(q.fecha_caducidad)}</td>
                <td><span className={"badge " + cls}>{txt}</span></td>
                <td><span className={"badge " + (origenDe(q) === "empresa" ? "warn" : "info")}>{etiquetaOrigen(origenDe(q))}</span></td>
              </tr>; })}</tbody></table></div>}
      </div>

      <div className="card">
        <div className="card-pad section-head"><h3>📉 Stock por debajo del mínimo ({formatNum(stockBajo.length)})</h3>
          <a className="btn secondary small" href="#/entradas">🔄 Entradas / Salidas</a></div>
        {!stockBajo.length ? <div className="empty" style={{ padding: 20 }}>Todo el material por encima del mínimo. 👍</div>
          : <div className="table-scroll"><table>
            <thead><tr><th>Categoría</th><th>Artículo</th><th className="right\">Stock</th><th className="right\">Mínimo</th></tr></thead>
            <tbody>{stockBajo.map((s, i) => <tr key={`${String(s.categoria)}-${String(s.nombre)}-${i}`}>
              <td><span className="badge warn">{String(s.categoria)}</span></td>
              <td>{String(s.nombre)}{s.codigo ? <span style={{ color: "var(--muted)" }}> · {String(s.codigo)}</span> : null}</td>
              <td className="right"><span className="badge danger">{formatNum(s.stock)}</span></td>
              <td className="right">{formatNum(s.minimo)}</td>
            </tr>)}</tbody></table></div>}
      </div>
    </div>

    <p className="no-print" style={{ color: "var(--muted)", margin: 0, fontSize: 12.5 }}>
      Fuentes: inventario por planta (global), consumibles filtrados por origen, consumos de estaciones (30 días) y entregas de equipación.
      Usa «Imprimir / PDF» para archivar el dashboard y «📧 Enviar por correo» cuando quieras compartarlo.
    </p>
    {aviso && <Toast message={aviso.message} kind={aviso.kind} onClose={() => setAviso(null)} />}
  </>;
}
