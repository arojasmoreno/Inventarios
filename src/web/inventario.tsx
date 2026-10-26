import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "./api";
import { Field, Modal, Toast, camposConError, diasHasta, downloadCsv, formatFecha, formatNum, type FieldDef } from "./ui";

type Row = Record<string, unknown>;

// Inventario de productos químicos por PRODUCTO y LOTES.
//
// Cada registro de la base de datos es un lote; aquí se agrupan por producto
// (nombre + marca) para ver el stock sumado y, desplegando la fila, los lotes
// que están en uso. Desde esta pantalla se dan de alta las entradas de
// producto, se registran salidas que consumen los lotes que antes caducan
// (FEFO) y se rellena la hoja de recuento que ajusta y retira lotes.

const ORIGEN_OPTS = [{ value: "fabrica", label: "Fábrica" }, { value: "empresa", label: "Empresa" }];

const ETIQ_ENTRADA: Array<{ clave: string; etiqueta: string }> = [
  { clave: "nombre", etiqueta: "Producto" }, { clave: "marca", etiqueta: "Marca" },
  { clave: "codigo", etiqueta: "Código" }, { clave: "numero_lote", etiqueta: "Nº de lote" },
  { clave: "litros_por_garrafa", etiqueta: "Litros por garrafa (L)" }, { clave: "num_garrafas", etiqueta: "Nº de garrafas" },
  { clave: "fecha_entrada", etiqueta: "Fecha de entrada" }, { clave: "fecha_produccion", etiqueta: "Fecha de producción" },
  { clave: "fecha_caducidad", etiqueta: "Fecha de caducidad" }, { clave: "precio", etiqueta: "Precio por garrafa (€)" },
  { clave: "origen", etiqueta: "Origen" }, { clave: "centro_id", etiqueta: "Centro" }, { clave: "notas", etiqueta: "Notas" },
];

const num = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0; };
const redondea = (n: number): number => Math.round(n * 10000) / 10000;
const esDecimal = (v: number): boolean => Math.abs(v - Math.round(v)) > 1e-6;
const fmt = (v: unknown, dec?: number): string => { const n = num(v); return formatNum(n, dec ?? (esDecimal(n) ? 2 : 0)); };
const hoyISO = (): string => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
// Identidad de producto: el mismo nombre y marca son el mismo producto aunque
// cada garrafa llegue con su lote y sus fechas.
const claveDe = (r: Row): string => `${norm(r.nombre)}|${norm(r.marca)}`;
const litrosDe = (r: Row): number => num(r.litros_por_garrafa) * num(r.num_garrafas);
const enUso = (r: Row): boolean => num(r.num_garrafas) > 0;
const fechaEntrada = (r: Row): string => (typeof r.fecha_entrada === "string" && r.fecha_entrada ? r.fecha_entrada : String(r.created_at ?? "").slice(0, 10));
// Consumo FEFO: primero caduca el lote que antes venía, después manda la fecha
// de entrada y, en último término, el orden de alta.
const fefo = (a: Row, b: Row): number => {
  const cad = (r: Row) => (typeof r.fecha_caducidad === "string" && r.fecha_caducidad ? r.fecha_caducidad : "9999-99-99");
  const ent = (r: Row) => fechaEntrada(r) || "9999-99-99";
  return cad(a).localeCompare(cad(b)) || ent(a).localeCompare(ent(b)) || num(a.id) - num(b.id);
};
const porProducto = (a: Row, b: Row): number =>
  String(a.nombre ?? "").localeCompare(String(b.nombre ?? ""), "es") ||
  String(a.marca ?? "").localeCompare(String(b.marca ?? ""), "es") || fefo(a, b);

/** Reparto de una salida entre los lotes de un producto, en orden FEFO. */
function simularSalida(lotes: Row[], cantidad: number, unidad: "litros" | "garrafas") {
  const red = redondea;
  const detalle: Array<{ id: number; numero_lote: string; tomado: number; restantes: number; retirado: boolean }> = [];
  let pendiente = cantidad;
  for (const l of [...lotes].sort(fefo)) {
    if (pendiente <= 1e-9) break;
    const garrafas = num(l.num_garrafas);
    if (garrafas <= 0) continue;
    if (unidad === "litros") {
      const lpg = num(l.litros_por_garrafa);
      if (lpg <= 0) continue;
      const disponibles = garrafas * lpg;
      const toma = Math.min(disponibles, pendiente);
      pendiente -= toma;
      detalle.push({ id: num(l.id), numero_lote: String(l.numero_lote ?? "—"), tomado: red(toma), restantes: red((disponibles - toma) / lpg), retirado: false });
    } else {
      const toma = Math.min(garrafas, pendiente);
      pendiente -= toma;
      detalle.push({ id: num(l.id), numero_lote: String(l.numero_lote ?? "—"), tomado: red(toma), restantes: red(garrafas - toma), retirado: false });
    }
  }
  for (const d of detalle) d.retirado = d.restantes <= 0.0001;
  return { detalle, pendiente: red(pendiente) };
}

