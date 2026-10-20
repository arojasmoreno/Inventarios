import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Toast } from "./ui";

type Row = Record<string, unknown>;

const MAX_ROWS = 500;

const RECURSOS = [
  { key: "quimicos", endpoint: "/api/quimicos", label: "Productos químicos",
    columns: ["codigo", "marca", "nombre", "numero_lote", "litros_por_garrafa", "num_garrafas", "fecha_caducidad", "stock_minimo", "coste_unitario", "centro", "notas"] },
  { key: "material_limpieza", endpoint: "/api/material-limpieza", label: "Material de limpieza",
    columns: ["codigo", "marca", "nombre", "color", "cantidad", "stock_minimo", "coste_unitario", "centro", "notas"] },
  { key: "maquinaria", endpoint: "/api/maquinaria", label: "Maquinaria",
    columns: ["nombre", "tipo", "marca", "modelo", "cantidad", "numero_serie", "estado", "centro", "notas"] },
  { key: "ropa_trabajo", endpoint: "/api/ropa-trabajo", label: "Ropa de trabajo",
    columns: ["codigo", "prenda", "marca", "fabricante", "modelo", "talla", "alta_visibilidad", "manga_larga", "descripcion", "color", "stock", "stock_minimo", "coste_unitario", "centro"] },
  { key: "epis", endpoint: "/api/epis", label: "EPIs",
    columns: ["codigo", "marca", "modelo", "talla", "descripcion", "color", "stock", "stock_minimo", "fecha_revision", "coste_unitario", "centro"] },
  { key: "tallas_operarios", endpoint: "/api/tallas", label: "Tallas de operarios",
    columns: ["operario", "prenda", "talla", "notas"] },
  { key: "entregas_ropa", endpoint: "/api/entregas", label: "Entregas de ropa",
    columns: ["operario", "prenda", "cantidad", "fecha", "notas"] },
] as const;

