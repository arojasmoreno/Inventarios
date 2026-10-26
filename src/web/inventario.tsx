import { Fragment, useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "./api";
import { Field, Modal, Toast, camposConError, diasHasta, downloadCsv, formatFecha, formatNum, type FieldDef } from "./ui";

type Row = Record<string, unknown>;

// Inventario de productos químicos por PRODUCTO y LOTES.
//
// La ficha de un producto se da de alta en la pestaña «Químicos»; cada registro
// de esta pestaña es una ENTRADA de un lote de ese producto. Los lotes se
// agrupan por producto (nombre + marca) para ver el stock sumado y, desplegando
// la fila, los lotes que están en uso. Desde aquí también se registran salidas
// que consumen los lotes que antes caducan (FEFO) y se rellena la hoja de
// recuento que ajusta y retira lotes.

const ORIGEN_OPTS = [{ value: "fabrica", label: "Fábrica" }, { value: "empresa", label: "Empresa" }];

// Etiquetas de los campos del formulario de entrada, para localizarlos en rojo
// cuando el backend devuelve un error.
const ETIQ_ENTRADA: Array<{ clave: string; etiqueta: string }> = [
  { clave: "claveProd", etiqueta: "Producto químico" },
  { clave: "numero_lote", etiqueta: "Nº de lote" },
  { clave: "litros", etiqueta: "Litros de producto" },
  { clave: "fecha_entrada", etiqueta: "Fecha de entrada" },
  { clave: "fecha_produccion", etiqueta: "Fecha de fabricación" },
  { clave: "fecha_caducidad", etiqueta: "Fecha de caducidad" },
  { clave: "precio", etiqueta: "Precio por garrafa (€)" },
  { clave: "origen", etiqueta: "Origen" },
  { clave: "litros_por_garrafa", etiqueta: "Litros por garrafa (L)" },
  { clave: "notas", etiqueta: "Notas" },
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
// Fila de ficha de producto (alta desde «Químicos»): todavía no tiene lote.
const sinLote = (r: Row): boolean => String(r.numero_lote ?? "").trim() === "";
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

/** Etiqueta al lado de los litros totales de un producto, al estilo de las de
 *  caducidad: roja si el total baja del mínimo configurado en su ficha y ámbar
 *  si supera el máximo. Sin ficha (o sin umbral fijado) no se muestra nada. */
function AvisoStock({ litros, umbrales }: { litros: number; umbrales?: { min: number; max: number } }) {
  if (!umbrales) return null;
  if (umbrales.min > 0 && litros < umbrales.min) return <> <span className="badge danger">⚠️ mín. {fmt(umbrales.min, 2)} L</span></>;
  if (umbrales.max > 0 && litros > umbrales.max) return <> <span className="badge warn">⬆ máx. {fmt(umbrales.max, 2)} L</span></>;
  return null;
}

/** Selector de producto (agrupado) reutilizado por los formularios. */
function SelectorProducto({ grupos, valor, onChange, etiqueta = "Producto químico", soloConStock = false }: {
  grupos: Grupo[]; valor: string; onChange: (clave: string) => void; etiqueta?: string; soloConStock?: boolean;
}) {
  const opciones = soloConStock ? grupos.filter((g) => g.uso > 0) : grupos;
  const id = "sel-producto";
  return <div className="field">
    <label htmlFor={id}>{etiqueta}<span className="req">*</span></label>
    <select id={id} className="input" value={valor} onChange={(e) => onChange(e.target.value)}>
      <option value="">— Selecciona un producto —</option>
      {opciones.map((g) => <option key={g.clave} value={g.clave}>
        {g.nombre}{g.marca ? ` · ${g.marca}` : ""} ({g.uso} lote{g.uso === 1 ? "" : "s"})
      </option>)}
    </select>
    {soloConStock && <small>Elige el producto que vas a retirar del almacén.</small>}
  </div>;
}

/** Entrada de producto: alta de un lote nuevo de un producto ya dado de alta.
 *
 *  Campos obligatorios: producto químico, nº de lote, litros de producto, fecha
 *  de entrada y origen. Opcionales: fecha de fabricación, fecha de caducidad,
 *  precio y notas. Los datos del producto (código, marca, litros por garrafa,
 *  stock mínimo y centro) se copian de su ficha.
 */
function EntradaModal({ grupos, onClose, onSaved }: {
  grupos: Grupo[]; onClose: () => void; onSaved: (mensaje: string) => void;
}) {
  const vacio: Row = {
    claveProd: "", numero_lote: "", litros: "", fecha_entrada: hoyISO(),
    fecha_produccion: "", fecha_caducidad: "", precio: "", origen: "fabrica", notas: "",
  };
  const [vals, setVals] = useState<Row>(vacio);
  const [formError, setFormError] = useState<string | null>(null);
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const grupo = grupos.find((g) => g.clave === String(vals.claveProd ?? "")) ?? null;
  // Ficha del producto elegido: si todavía no tiene fila propia, se toma el
  // primer lote (los datos del producto están copiados en cada uno).
  const ficha = grupo ? (grupo.lotes.find(sinLote) ?? grupo.lotes[0]) : null;
  const litrosPorGarrafa = ficha ? num(ficha.litros_por_garrafa) : 0;

  const set = (name: string, v: unknown): void => {
    setCampoErr((prev) => prev.filter((k) => k !== name));
    setFormError(null);
    setVals((prev) => ({ ...prev, [name]: v }));
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    const obligatorios = ["claveProd", "numero_lote", "litros", "fecha_entrada", "origen"];
    const vacios = obligatorios.filter((k) => vals[k] === "" || vals[k] == null);
    if (vacios.length) {
      setCampoErr(vacios);
      setFormError("Revisa los campos marcados en rojo");
      return;
    }
    const litros = Number(String(vals.litros).replace(",", "."));
    if (!Number.isFinite(litros) || litros <= 0) {
      setCampoErr(["litros"]);
      setFormError("Los litros de producto deben ser mayores que 0");
      return;
    }
    if (!grupo || !ficha) {
      setCampoErr(["claveProd"]);
      setFormError("Elige el producto químico al que pertenece este lote");
      return;
    }
    if (litrosPorGarrafa <= 0) {
      setFormError(`«${grupo.nombre}» no tiene litros por garrafa: edítalo en la pestaña «Químicos».`);
      return;
    }
    const precio = vals.precio === "" || vals.precio == null ? null : Number(String(vals.precio).replace(",", "."));
    if (precio !== null && (!Number.isFinite(precio) || precio < 0)) {
      setCampoErr(["precio"]);
      setFormError("El precio debe ser un número igual o mayor que 0");
      return;
    }
    setBusy(true); setFormError(null); setCampoErr([]);
    try {
      const r = await api.post<{ mensaje?: string }>("/api/inventario/entrada", {
        // Datos de la ficha del producto (el backend los copia al lote).
        codigo: ficha.codigo ?? null,
        marca: ficha.marca ?? null,
        nombre: grupo.nombre,
        centro_id: ficha.centro_id ?? null,
        stock_minimo: ficha.stock_minimo ?? 0,
        litros_por_garrafa: litrosPorGarrafa,
        // Datos del lote que se registra.
        numero_lote: String(vals.numero_lote).trim(),
        litros,
        fecha_entrada: vals.fecha_entrada,
        fecha_produccion: vals.fecha_produccion || null,
        fecha_caducidad: vals.fecha_caducidad || null,
        precio,
        origen: vals.origen,
        notas: String(vals.notas ?? "").trim() || null,
      });
      onSaved(r.mensaje ?? "Entrada registrada");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "No se pudo registrar la entrada";
      setFormError(msg);
      setCampoErr(camposConError(msg, ETIQ_ENTRADA));
    } finally { setBusy(false); }
  };

  const campos: FieldDef[] = [
    { name: "numero_lote", label: "Nº de lote", type: "text", required: true, placeholder: "Ej. L-2026-001" },
    { name: "litros", label: "Litros de producto", type: "number", required: true, help: litrosPorGarrafa > 0 ? `Se convierten en garrafas de ${fmt(litrosPorGarrafa, 2)} L.` : "Elige el producto para ver su litros por garrafa." },
    { name: "fecha_entrada", label: "Fecha de entrada", type: "date", required: true, help: "Recepción en almacén: ordena el consumo por caducidad (FEFO)." },
    { name: "fecha_produccion", label: "Fecha de fabricación", type: "date", help: "Opcional: solo informativa, no entra en ningún cálculo." },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", help: "Opcional: déjalo en blanco si el producto no caduca." },
    { name: "precio", label: "Precio por garrafa (€)", type: "number", help: "Opcional: déjalo en blanco si no conoces el precio." },
    { name: "origen", label: "Origen", type: "select", required: true, options: ORIGEN_OPTS },
    { name: "notas", label: "Notas", type: "textarea" },
  ];

  return <Modal title="Entrada de producto químico" subtitle="Alta de un lote de un producto ya dado de alta en «Químicos»" onClose={onClose}>
    <form onSubmit={submit}>
      {formError && <div className="form-error">{formError}</div>}
      <div className="form-grid">
        <div><SelectorProducto grupos={grupos} valor={String(vals.claveProd ?? "")} onChange={(v) => set("claveProd", v)} /></div>
        {campos.map((f) => <div key={f.name} className={f.type === "textarea" ? "full" : ""}>
          <Field def={f} value={vals[f.name]} onChange={(v) => set(f.name, v)} error={campoErr.includes(f.name)} />
        </div>)}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn secondary" onClick={onClose}>Cancelar</button>
        <button className="btn" disabled={busy}>{busy ? "Registrando…" : "Registrar entrada"}</button>
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
        <div><SelectorProducto grupos={grupos} valor={claveProd} onChange={(v) => { setClaveProd(v); setFormError(null); }} soloConStock /></div>
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

  // Todos los productos (fichas incluidas): alimenta los selectores de los
  // formularios de entrada y salida.
  const gruposTodos = useMemo(() => agrupar(items), [items]);
  // Solo las filas con lote: la tabla de inventario no muestra las fichas de
  // producto (que todavía no tienen stock).
  const filtrados = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return items.filter((l) => !sinLote(l)
      && (centroId === "all" || String(l.centro_id ?? "") === centroId)
      && (mostrarRetirados || enUso(l))
      && (!needle || [l.nombre, l.marca, l.numero_lote, l.codigo].some((k) => String(k ?? "").toLowerCase().includes(needle))));
  }, [items, q, centroId, mostrarRetirados]);
  const grupos = useMemo(() => agrupar(filtrados), [filtrados]);
  // Umbrales de stock por producto: manda la ficha (la fila sin lote, que sí
  // guarda stock máximo); los lotes heredan el mínimo y por eso se completan
  // lo que la ficha no cubre. Clave = producto + marca, igual que en `agrupar`.
  const umbrales = useMemo(() => {
    const map = new Map<string, { min: number; max: number }>();
    for (const l of items) {
      const clave = claveDe(l);
      const u = { min: num(l.stock_minimo), max: num(l.stock_maximo) };
      const prev = map.get(clave);
      if (!prev || sinLote(l)) map.set(clave, u);
      else map.set(clave, { min: prev.min || u.min, max: prev.max || u.max });
    }
    return map;
  }, [items]);
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
      ["Producto", "Marca", "Lote", "Estado", "Centro", "L/garrafa", "Garrafas", "Total litros", "Entrada", "Fabricación", "Caducidad", "Origen", "Precio (€)"],
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
      {esAdmin && <button className="btn" onClick={() => setModal("entrada")}>＋ Nueva entrada</button>}
      {esAdmin && <button className="btn secondary" onClick={() => setModal("recuento")} disabled={!paraHoja.length}>📋 Recuento</button>}
    </div>

    {error && <div className="form-error no-print">{error}</div>}

    <div className="card no-print">
      <div className="section-head" style={{ padding: "14px 16px 0" }}>
        <h3>Inventario por producto</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>Pulsa una fila para ver sus lotes en uso · consumo por caducidad (FEFO)</span>
      </div>
      {loading ? <div className="loading">Cargando…</div> : error ? <div className="empty">⚠️ {error}</div> : !grupos.length
        ? <div className="empty"><span className="icon">📭</span><strong>No hay productos en el inventario</strong>
            <p>{q || centroId !== "all" ? "Prueba con otra búsqueda u otro filtro." : esAdmin ? "Registra la primera entrada con el botón «Nueva entrada»." : "Todavía no hay stock registrado."}</p></div>
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
              <td className="right"><strong>{fmt(g.litros, 2)}</strong> L<AvisoStock litros={g.litros} umbrales={umbrales.get(g.clave)} /></td>
              <td><Caducidad fecha={g.caducidad} soloTexto /></td>
              <td className="right">{abiertos.has(g.clave) ? "▲" : "▼"}</td>
            </tr>
            {abiertos.has(g.clave) && <tr>
              <td colSpan={7} style={{ background: "#f8fafc", padding: "0 8px 10px" }}>
                <table>
                  <thead><tr><th>Lote</th><th>Estado</th><th className="right">Garrafas</th><th className="right">Litros</th><th>Entrada</th><th>Fabricación</th><th>Caducidad</th><th>Centro</th><th>Origen</th></tr></thead>
                  <tbody>{g.lotes.filter((l) => !sinLote(l)).map((l) => <tr key={String(l.id)} style={{ opacity: enUso(l) ? 1 : 0.55 }}>
                    <td>{String(l.numero_lote ?? "—")}</td>
                    <td><Estado estado={estadoDe(l)} /></td>
                    <td className="right">{fmt(l.num_garrafas, 2)}</td>
                    <td className="right">{fmt(litrosDe(l), 2)}</td>
                    <td>{formatFecha(l.fecha_entrada)}</td>
                    <td>{formatFecha(l.fecha_produccion)}</td>
                    <td><Caducidad fecha={l.fecha_caducidad} /></td>
                    <td>{String(l.centro_nombre ?? "—")}</td>
                    <td>{String(l.origen ?? "") === "empresa" ? "Empresa" : "Fábrica"}</td>
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

    {modal === "entrada" && <EntradaModal grupos={gruposTodos} onClose={() => setModal(null)} onSaved={guardado} />}
    {modal === "salida" && <SalidaModal grupos={gruposTodos} onClose={() => setModal(null)} onSaved={guardado} />}
    {modal === "recuento" && <RecuentoModal lotes={paraHoja} centroLabel={centroLabel} anteriores={anteriores} onClose={() => setModal(null)} onSaved={guardado} />}
    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