interface Grupo {
  clave: string; nombre: string; marca: string; lotes: Row[];
  garrafas: number; litros: number; uso: number; caducidad: string | null;
}
function agrupar(lotes: Row[]): Grupo[] {
  const map = new Map<string, Grupo>();
  for (const l of lotes) {
    const clave = claveDe(l);
    let g = map.get(clave);
    if (!g) { g = { clave, nombre: String(l.nombre ?? "—"), marca: String(l.marca ?? ""), lotes: [], garrafas: 0, litros: 0, uso: 0, caducidad: null }; map.set(clave, g); }
    g.lotes.push(l);
    if (enUso(l)) { g.garrafas += num(l.num_garrafas); g.litros += litrosDe(l); g.uso++; }
  }
  for (const g of map.values()) {
    const caducidades = g.lotes.filter(enUso).map((l) => String(l.fecha_caducidad ?? "")).filter(Boolean).sort();
    g.caducidad = caducidades[0] ?? null;
    g.lotes.sort(fefo);
  }
  return [...map.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, "es") || a.marca.localeCompare(b.marca, "es"));
}

const estadoDe = (r: Row): string => {
  if (enUso(r)) return String(r.estado ?? "") === "descartado" ? "descartado" : "activo";
  return String(r.estado ?? "") === "descartado" ? "descartado" : "agotado";
};
function Estado({ estado }: { estado: string }) {
  return estado === "activo" ? <span className="badge ok">En uso</span>
    : estado === "descartado" ? <span className="badge danger">Descartado</span>
    : <span className="badge muted">Agotado</span>;
}
function Caducidad({ fecha, soloTexto = false }: { fecha: unknown; soloTexto?: boolean }) {
  if (typeof fecha !== "string" || !fecha) return <>{soloTexto ? "—" : <span className="badge muted">Sin fecha</span>}</>;
  const n = diasHasta(fecha);
  const texto = n !== null && n < 0 ? `Vencida (${formatFecha(fecha)})` : n !== null && n <= 90 ? `${formatFecha(fecha)} · ${n} d` : formatFecha(fecha);
  const cls = n === null ? "" : n < 0 ? "danger" : n <= 30 ? "warn" : n <= 90 ? "info" : "";
  return cls ? <span className={`badge ${cls}`}>{texto}</span> : <>{texto}</>;
}

/** Selector de producto (agrupado) reutilizado por los tres formularios. */
function SelectorProducto({ grupos, valor, onChange, etiqueta = "Producto", soloConStock = false }: {
  grupos: Grupo[]; valor: string; onChange: (clave: string) => void; etiqueta?: string; soloConStock?: boolean;
}) {
  const opciones = soloConStock ? grupos.filter((g) => g.uso > 0) : grupos;
  const id = "sel-producto";
  return <div className="field">
    <label htmlFor={id}>{etiqueta}<span className="req">*</span></label>
    <select id={id} className="input" value={valor} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Producto nuevo —</option>
      {opciones.map((g) => <option key={g.clave} value={g.clave}>
        {g.nombre}{g.marca ? ` · ${g.marca}` : ""} ({g.uso} lote{g.uso === 1 ? "" : "s"})
      </option>)}
    </select>
    {soloConStock && <small>Elige el producto que vas a retirar del almacén.</small>}
  </div>;
}