interface Catalogos { centros: Row[]; usuarios: Row[]; ropas: Row[]; }

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === "," || ch === ";" || ch === "\t") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toNumber(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v.replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function toBool(v: string | undefined): number {
  const s = (v ?? "").toLowerCase().trim();
  return ["1", "true", "si", "sí", "s", "x", "verdadero"].includes(s) ? 1 : 0;
}
const hoy = () => new Date().toISOString().slice(0, 10);

/** Resuelve un identificador por id, código o nombre (insensible a mayúsculas). */
function resolver(valor: string, filas: Row[], claves: string[]): Row | undefined {
  const v = valor.trim().toLowerCase();
  return filas.find((f) => claves.some((k) => String(f[k] ?? "").trim().toLowerCase() === v));
}
function fallo(fila: number, msg: string): string { return `Fila ${fila}: ${msg}`; }

/** Traduce una fila del CSV al JSON que espera la API (resolviendo centros/operarios/prendas). */
function parseRow(key: string, raw: Record<string, string>, fila: number, cat: Catalogos): Record<string, unknown> | string {
  const g = (k: string): string | undefined => { const v = raw[k]?.trim(); return v === "" ? undefined : v; };
  const id = (k: string): number | null => toNumber(g(k));
  const centro = (): number | null => {
    const c = g("centro") ?? g("centro_id"); if (c === undefined) return null;
    const found = resolver(c, cat.centros, ["nombre", "id"]);
    if (!found) return -1;
    return Number(found.id);
  };
  const operario = (): number | null => {
    const o = g("operario") ?? g("operario_id"); if (o === undefined) return null;
    const found = resolver(o, cat.usuarios, ["username", "nombre", "id"]);
    if (!found) return -1;
    return Number(found.id);
  };
  switch (key) {
    case "quimicos": case "material_limpieza": {
      const codigo = g("codigo") ?? g("id"); const nombre = g("nombre");
      if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const out: Record<string, unknown> = { codigo, nombre };
      if (key === "quimicos") {
        if (!g("numero_lote")) return fallo(fila, "falta la columna 'numero_lote'");
        if (!g("fecha_caducidad")) return fallo(fila, "falta la columna 'fecha_caducidad'");
        out.numero_lote = g("numero_lote");
        out.fecha_caducidad = g("fecha_caducidad");
        out.litros_por_garrafa = id("litros_por_garrafa") ?? 0;
        out.num_garrafas = id("num_garrafas") ?? 0;
      } else {
        if (!g("color")) return fallo(fila, "falta la columna 'color'");
        out.color = g("color");
        out.cantidad = id("cantidad") ?? 0;
      }
      out.marca = g("marca") ?? null;
      out.stock_minimo = id("stock_minimo") ?? 0;
      out.coste_unitario = id("coste_unitario");
      out.centro_id = centro();
      out.notas = g("notas") ?? null;
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return out;
    }
    case "maquinaria": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      if (!g("tipo")) return fallo(fila, "falta la columna 'tipo'");
      const out: Record<string, unknown> = { nombre, tipo: g("tipo") };
      out.marca = g("marca") ?? null; out.modelo = g("modelo") ?? null;
      out.cantidad = id("cantidad") ?? 1;
      out.numero_serie = g("numero_serie") ?? null;
      out.estado = g("estado") ?? "Operativa";
      out.centro_id = centro(); out.notas = g("notas") ?? null;
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return out;
    }
    case "ropa_trabajo": case "epis": {
      const codigo = g("codigo") ?? g("id"); if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      const out: Record<string, unknown> = { codigo, stock: id("stock") ?? 0 };
      if (key === "ropa_trabajo") {
        const prenda = g("prenda"); if (!prenda) return fallo(fila, "falta la columna 'prenda'");
        out.prenda = prenda;
        out.alta_visibilidad = toBool(g("alta_visibilidad"));
        out.manga_larga = toBool(g("manga_larga"));
        out.descripcion = g("descripcion") ?? null;
        out.fabricante = g("fabricante") ?? null;
        out.notas = g("notas") ?? null;
      } else {
        out.descripcion = g("descripcion") ?? null;
        out.fecha_revision = g("fecha_revision") ?? null;
      }
      out.marca = g("marca") ?? null; out.modelo = g("modelo") ?? null;
      out.talla = g("talla") ?? null; out.color = g("color") ?? null;
      out.stock_minimo = id("stock_minimo") ?? 0;
      out.coste_unitario = id("coste_unitario");
      out.centro_id = centro();
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return out;
    }
    case "tallas_operarios": {
      const operarioId = operario(); if (operarioId === null) return fallo(fila, "falta la columna 'operario'");
      if (operarioId === -1) return fallo(fila, `el operario «${g("operario")}» no existe`);
      const prenda = g("prenda"); if (!prenda) return fallo(fila, "falta la columna 'prenda'");
      const talla = g("talla"); if (!talla) return fallo(fila, "falta la columna 'talla'");
      return { usuario_id: operarioId, prenda, talla, notas: g("notas") ?? null };
    }
    case "entregas_ropa": {
      const operarioId = operario(); if (operarioId === null) return fallo(fila, "falta la columna 'operario'");
      if (operarioId === -1) return fallo(fila, `el operario «${g("operario")}» no existe`);
      const prendaRef = g("prenda"); if (!prendaRef) return fallo(fila, "falta la columna 'prenda' (código o id de la prenda)");
      const prenda = resolver(prendaRef, cat.ropas, ["codigo", "id"]);
      if (!prenda) return fallo(fila, `la prenda «${prendaRef}» no existe`);
      const cantidad = id("cantidad"); if (cantidad === null || cantidad < 1) return fallo(fila, "'cantidad' debe ser un entero ≥ 1");
      const fecha = g("fecha");
      return {
        usuario_id: operarioId, ropa_id: Number(prenda.id), cantidad,
        fecha: fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha) ? fecha : hoy(),
        notas: g("notas") ?? null,
      };
    }
    default: return "recurso no soportado";
  }
}

