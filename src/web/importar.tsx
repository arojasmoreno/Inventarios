import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { downloadCsv, formatNum, Toast } from "./ui";

type Row = Record<string, unknown>;

const MAX_ROWS = 500;

const RECURSOS = [
  { key: "quimicos", endpoint: "/api/quimicos", label: "Productos químicos",
    columns: ["codigo", "marca", "nombre", "numero_lote", "litros_por_garrafa", "num_garrafas", "fecha_produccion", "fecha_caducidad", "stock_minimo", "origen", "centro", "notas"] },
  { key: "material_limpieza", endpoint: "/api/material-limpieza", label: "Material de limpieza",
    columns: ["codigo", "marca", "nombre", "color", "cantidad", "stock_minimo", "origen", "centro", "notas"] },
  { key: "maquinaria", endpoint: "/api/maquinaria", label: "Maquinaria",
    columns: ["nombre", "tipo", "marca", "modelo", "numero_serie", "centro", "zona", "subzona", "notas"] },
  { key: "ropa_trabajo", endpoint: "/api/ropa-trabajo", label: "Ropa de trabajo",
    columns: ["codigo", "prenda", "marca", "fabricante", "modelo", "talla", "alta_visibilidad", "manga_larga", "descripcion", "color", "stock", "stock_minimo", "centro"] },
  { key: "epis", endpoint: "/api/epis", label: "EPIs",
    columns: ["codigo", "marca", "modelo", "talla", "descripcion", "color", "stock", "stock_minimo", "fecha_revision", "centro"] },
  { key: "tallas_operarios", endpoint: "/api/tallas", label: "Tallas de operarios",
    columns: ["operario", "prenda", "talla", "notas"] },
] as const;

// Campos sin los que la fila no se puede dar de alta; el resto son opcionales
// y pueden quedarse sin asignar en el mapeo.
const OBLIGATORIOS: Record<string, string[]> = {
  quimicos: ["codigo", "nombre", "numero_lote"],
  material_limpieza: ["codigo", "nombre", "color"],
  maquinaria: ["nombre", "tipo", "zona"],
  ropa_trabajo: ["codigo", "prenda"],
  epis: ["codigo"],
  tallas_operarios: ["operario", "prenda", "talla"],
};

interface Catalogos { centros: Row[]; usuarios: Row[]; zonas: Row[]; subzonas: Row[]; }

const norm = (v: string): string =>
  String(v ?? "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\s_-]+/g, " ");

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === "\"" && line[i + 1] === "\"") { cur += "\""; i++; }
      else if (ch === "\"") inQ = false;
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

/** Resuelve un identificador por id, código o nombre (insensible a mayúsculas). */
function resolver(valor: string, filas: Row[], claves: string[]): Row | undefined {
  const v = norm(valor);
  return filas.find((f) => claves.some((k) => norm(String(f[k] ?? "")) === v));
}
const fallo = (fila: number, msg: string): string => `Fila ${fila}: ${msg}`;