/** Entrada de producto: alta de un lote nuevo o suma de garrafas a uno existente. */
function EntradaModal({ grupos, centros, onClose, onSaved }: {
  grupos: Grupo[]; centros: Row[]; onClose: () => void; onSaved: (mensaje: string) => void;
}) {
  const vacio: Row = {
    nombre: "", marca: "", codigo: "", numero_lote: "", litros_por_garrafa: "", num_garrafas: "1",
    fecha_entrada: hoyISO(), fecha_produccion: "", fecha_caducidad: "", precio: "", origen: "fabrica",
    centro_id: null, notas: "",
  };
  const [claveProd, setClaveProd] = useState("");
  const [loteId, setLoteId] = useState("");
  const [vals, setVals] = useState<Row>(vacio);
  const [formError, setFormError] = useState<string | null>(null);
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const grupo = grupos.find((g) => g.clave === claveProd) ?? null;
  const lote = grupo?.lotes.find((l) => String(l.id) === loteId) ?? null;
  const esAcumulo = Boolean(lote);

  const set = (name: string, v: unknown): void => {
    setCampoErr((prev) => prev.filter((k) => k !== name));
    setVals((prev) => ({ ...prev, [name]: v }));
  };
  const elegirProducto = (clave: string): void => {
    setClaveProd(clave); setLoteId(""); setCampoErr([]);
    const g = grupos.find((x) => x.clave === clave);
    if (!g) { setVals({ ...vacio }); return; }
    const base = g.lotes.find(enUso) ?? g.lotes[0];
    setVals({
      ...vacio,
      nombre: g.nombre, marca: g.marca,
      litros_por_garrafa: base ? String(num(base.litros_por_garrafa)) : "",
      origen: String(base?.origen ?? "fabrica"),
      centro_id: (base?.centro_id ?? null) as number | null,
      fecha_entrada: hoyISO(),
    });
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const obligatorios = ["nombre", "num_garrafas", ...(esAcumulo ? [] : ["numero_lote", "litros_por_garrafa"])];
    const vacios = obligatorios.filter((k) => vals[k] === "" || vals[k] == null);
    if (vacios.length || num(vals.num_garrafas) < 1) {
      setCampoErr([...vacios, ...(num(vals.num_garrafas) < 1 ? ["num_garrafas"] : [])]);
      setFormError(vacios.length ? "Revisa los campos marcados en rojo" : "Las garrafas recibidas deben ser 1 o más");
      return;
    }
    setBusy(true); setFormError(null); setCampoErr([]);
    try {
      const r = await api.post<{ mensaje?: string }>("/api/inventario/entrada", { ...vals, quimico_id: lote ? num(lote.id) : null });
      onSaved(r.mensaje ?? "Entrada registrada");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo registrar la entrada";
      setFormError(msg); setCampoErr(camposConError(msg, ETIQ_ENTRADA));
    } finally { setBusy(false); }
  };

  const campos: FieldDef[] = [
    { name: "codigo", label: "Código", type: "text", help: "Opcional: déjalo en blanco para los lotes siguientes." },
    { name: "numero_lote", label: "Nº de lote", type: "text", required: !esAcumulo, help: esAcumulo ? undefined : "Cada garrafa nueva puede traer un lote distinto." },
    { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: !esAcumulo },
    { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true, help: "Garrafas que llegan en esta entrada." },
    { name: "fecha_entrada", label: "Fecha de entrada", type: "date", required: !esAcumulo },
    { name: "fecha_produccion", label: "Fecha de producción", type: "date" },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", help: "Deja el campo en blanco si el producto no caduca." },
    { name: "precio", label: "Precio por garrafa (€)", type: "number" },
    { name: "origen", label: "Origen", type: "select", required: true, options: ORIGEN_OPTS },
    { name: "centro_id", label: "Centro", type: "select", options: centros.map((c) => ({ value: Number(c.id), label: String(c.nombre) })) },
    { name: "notas", label: "Notas", type: "textarea" },
  ];
  // Al sumar garrafas a un lote existente solo cambian la cantidad y las notas:
  // el resto de datos (lote, fechas, origen…) son los del lote y no se tocan.
  const visibles = esAcumulo ? campos.filter((f) => f.name === "num_garrafas" || f.name === "notas") : campos;

  return <Modal title="Entrada de producto químico" subtitle="Alta de un lote nuevo o reposición de un lote existente" onClose={onClose}>
    <form onSubmit={submit}>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">
        <div><SelectorProducto grupos={grupos} valor={claveProd} onChange={elegirProducto} /></div>
        <div><div className={"field" + (campoErr.includes("lote") ? " error" : "")}>
          <label htmlFor="en-lote">Lote</label>
          <select id="en-lote" className="input" value={loteId} onChange={(e) => { setLoteId(e.target.value); setCampoErr([]); }}>
            <option value="">— Lote nuevo —</option>
            {(grupo?.lotes ?? []).map((l) => <option key={String(l.id)} value={String(l.id)}>
              {String(l.numero_lote)} · {fmt(l.num_garrafas)} g · {fmt(litrosDe(l))} L{l.fecha_caducidad ? ` · caduca ${formatFecha(l.fecha_caducidad)}` : ""}
            </option>)}
          </select>
          <small>{grupo ? "Elige un lote para sumarle garrafas o déjalo en «Lote nuevo»." : "Primero elige el producto."}</small>
        </div></div>
        {esAcumulo && <div className="full"><div className="banner">Se sumarán las garrafas al lote <strong>{String(lote?.numero_lote ?? "")}</strong> de «{String(lote?.nombre ?? "")}» y sus fechas se mantienen.</div></div>}
        {!esAcumulo && <>
          <div><Field def={{ name: "nombre", label: "Producto", type: "text", required: true }} value={vals.nombre} onChange={(v) => set("nombre", v)} error={campoErr.includes("nombre")} /></div>
          <div><Field def={{ name: "marca", label: "Marca", type: "text" }} value={vals.marca} onChange={(v) => set("marca", v)} error={campoErr.includes("marca")} /></div>
        </>}
        {visibles.map((f) => <div key={f.name} className={f.type === "textarea" ? "full" : ""}>
          <Field def={f} value={vals[f.name]} onChange={(v) => set(f.name, v)} error={campoErr.includes(f.name)} />
        </div>)}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn secondary" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={busy}>{busy ? "Registrando…" : esAcumulo ? "Sumar garrafas" : "Registrar entrada"}</button>
      </div>
    </form>
  </Modal>;
}