/** Importa un CSV con vista previa y upsert por código (endpoint batch del recurso). */
export function ImportarPage() {
  const [recurso, setRecurso] = useState<string>(RECURSOS[0].key);
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [erroresParse, setErroresParse] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState<Catalogos>({ centros: [], usuarios: [], ropas: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const cfg = RECURSOS.find((r) => r.key === recurso) ?? RECURSOS[0];

  // Catálogos para resolver centro / operario / prenda por nombre en el CSV.
  const loadCat = useCallback(async () => {
    try {
      const centros = (await api.get<{ items: Row[] }>("/api/centros")).items;
      setCat((prev) => (prev.centros.length ? prev : { ...prev, centros }));
    } catch { /* se reintenta al parsear */ }
  }, []);
  useEffect(() => { void loadCat(); }, [loadCat]);
  useEffect(() => { setRows([]); setErroresParse([]); setError(null); setDone(null); }, [recurso]);

  const ensureCat = useCallback(async (): Promise<Catalogos> => {
    const needUsers = cfg.key === "tallas_operarios" || cfg.key === "entregas_ropa";
    const next: Catalogos = { ...cat };
    if (!next.centros.length) next.centros = (await api.get<{ items: Row[] }>("/api/centros")).items;
    if (needUsers && !next.usuarios.length) next.usuarios = (await api.get<{ items: Row[] }>("/api/usuarios")).items;
    if (cfg.key === "entregas_ropa" && !next.ropas.length) next.ropas = (await api.get<{ items: Row[] }>("/api/ropa-trabajo")).items;
    setCat(next);
    return next;
  }, [cat, cfg.key]);

  const onFile = async (f: File | null) => {
    setDone(null); setError(null); setRows([]); setErroresParse([]);
    if (!f) return;
    try {
      const catalogos = await ensureCat();
      const text = await f.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (lines.length < 2) { setError("El archivo necesita una fila de cabeceras y al menos un dato."); return; }
      const headers = splitCsvLine(lines[0]);
      const parsed: Record<string, unknown>[] = [];
      const problems: string[] = [];
      const total = Math.min(lines.length - 1, MAX_ROWS);
      for (let i = 1; i <= total; i++) {
        const cells = splitCsvLine(lines[i]);
        const raw: Record<string, string> = {};
        headers.forEach((h, idx) => { raw[h.toLowerCase()] = cells[idx] ?? ""; });
        const out = parseRow(cfg.key, raw, i, catalogos);
        if (typeof out === "string") { if (problems.length < 6) problems.push(out); }
        else parsed.push(out);
      }
      if (lines.length - 1 > MAX_ROWS) problems.push(`(solo se procesan los primeros ${MAX_ROWS} registros)`);
      setRows(parsed); setErroresParse(problems);
      if (!parsed.length) setError(problems[0] ?? "No se encontraron filas válidas.");
    } catch { setError("No se pudieron leer los catálogos (centros/usuarios). Inténtalo de nuevo."); }
  };

  const plantilla = () => {
    const ejemplos: Record<string, string[]> = {
      quimicos: ["Q-001", "Proquima", "Desengrasante alcalino", "L-2026-001", "5", "12", "2027-06-30", "3", "18,50", "Planta Norte", ""],
      material_limpieza: ["M-001", "3M", "Mopa de microfibra", "Rojo", "40", "5", "4,20", "Planta Norte", ""],
      maquinaria: ["Fregadora Aquamatic", "Fregadora", "Nilfisk", "BA-500", "2", "F80-0012", "Operativa", "Planta Norte", ""],
      ropa_trabajo: ["RT-010", "Chaqueta alta visibilidad", "Lindström", "Lindström", "HV-300", "L", "1", "1", "Clase 2", "Amarillo", "30", "5", "29,90", "Planta Norte"],
      epis: ["EPI-010", "Delta Plus", "Ventec Pro", "L", "Guantes anticorte", "Azul", "40", "10", "2027-01-31", "2,50", "Planta Norte"],
      tallas_operarios: ["operario", "Chaqueta", "L", "Prefiere talla M"],
      entregas_ropa: ["operario", "RT-001", "2", hoy(), "Equipación turno de noche"],
    };
    const csv = [cfg.columns.join(","), (ejemplos[cfg.key] ?? []).join(",")].join("\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `${cfg.key}-plantilla.csv`; a.click(); URL.revokeObjectURL(url);
  };

  const importar = async () => {
    if (!rows.length) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const r = await api.post<{ creados?: number; actualizados?: number; errores?: string[] }>(`${cfg.endpoint}/import`, { rows });
      const partes = [`${r.creados ?? 0} creados`, `${r.actualizados ?? 0} actualizados`];
      const aviso = r.errores?.length ? ` · ${r.errores.length} con error` : "";
      setDone(`Importados: ${partes.join(" · ")}${aviso}`);
      if (r.errores?.length) setError(r.errores.slice(0, 4).join(" · "));
      setRows([]); setErroresParse([]); if (inputRef.current) inputRef.current.value = "";
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudo importar"); }
    finally { setBusy(false); }
  };

  return <div className="card card-pad" style={{ maxWidth: 780 }}>
    <div className="section-head"><h3>Importar CSV</h3></div>
    <p style={{ color: "var(--muted)", marginTop: 0 }}>
      Cabeceras para <strong>{cfg.label}</strong>: <code style={{ fontSize: 12 }}>{cfg.columns.join(", ")}</code>. La columna <strong>codigo</strong> hace de clave: si ya existe el registro se actualiza; si no, se crea. Acepta separador coma, punto y coma o tabulador. Centro, operario y prenda se pueden escribir por nombre.
    </p>
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <div><div className="field"><label htmlFor="imp-rec">Recurso</label>
        <select id="imp-rec" className="input" value={recurso} onChange={(e) => setRecurso(e.target.value)}>
          {RECURSOS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select></div></div>
      <div><div className="field"><label htmlFor="imp-file">Archivo CSV</label>
        <input id="imp-file" ref={inputRef} className="input" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} /></div></div>
    </div>
    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
    {done && <div className="banner" style={{ marginBottom: 12, background: "#dcfce7", color: "#166534" }}>{done}</div>}
    {rows.length > 0 && <div className="banner" style={{ marginBottom: 12, background: "#dbeafe", color: "#1e40af" }}>
      ✅ <strong>{rows.length}</strong> filas listas para importar en {cfg.label}.
    </div>}
    {erroresParse.length > 0 && <div className="form-error" style={{ marginBottom: 12 }}>{erroresParse.join(" · ")}</div>}
    <div className="modal-footer" style={{ justifyContent: "space-between" }}>
      <button className="btn secondary" onClick={plantilla}>⬇️ Descargar plantilla</button>
      <button className="btn" onClick={() => void importar()} disabled={busy || !rows.length}>{busy ? "Importando…" : `Importar ${rows.length || ""}`.trim()}</button>
    </div>
    {rows.length > 0 && <div className="table-scroll" style={{ marginTop: 12 }}>
      <table><thead><tr><th>#</th><th>Vista previa</th></tr></thead>
      <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}><td>{i + 1}</td><td style={{ fontSize: 12, fontFamily: "monospace" }}>{JSON.stringify(r).slice(0, 150)}</td></tr>)}</tbody></table>
    </div>}
    {rows.length > 5 && <p style={{ color: "var(--muted)", fontSize: 12 }}>…y {rows.length - 5} filas más.</p>}
    {done && <Toast message={done} kind="ok" onClose={() => setDone(null)} />}
  </div>;
}