/** Traduce una fila del CSV al JSON que espera la API (resolviendo centros/operarios/prendas). */
function parseRow(key: string, raw: Record<string, string>, fila: number, cat: Catalogos): Record<string, unknown> | string {
  const g = (k: string): string | undefined => { const v = raw[k]?.trim(); return v === "" ? undefined : v; };
  const id = (k: string): number | null => toNumber(g(k));
  const centro = (): number | null => {
    const c = g("centro") ?? g("centro_id"); if (c === undefined) return null;
    const found = resolver(c, cat.centros, ["nombre", "id"]);
    return found ? Number(found.id) : -1;
  };
  const operario = (): number | null => {
    const o = g("operario") ?? g("operario_id"); if (o === undefined) return null;
    const found = resolver(o, cat.usuarios, ["username", "nombre", "id"]);
    return found ? Number(found.id) : -1;
  };
  switch (key) {
    case "quimicos": case "material_limpieza": {
      const codigo = g("codigo") ?? g("id"); const nombre = g("nombre");
      if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const out: Record<string, unknown> = { codigo, nombre };
      if (key === "quimicos") {
        if (!g("numero_lote")) return fallo(fila, "falta la columna 'numero_lote'");
        out.numero_lote = g("numero_lote");
        out.fecha_produccion = g("fecha_produccion") ?? null;
        out.fecha_caducidad = g("fecha_caducidad") ?? null;
        out.litros_por_garrafa = id("litros_por_garrafa") ?? 0;
        out.num_garrafas = id("num_garrafas") ?? 0;
        out.estado = (g("estado") ?? "activo").trim().toLowerCase();
      } else {
        if (!g("color")) return fallo(fila, "falta la columna 'color'");
        out.color = g("color");
        out.cantidad = id("cantidad") ?? 0;
      }
      out.marca = g("marca") ?? null;
      out.stock_minimo = id("stock_minimo") ?? 0;
      const org = (g("origen") ?? "").toLowerCase();
      out.origen = org.startsWith("emp") ? "empresa" : org.startsWith("fab") ? "fabrica" : null;
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
      out.numero_serie = g("numero_serie") ?? null;
      out.centro_id = centro(); out.notas = g("notas") ?? null;
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      const zn = g("zona");
      if (!zn) return fallo(fila, "falta la columna 'zona'");
      const zonas = cat.zonas.filter((z) => out.centro_id == null || Number(z.centro_id) === Number(out.centro_id));
      const z = resolver(zn, zonas, ["nombre", "id"]);
      if (!z) return fallo(fila, `la zona «${zn}» no existe en ese centro`);
      out.zona_id = Number(z.id);
      const sn = g("subzona");
      if (sn) {
        const s = resolver(sn, cat.subzonas.filter((x) => Number(x.zona_id) === Number(z.id)), ["nombre", "id"]);
        if (!s) return fallo(fila, `la subzona «${sn}» no existe en esa zona`);
        out.subzona_id = Number(s.id);
      } else out.subzona_id = null;
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
    default: return "recurso no soportado";
  }
}

export function ImportarPage() {
  const [recurso, setRecurso] = useState<string>(RECURSOS[0].key);
  const [cabeceras, setCabeceras] = useState<string[]>([]);
  const [lineas, setLineas] = useState<string[][]>([]);
  const [mapa, setMapa] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [erroresParse, setErroresParse] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cat, setCat] = useState<Catalogos>({ centros: [], usuarios: [], zonas: [], subzonas: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const cfg = RECURSOS.find((r) => r.key === recurso) ?? RECURSOS[0];

  // Catálogos para resolver centro / operario / zona por nombre en el CSV.
  const ensureCat = useCallback(async (): Promise<Catalogos> => {
    const needUsers = cfg.key === "tallas_operarios";
    const needZonas = cfg.key === "maquinaria";
    const next: Catalogos = { ...cat };
    if (!next.centros.length) next.centros = (await api.get<{ items: Row[] }>("/api/centros")).items;
    if (needUsers && !next.usuarios.length) next.usuarios = (await api.get<{ items: Row[] }>("/api/usuarios")).items;
    if (needZonas) {
      if (!next.zonas.length) next.zonas = (await api.get<{ items: Row[] }>("/api/zonas")).items;
      if (!next.subzonas.length) next.subzonas = (await api.get<{ items: Row[] }>("/api/subzonas")).items;
    }
    setCat(next);
    return next;
  }, [cat, cfg.key]);

  useEffect(() => {
    setRows([]); setErroresParse([]); setError(null); setDone(null);
    setCabeceras([]); setLineas([]); setMapa({});
    if (inputRef.current) inputRef.current.value = "";
  }, [recurso]);

  const faltan = useMemo(() => (OBLIGATORIOS[cfg.key] ?? []).filter((f) => !mapa[f]), [cfg.key, mapa]);
  const mapeados = useMemo(() => cfg.columns.filter((f) => mapa[f]).length, [cfg.columns, mapa]);

  const onFile = async (f: File | null) => {
    setDone(null); setError(null); setRows([]); setErroresParse([]);
    setCabeceras([]); setLineas([]); setMapa({});
    if (!f) return;
    try {
      const texto = await f.text();
      const todas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
      if (todas.length < 2) { setError("El archivo necesita una fila de cabeceras y al menos un dato."); return; }
      const heads = splitCsvLine(todas[0]);
      setCabeceras(heads);
      setLineas(todas.slice(1).map(splitCsvLine));
      // Mapeo automático: cada cabecera que coincida con un campo (sin
      // acentos, guiones ni mayúsculas) se asigna sola; el resto lo elige el
      // usuario en la tabla.
      const auto: Record<string, string> = {};
      for (const campo of cfg.columns) {
        const idx = heads.findIndex((h) => norm(h) === norm(campo));
        auto[campo] = idx >= 0 ? String(idx) : "";
      }
      setMapa(auto);
    } catch { setError("No se pudo leer el archivo."); }
  };

  const previsualizar = async () => {
    setError(null); setDone(null); setRows([]); setErroresParse([]);
    if (!lineas.length) { setError("Elige primero un archivo CSV."); return; }
    if (faltan.length) { setError(`Asigna una columna para: ${faltan.join(", ")}.`); return; }
    try {
      const catalogos = await ensureCat();
      const parsed: Record<string, unknown>[] = [];
      const problemas: string[] = [];
      const total = Math.min(lineas.length, MAX_ROWS);
      for (let i = 0; i < total; i++) {
        const cells = lineas[i];
        const raw: Record<string, string> = {};
        for (const campo of cfg.columns) {
          const idx = Number(mapa[campo]);
          if (mapa[campo] !== "" && Number.isInteger(idx)) raw[campo] = cells[idx] ?? "";
        }
        const out = parseRow(cfg.key, raw, i + 2, catalogos);
        if (typeof out === "string") problemas.push(out);
        else parsed.push(out);
      }
      if (lineas.length > MAX_ROWS) problemas.push(`(solo se procesan los primeros ${MAX_ROWS} registros)`);
      setRows(parsed);
      setErroresParse(problemas);
      if (!parsed.length) setError(problemas[0] ?? "No se encontraron filas válidas.");
    } catch { setError("No se pudieron leer los catálogos (centros/usuarios/zonas). Inténtalo de nuevo."); }
  };

  // Plantilla con las cabeceras y una fila de ejemplo del recurso elegido.
  const plantilla = () => {
    const ejemplos: Record<string, string[]> = {
      quimicos: ["Q-001", "Proquima", "Desengrasante alcalino", "L-2026-001", "5", "12", "2026-01-01", "2027-06-30", "3", "fabrica", "Planta Norte", ""],
      material_limpieza: ["M-001", "3M", "Mopa de microfibra", "Rojo", "40", "5", "fabrica", "Planta Norte", ""],
      maquinaria: ["Fregadora Aquamatic", "Fregadora", "Nilfisk", "BA-500", "F80-0012", "Planta Norte", "Lavado", "Paletización", ""],
      ropa_trabajo: ["RT-010", "Chaqueta alta visibilidad", "Lindström", "Lindström", "HV-300", "L", "1", "1", "Clase 2", "Amarillo", "30", "5", "Planta Norte"],
      epis: ["EPI-010", "Delta Plus", "Ventec Pro", "L", "Guantes anticorte", "Azul", "40", "10", "2027-01-31", "Planta Norte"],
      tallas_operarios: ["operario", "Chaqueta", "L", "Prefiere talla M"],
    };
    downloadCsv(`${cfg.key}-plantilla.csv`, [...cfg.columns], [ejemplos[cfg.key] ?? []]);
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

  return <div className="card card-pad" style={{ maxWidth: 900 }}>
    <div className="section-head"><h3>Importar CSV</h3></div>
    <p style={{ color: "var(--muted)", marginTop: 0 }}>
      Sube el archivo y comprueba el <strong>mapeo de columnas</strong>: cada columna del CSV se asigna a un campo de{" "}
      <strong>{cfg.label}</strong>. Solo los campos obligatorios son necesarios. La clave es <code>codigo</code>:
      si el registro ya existe se actualiza y si no se crea. Acepta separador coma, punto y coma o tabulador.
    </p>
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <div><div className="field"><label htmlFor="imp-rec">Recurso</label>
        <select id="imp-rec" className="input" value={recurso} onChange={(e) => setRecurso(e.target.value)}>
          {RECURSOS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select></div></div>
      <div><div className="field"><label htmlFor="imp-file">Archivo CSV</label>
        <input id="imp-file" ref={inputRef} className="input" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files?.[0] ?? null)} /></div></div>
    </div>

    {cabeceras.length > 0 && <div style={{ marginBottom: 12 }}>
      <div className="section-head" style={{ marginBottom: 6 }}>
        <h3 style={{ fontSize: 14 }}>Mapeo de columnas</h3>
        <span className="badge muted">{formatNum(mapeados)} de {formatNum(cfg.columns.length)} campos asignados</span>
      </div>
      <div className="table-scroll"><table>
        <thead><tr><th>Campo</th><th>Columna del CSV</th><th /></tr></thead>
        <tbody>{cfg.columns.map((campo) => {
          const obligatorio = (OBLIGATORIOS[cfg.key] ?? []).includes(campo);
          const sinAsignar = obligatorio && !mapa[campo];
          return <tr key={campo}>
            <td><code>{campo}</code>{obligatorio && <span className="badge warn" style={{ marginLeft: 6 }}>obligatorio</span>}</td>
            <td><select className={"input" + (sinAsignar ? " error" : "")} aria-label={`Columna para ${campo}`} value={mapa[campo] ?? ""}
              onChange={(e) => setMapa((prev) => ({ ...prev, [campo]: e.target.value }))}>
              <option value="">— Sin asignar —</option>
              {cabeceras.map((h, i) => <option key={`${h}-${i}`} value={String(i)}>{h || `Columna ${i + 1}`}</option>)}
            </select></td>
            <td>{mapa[campo] ? <span className="badge ok">{cabeceras[Number(mapa[campo])]}</span> : <span className="badge muted">—</span>}</td>
          </tr>;
        })}</tbody></table></div>
    </div>}

    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
    {done && <div className="banner" style={{ marginBottom: 12, background: "#dcfce7", color: "#166534" }}>{done}</div>}

    {rows.length > 0 && <div className="banner" style={{ marginBottom: 12, background: "#dbeafe", color: "#1e40af" }}>
      ✅ <strong>{formatNum(rows.length)}</strong> filas válidas listas para importar en {cfg.label}.
      {erroresParse.length > 0 && <> ⚠️ {formatNum(erroresParse.length)} fila{erroresParse.length === 1 ? "" : "s"} con problemas no se importará{erroresParse.length === 1 ? "" : "n"}.</>}
    </div>}
    {erroresParse.length > 0 && <div className="form-error" style={{ marginBottom: 12 }}>
      {erroresParse.slice(0, 8).join(" · ")}{erroresParse.length > 8 ? ` · …y ${erroresParse.length - 8} más` : ""}
    </div>}

    <div className="modal-footer" style={{ justifyContent: "space-between" }}>
      <div className="chips" style={{ margin: 0 }}>
        <button className="btn secondary" onClick={plantilla}>⬇️ Descargar plantilla</button>
        <button className="btn secondary" onClick={() => void previsualizar()} disabled={!lineas.length || faltan.length > 0}>🔍 Previsualizar</button>
      </div>
      <button className="btn" onClick={() => void importar()} disabled={busy || !rows.length}>{busy ? "Importando…" : `Importar ${rows.length ? formatNum(rows.length) : ""}`.trim()}</button>
    </div>

    {rows.length > 0 && <div className="table-scroll" style={{ marginTop: 12 }}>
      <table><thead><tr><th>#</th><th>Vista previa</th></tr></thead>
        <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}><td>{i + 1}</td><td style={{ fontSize: 12, fontFamily: "monospace" }}>{JSON.stringify(r).slice(0, 180)}</td></tr>)}</tbody></table>
    </div>}
    {rows.length > 5 && <p style={{ color: "var(--muted)", fontSize: 12 }}>…y {formatNum(rows.length - 5)} filas más.</p>}
    {done && <Toast message={done} kind="ok" onClose={() => setDone(null)} />}
  </div>;
}