/** Salida de producto: descuento repartido entre sus lotes por caducidad (FEFO). */
function SalidaModal({ grupos, onClose, onSaved }: { grupos: Grupo[]; onClose: () => void; onSaved: (mensaje: string) => void }) {
  const [claveProd, setClaveProd] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [unidad, setUnidad] = useState<"litros" | "garrafas">("litros");
  const [motivo, setMotivo] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const grupo = grupos.find((g) => g.clave === claveProd) ?? null;
  const lotes = (grupo?.lotes ?? []).filter(enUso);
  const n = Number(String(cantidad).replace(",", "."));
  const valido = Boolean(grupo) && Number.isFinite(n) && n > 0;
  const calc = valido ? simularSalida(lotes, n, unidad) : null;
  const stock = lotes.reduce((s, l) => s + (unidad === "litros" ? litrosDe(l) : num(l.num_garrafas)), 0);
  const insuficiente = Boolean(calc && (calc.pendiente > 0 || !calc.detalle.length));

  const submit = async (): Promise<void> => {
    if (!grupo || !calc || insuficiente) return;
    setBusy(true); setFormError(null);
    try {
      const body: Row = { ids: calc.detalle.map((d) => d.id), motivo: motivo || null };
      body[unidad] = n;
      const r = await api.post<{ mensaje?: string }>("/api/inventario/salida", body);
      onSaved(r.mensaje ?? "Salida registrada");
    } catch (err) { setFormError(err instanceof Error ? err.message : "No se pudo registrar la salida"); }
    finally { setBusy(false); }
  };

  return <Modal title="Salida de producto químico" subtitle="El descuento se reparte por caducidad de lote (FEFO) y retira los lotes vacíos" onClose={onClose}>
    <div>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">
        <div><SelectorProducto grupos={grupos} valor={claveProd} onChange={(v) => { setClaveProd(v); setFormError(null); }} etiqueta="Producto" soloConStock /></div>
        <div className="field">
          <label htmlFor="sa-unidad">Unidad</label>
          <div className="chips">
            {(["litros", "garrafas"] as const).map((u) => <button type="button" key={u} className={"chip" + (unidad === u ? " on" : "")} onClick={() => setUnidad(u)}>
              {u === "litros" ? "Litros" : "Garrafas"}
            </button>)}
          </div>
          <small>{grupo ? `Disponibles: ${fmt(stock, 2)} ${unidad === "litros" ? "litros" : "garrafas"} en ${lotes.length} lote${lotes.length === 1 ? "" : "s"}.` : "Elige el producto a retirar."}</small>
        </div>
        <div><div className="field">
          <label htmlFor="sa-cant">Cantidad<span className="req">*</span></label>
          <input id="sa-cant" className="input" type="number" min={0} step="any" placeholder={unidad === "litros" ? "Ej. 25,5" : "Ej. 3"} value={cantidad} onChange={(e) => { setCantidad(e.target.value); setFormError(null); }} />
        </div></div>
        <div className="full"><div className="field">
          <label htmlFor="sa-motivo">Motivo (opcional)</label>
          <input id="sa-motivo" className="input" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ej. Consumo de sala, merma, traslado…" />
        </div></div>
      </div>
      {insuficiente && <div className="form-error">Stock insuficiente: solo hay {fmt(stock, 2)} {unidad === "litros" ? "litros" : "garrafas"} de «{String(grupo?.nombre ?? "")}».</div>}
      {calc && calc.detalle.length > 0 && <div className="table-scroll" style={{ marginTop: 6 }}>
        <table>
          <thead><tr><th>Lote</th><th className="right">Se descuenta</th><th className="right">Queda</th><th>Estado</th></tr></thead>
          <tbody>{calc.detalle.map((d) => <tr key={d.id}>
            <td>{d.numero_lote}</td>
            <td className="right">−{fmt(d.tomado, 2)} {unidad === "litros" ? "L" : "g"}</td>
            <td className="right">{fmt(d.restantes, 2)} {unidad === "litros" ? "L" : "g"}</td>
            <td>{d.retirado ? <span className="badge muted">Se retira</span> : <span className="badge ok">Sigue en uso</span>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      <div className="modal-footer">
        <button className="btn secondary" onClick={onClose}>Cancelar</button>
        <button className="btn" onClick={() => void submit()} disabled={busy || !valido || insuficiente}>{busy ? "Registrando…" : "Registrar salida"}</button>
      </div>
    </div>
  </Modal>;
}

/** Hoja de recuento: los litros reales de cada producto y lote ajustan el stock. */
function RecuentoModal({ lotes, centroLabel, anteriores, onClose, onSaved }: {
  lotes: Row[]; centroLabel: string; anteriores: Row[]; onClose: () => void; onSaved: (mensaje: string) => void;
}) {
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const l of lotes) {
      const enLitros = num(l.litros_por_garrafa) > 0;
      init[String(l.id)] = String(enLitros ? redondea(litrosDe(l)) : redondea(num(l.num_garrafas)));
    }
    return init;
  });
  const [notas, setNotas] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const filas = lotes.map((l) => {
    const enLitros = num(l.litros_por_garrafa) > 0;
    const sistema = enLitros ? litrosDe(l) : num(l.num_garrafas);
    const bruto = Number(String(vals[String(l.id)] ?? "").replace(",", "."));
    const real = Number.isFinite(bruto) && bruto >= 0 ? bruto : NaN;
    return { lote: l, unidad: (enLitros ? "litros" : "garrafas") as "litros" | "garrafas", sistema, real, dif: Number.isFinite(real) ? real - sistema : NaN };
  });
  const ajustes = filas.filter((f) => Number.isFinite(f.dif) && Math.abs(f.dif) > 0.001).length;
  const retirar = filas.filter((f) => Number.isFinite(f.real) && f.real <= 0.0001 && f.sistema > 0).length;
  const diferenciaL = filas.filter((f) => f.unidad === "litros" && Number.isFinite(f.dif)).reduce((s, f) => s + f.dif, 0);
  const valido = filas.every((f) => Number.isFinite(f.real));

  const submit = async (): Promise<void> => {
    if (!valido) { setFormError("Revisa los valores del recuento: todos deben ser números iguales o mayores que 0"); return; }
    if (!window.confirm(`Validar el recuento de ${filas.length} lotes? Se ajustará el stock${ajustes ? ` (${ajustes} cambios${retirar ? ` y ${retirar} lotes retirados` : ""})` : ""}.`)) return;
    setBusy(true); setFormError(null);
    try {
      const r = await api.post<{ mensaje?: string }>("/api/inventario/recuento", {
        lineas: filas.map((f) => ({ quimico_id: num(f.lote.id), unidad: f.unidad, valor: f.real })),
        notas: notas || null,
      });
      onSaved(r.mensaje ?? "Recuento guardado");
    } catch (err) { setFormError(err instanceof Error ? err.message : "No se pudo guardar el recuento"); }
    finally { setBusy(false); }
  };

  return <Modal title="Recuento de inventario" subtitle={`Hoja con los lotes en uso de ${centroLabel}: anota los litros reales de cada uno`} onClose={onClose}>
    <div>
      {formError && <div className="form-error">{formError}</div>}
      <p style={{ color: "var(--muted)", marginTop: 0, fontSize: 13 }}>
        La columna «Sistema» es lo que dice el inventario; cambia solo la columna «Real». Los lotes que dejes a cero se retiran
        (quedan como descartados) y el resto se ajusta a lo contado.
      </p>
      <div className="table-scroll">
        <table>
          <thead><tr><th>Producto</th><th>Lote</th><th className="right">Sistema</th><th className="right">Real</th><th className="right">Diferencia</th></tr></thead>
          <tbody>{filas.map((f) => {
            const clave = String(f.lote.id);
            const conError = !Number.isFinite(f.real);
            const cambia = Number.isFinite(f.dif) && Math.abs(f.dif) > 0.001;
            return <tr key={clave}>
              <td>{String(f.lote.nombre)}{f.lote.marca ? <span className="muted"> · {String(f.lote.marca)}</span> : null}</td>
              <td>{String(f.lote.numero_lote ?? "—")}</td>
              <td className="right">{fmt(f.sistema, 2)} {f.unidad === "litros" ? "L" : "g"}</td>
              <td className="right">
                <input className={"input" + (conError ? " error" : "")} style={{ maxWidth: 110, textAlign: "right" }}
                  type="number" min={0} step="any" aria-label={`Real ${String(f.lote.nombre)} lote ${String(f.lote.numero_lote)}`}
                  value={vals[clave] ?? ""} onChange={(e) => setVals((prev) => ({ ...prev, [clave]: e.target.value }))} />
              </td>
              <td className="right">{Number.isFinite(f.dif)
                ? <span className={cambia ? "badge " + (f.dif < 0 ? "danger" : "warn") : "badge muted"}>{f.dif > 0 ? "+" : ""}{fmt(f.dif, 2)}</span>
                : <span className="badge danger">?</span>}</td>
            </tr>;
          })}</tbody>
          <tfoot><tr>
            <td colSpan={2}><strong>{filas.length} lotes · {ajustes} ajustes{retirar ? ` · ${retirar} a retirar` : ""}</strong></td>
            <td className="right">{fmt(filas.filter((f) => f.unidad === "litros").reduce((s, f) => s + f.sistema, 0), 2)} L</td>
            <td />
            <td className="right">{diferenciaL > 0 ? "+" : ""}{fmt(diferenciaL, 2)} L</td>
          </tr></tfoot>
        </table>
      </div>
      <div className="field full" style={{ marginTop: 12 }}>
        <label htmlFor="rc-notas">Observaciones del recuento</label>
        <input id="rc-notas" className="input" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej. Recuento mensual, pendiente revisar lote caducado…" />
      </div>
      {anteriores.length > 0 && <div style={{ marginTop: 14 }}>
        <h3 style={{ fontSize: 14 }}>Recuentos anteriores</h3>
        <div className="table-scroll"><table>
          <thead><tr><th>Fecha</th><th>Usuario</th><th className="right">Lotes</th><th className="right">Diferencia</th></tr></thead>
          <tbody>{anteriores.slice(0, 5).map((r) => <tr key={String(r.id)}>
            <td>{formatFecha(r.fecha)}</td>
            <td>{String(r.usuario_nombre ?? "—")}</td>
            <td className="right">{fmt(r.lineas)}</td>
            <td className="right">{r.diferencia == null ? "—" : `${fmt(r.diferencia, 2)} L`}</td>
          </tr>)}</tbody>
        </table></div>
      </div>}
      <div className="modal-footer">
        <button className="btn secondary" onClick={onClose}>Cancelar</button>
        <button className="btn" onClick={() => void submit()} disabled={busy || !valido || !filas.length}>{busy ? "Guardando…" : "Validar recuento"}</button>
      </div>
    </div>
  </Modal>;
}

/** Inventario de químicos agrupado por producto con sus lotes, entradas,
 *  salidas FEFO y hoja de recuento imprimible. */
export function InventarioQuimicosPage({ user }: { user: { rol: string } }) {
  const esAdmin = user.rol === "admin";
  const [items, setItems] = useState<Row[]>([]);
  const [centros, setCentros] = useState<Row[]>([]);
  const [anteriores, setAnteriores] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [centroId, setCentroId] = useState("all");
  const [mostrarRetirados, setMostrarRetirados] = useState(false);
  const [abiertos, setAbiertos] = useState<Set<string>>(() => new Set());
  const [modal, setModal] = useState<null | "entrada" | "salida" | "recuento">(null);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  const load = useCallback(async () => {
    try {
      const [l, c, r] = await Promise.all([
        api.get<{ items: Row[] }>("/api/quimicos"),
        api.get<{ items: Row[] }>("/api/centros"),
        api.get<{ items: Row[] }>("/api/inventario/recuentos").catch(() => ({ items: [] as Row[] })),
      ]);
      setItems(l.items); setCentros(c.items); setAnteriores(r.items);
      setError(null);
    } catch { setError("No se pudo cargar el inventario"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const gruposTodos = useMemo(() => agrupar(items), [items]);
  const filtrados = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((l) => (centroId === "all" || String(l.centro_id ?? "") === centroId)
      && (mostrarRetirados || enUso(l))
      && (!needle || [l.nombre, l.marca, l.numero_lote, l.codigo].some((k) => String(k ?? "").toLowerCase().includes(needle))));
  }, [items, q, centroId, mostrarRetirados]);
  const grupos = useMemo(() => agrupar(filtrados), [filtrados]);
  // Lotes en uso del centro elegido: es la base de la hoja imprimible y del recuento.
  const paraHoja = useMemo(() => items.filter((l) => enUso(l) && (centroId === "all" || String(l.centro_id ?? "") === centroId)).sort(porProducto), [items, centroId]);
  const totales = useMemo(() => grupos.reduce((t, g) => ({ productos: t.productos + 1, garrafas: t.garrafas + g.garrafas, litros: t.litros + g.litros }), { productos: 0, garrafas: 0, litros: 0 }), [grupos]);
  const centroLabel: string = centroId === "all" ? "todos los centros"
    : String(centros.find((c) => String(c.id) === centroId)?.nombre ?? "") || "todos los centros";

  const toggle = (clave: string): void => setAbiertos((prev) => {
    const next = new Set(prev); if (next.has(clave)) next.delete(clave); else next.add(clave); return next;
  });
  const guardado = (mensaje: string): void => { setModal(null); setToast({ message: mensaje, kind: "ok" }); void load(); };
  const exportCsv = (): void => {
    downloadCsv(`inventario-quimicos-${hoyISO()}.csv`,
      ["Producto", "Marca", "Lote", "Estado", "Centro", "L/garrafa", "Garrafas", "Total litros", "Entrada", "Producción", "Caducidad", "Origen", "Precio (€)"],
      filtrados.slice().sort(porProducto).map((l) => [
        String(l.nombre ?? ""), String(l.marca ?? ""), String(l.numero_lote ?? ""),
        estadoDe(l) === "activo" ? "En uso" : estadoDe(l) === "descartado" ? "Descartado" : "Agotado",
        String(l.centro_nombre ?? ""), fmt(num(l.litros_por_garrafa), 2), fmt(num(l.num_garrafas), 2), fmt(litrosDe(l), 2),
        formatFecha(l.fecha_entrada), formatFecha(l.fecha_produccion), formatFecha(l.fecha_caducidad),
        String(l.origen ?? "") === "empresa" ? "Empresa" : "Fábrica",
        l.precio == null || l.precio === "" ? "" : fmt(num(l.precio), 2),
      ]));
  };

  return <>
    <div className="toolbar no-print">
      <input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar producto o lote…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" style={{ maxWidth: 220 }} value={centroId} onChange={(e) => setCentroId(e.target.value)} aria-label="Filtrar por centro">
        <option value="all">Todos los centros</option>
        {centros.map((c) => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <label className="field checkbox" style={{ marginBottom: 0 }} title="Muestra también los lotes agotados o descartados">
        <input type="checkbox" checked={mostrarRetirados} onChange={(e) => setMostrarRetirados(e.target.checked)} />
        <span>Ver lotes retirados</span>
      </label>
      <div className="spacer" />
      {user.rol !== "usuario" && <button className="btn secondary" onClick={exportCsv} disabled={!filtrados.length}>⬇️ CSV</button>}
      <button className="btn secondary" onClick={() => window.print()} disabled={!paraHoja.length}>🖨️ Hoja de recuento</button>
      {esAdmin && <button className="btn secondary" onClick={() => setModal("salida")}>↗ Salida</button>}
      {esAdmin && <button className="btn" onClick={() => setModal("entrada")}>＋ Entrada de producto</button>}
      {esAdmin && <button className="btn" onClick={() => setModal("recuento")} disabled={!paraHoja.length}>📋 Recuento</button>}
    </div>

    {error && <div className="form-error no-print">{error}</div>}

    <div className="card no-print">
      <div className="section-head" style={{ padding: "14px 16px 0" }}>
        <h3>Inventario por producto</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Pulsa una fila para ver sus lotes en uso · consumo por caducidad (FEFO)</span>
      </div>
      {loading ? <div className="loading">Cargando…</div> : error ? <div className="empty">⚠️ {error}</div> : !grupos.length
        ? <div className="empty"><span className="icon">📭</span><strong>No hay productos en el inventario</strong>
            <p>{q || centroId !== "all" ? "Prueba con otra búsqueda u otro filtro." : esAdmin ? "Registra la primera entrada con el botón «Entrada de producto»." : "Todavía no hay stock registrado."}</p></div>
        : <div className="table-scroll"><table>
          <thead><tr>
            <th>Producto</th><th>Marca</th><th className="right">Lotes en uso</th><th className="right">Garrafas</th>
            <th className="right">Total litros</th><th>Próxima caducidad</th><th />
          </tr></thead>
          <tbody>{grupos.map((g) => <Fragment key={g.clave}>
            <tr className="clickable" onClick={() => toggle(g.clave)}>
              <td><strong>{g.nombre}</strong></td>
              <td>{g.marca || "—"}</td>
              <td className="right">{fmt(g.uso)}</td>
              <td className="right">{fmt(g.garrafas, 2)}</td>
              <td className="right"><strong>{fmt(g.litros, 2)}</strong> L</td>
              <td><Caducidad fecha={g.caducidad} soloTexto /></td>
              <td className="right">{abiertos.has(g.clave) ? "▲" : "▼"}</td>
            </tr>
            {abiertos.has(g.clave) && <tr>
              <td colSpan={7} style={{ background: "#f8fafc", padding: "0 8px 10px" }}>
                <table>
                  <thead><tr><th>Lote</th><th>Estado</th><th className="right">Garrafas</th><th className="right">Litros</th><th>Entrada</th><th>Caducidad</th><th>Centro</th></tr></thead>
                  <tbody>{g.lotes.map((l) => <tr key={String(l.id)} style={{ opacity: enUso(l) ? 1 : 0.55 }}>
                    <td>{String(l.numero_lote ?? "—")}</td>
                    <td><Estado estado={estadoDe(l)} /></td>
                    <td className="right">{fmt(l.num_garrafas, 2)}</td>
                    <td className="right">{fmt(litrosDe(l), 2)}</td>
                    <td>{formatFecha(l.fecha_entrada)}</td>
                    <td><Caducidad fecha={l.fecha_caducidad} /></td>
                    <td>{String(l.centro_nombre ?? "—")}</td>
                  </tr>)}</tbody>
                </table>
              </td>
            </tr>}
          </Fragment>)}</tbody>
          <tfoot><tr>
            <td colSpan={2}><strong>Totales · {fmt(totales.productos)} productos</strong></td>
            <td className="right">{fmt(grupos.reduce((s, g) => s + g.uso, 0))}</td>
            <td className="right">{fmt(totales.garrafas, 2)}</td>
            <td className="right">{fmt(totales.litros, 2)} L</td>
            <td colSpan={2} />
          </tr></tfoot>
        </table></div>}
    </div>

    {anteriores.length > 0 && <div className="card no-print">
      <div className="section-head" style={{ padding: "14px 16px 0" }}><h3>Últimos recuentos</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Histórico de hojas de inventario validadas</span></div>
      <div className="table-scroll"><table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Observaciones</th><th className="right">Lotes</th><th className="right">Diferencia</th></tr></thead>
        <tbody>{anteriores.map((r) => <tr key={String(r.id)}>
          <td>{formatFecha(r.fecha)}</td>
          <td>{String(r.usuario_nombre ?? "—")}</td>
          <td>{String(r.notas ?? "—")}</td>
          <td className="right">{fmt(r.lineas)}</td>
          <td className="right">{r.diferencia == null ? "—" : `${fmt(r.diferencia, 2)} L`}</td>
        </tr>)}</tbody>
      </table></div>
    </div>}

    {/* Hoja imprimible: la misma lista con una columna en blanco para anotar los
        litros reales. Se imprime con «Hoja de recuento» (o Ctrl+P). */}
    <div className="print-only">
      <div className="print-head">
        <h1>Hoja de recuento · Productos químicos</h1>
        <p>{formatFecha(hoyISO())} · {centroLabel} · Anota en «Litros reales» lo que encuentres en almacén</p>
      </div>
      <table>
        <thead><tr>
          <th>Producto</th><th>Marca</th><th>Lote</th><th>Centro</th><th>L/garrafa</th>
          <th>Garrafas</th><th>Litros sistema</th><th>Litros reales</th><th>Observaciones</th>
        </tr></thead>
        <tbody>{paraHoja.map((l) => <tr key={String(l.id)}>
          <td>{String(l.nombre ?? "")}</td>
          <td>{String(l.marca ?? "—")}</td>
          <td>{String(l.numero_lote ?? "—")}</td>
          <td>{String(l.centro_nombre ?? "—")}</td>
          <td>{fmt(l.litros_por_garrafa, 2)}</td>
          <td>{fmt(l.num_garrafas, 2)}</td>
          <td>{fmt(litrosDe(l), 2)}</td>
          <td style={{ minWidth: 90 }}>&nbsp;</td>
          <td style={{ minWidth: 120 }}>&nbsp;</td>
        </tr>)}</tbody>
        <tfoot><tr>
          <td colSpan={6}><strong>Total en sistema</strong></td>
          <td><strong>{fmt(paraHoja.reduce((s, l) => s + litrosDe(l), 0), 2)} L</strong></td>
          <td colSpan={2} />
        </tr></tfoot>
      </table>
      <div className="print-foot">Firma del responsable del recuento: ______________________ · Rellena también la hoja en la aplicación (Consumibles → Inventario → Recuento) para actualizar el stock.</div>
    </div>

    {modal === "entrada" && <EntradaModal grupos={gruposTodos} centros={centros} onClose={() => setModal(null)} onSaved={guardado} />}
    {modal === "salida" && <SalidaModal grupos={gruposTodos} onClose={() => setModal(null)} onSaved={guardado} />}
    {modal === "recuento" && <RecuentoModal lotes={paraHoja} centroLabel={centroLabel} anteriores={anteriores} onClose={() => setModal(null)} onSaved={guardado} />}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
