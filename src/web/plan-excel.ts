// Lectura del plan de higiene desde Excel (o CSV) y generación de la plantilla.
// Las cabeceras son las del formato que usa planta: «cliente» es el nombre del
// centro, «centro» la zona y «zona» la subzona.
import { normalizar, parseFecha, parseFrecuencia } from "../worker/limpieza-plan";

export interface FilaPlan {
  fila: number;
  centro_id: number;
  cliente: string;
  tipo_limpieza: string;
  zona: string;
  subzona: string;
  tipo_zona: string;
  elemento: string;
  frecuencia_calculo: string;
  frecuencia_informativa: string;
  tiempo: number | null;
  factor: number | null;
  horas_semana: number | null;
  turno: "dia" | "tarde" | "noche";
  auditable: number;
  fecha_inicio: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
}

export interface PlanLeido {
  filas: FilaPlan[];
  errores: Array<{ fila: number; mensaje: string }>;
  avisos: string[];
}

type Clave =
  | "cliente" | "tipo_limpieza" | "zona" | "subzona" | "tipo_zona" | "elemento"
  | "frecuencia_calculo" | "frecuencia_informativa" | "tiempo" | "factor"
  | "horas_semana" | "turno" | "auditable" | "fecha_inicio" | "ultima_realizacion" | "proxima_fecha";

// Cabeceras admitidas para cada campo (se comparan normalizadas y exactas).
const ALIAS: Record<Clave, string[]> = {
  cliente: ["cliente", "nombre del centro", "nombre centro", "centro cliente"],
  tipo_limpieza: ["tipo de limpieza", "tipo limpieza"],
  zona: ["centro", "zona centro"],
  subzona: ["zona", "subzona", "sub zona"],
  tipo_zona: ["tipo de zona", "tipo zona"],
  elemento: ["elemento", "elementos"],
  frecuencia_calculo: ["frecuencia_calculo", "frecuencia calculo", "frecuencia de calculo", "frecuencia"],
  frecuencia_informativa: ["frecuencia_informativa", "frecuencia informativa"],
  tiempo: ["tiempo", "tiempo (min)", "tiempo min", "minutos"],
  factor: ["factor"],
  horas_semana: ["horas semana", "horas_semana", "horas por semana", "horas semanales"],
  turno: ["turno"],
  auditable: ["auditable", "auditable (si/no)", "auditoria", "auditable si no"],
  fecha_inicio: ["fecha inicio", "fecha_inicio", "inicio"],
  ultima_realizacion: ["fecha ultima realizacion", "fecha_ultima_realizacion", "ultima realizacion", "fecha ultima"],
  proxima_fecha: ["fecha proxima_fecha", "proxima fecha", "proxima_fecha", "fecha proxima"],
};

const CABECERAS_PLANTILLA = [
  "cliente", "tipo de limpieza", "centro", "zona", "tipo de zona", "elemento",
  "frecuencia_calculo", "frecuencia_informativa", "tiempo", "factor", "horas semana",
  "turno", "auditable", "fecha inicio", "fecha última realización", "fecha proxima_fecha",
];

const EJEMPLO = [
  "Centro Norte", "Limpieza general", "Producción", "Línea 2", "Zona de paso", "Suelo",
  "Diaria", "Diaria (todos los días)", 15, 1, 1.75, "Día", "Sí", "01/11/2026", "31/10/2026", "01/11/2026",
];

function numero(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  const s = String(valor ?? "").trim().replace("%", "").replace(",", ".");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function booleano(valor: unknown): number {
  if (typeof valor === "boolean") return valor ? 1 : 0;
  if (typeof valor === "number") return valor ? 1 : 0;
  const t = normalizar(String(valor ?? ""));
  return ["si", "s", "x", "true", "1", "yes"].includes(t) ? 1 : 0;
}

function turnoDe(valor: unknown): { turno: "dia" | "tarde" | "noche"; error?: string } {
  const t = normalizar(String(valor ?? "") || "dia");
  if (!t || /^(dia|manana|matinal|completo)$/.test(t)) return { turno: "dia" };
  if (/tarde/.test(t)) return { turno: "tarde" };
  if (/noche|nocturn/.test(t)) return { turno: "noche" };
  return { turno: "dia", error: `Turno «${String(valor)}» no reconocido: usa Día, Tarde o Noche` };
}

/** Lee la primera hoja del archivo y devuelve las tareas listas para importar. */
export async function leerPlanExcel(file: File, centros: Array<{ id: number; nombre: string }>): Promise<PlanLeido> {
  const XLSX = await import("xlsx");
  const libro = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
  const hoja = libro.Sheets[libro.SheetNames[0] ?? ""];
  const errores: Array<{ fila: number; mensaje: string }> = [];
  const avisos: string[] = [];
  if (!hoja) return { filas: [], errores: [{ fila: 1, mensaje: "El archivo no tiene ninguna hoja con datos" }], avisos };

  const matriz = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: "" });
  if (!matriz.length) return { filas: [], errores: [{ fila: 1, mensaje: "La primera hoja está vacía" }], avisos };

  const cabecera = (matriz[0] ?? []).map((valor) => normalizar(String(valor ?? "")));
  const posiciones = new Map<Clave, number>();
  for (const clave of Object.keys(ALIAS) as Clave[]) {
    const pos = cabecera.findIndex((h) => ALIAS[clave].some((alias) => normalizar(alias) === h));
    if (pos >= 0) posiciones.set(clave, pos);
  }
  for (const [clave, etiqueta] of [
    ["cliente", "«cliente» (nombre del centro)"],
    ["zona", "«centro» (zona)"],
    ["frecuencia_calculo", "«frecuencia_calculo»"],
  ] as Array<[Clave, string]>) {
    if (!posiciones.has(clave)) errores.push({ fila: 1, mensaje: `Falta la columna ${etiqueta} en la cabecera` });
  }
  if (errores.length) return { filas: [], errores, avisos };

  const valor = (fila: unknown[], clave: Clave): unknown => {
    const pos = posiciones.get(clave);
    return pos === undefined ? "" : fila[pos];
  };
  const textoCelda = (fila: unknown[], clave: Clave): string => String(valor(fila, clave) ?? "").trim();
  const centrosPorNombre = new Map(centros.map((c) => [normalizar(c.nombre), c]));
  const filas: FilaPlan[] = [];
  let sinFrecuencia = 0;

  for (let i = 1; i < matriz.length; i++) {
    const fila = matriz[i] ?? [];
    const numeroFila = i + 1;
    const cliente = textoCelda(fila, "cliente");
    const zona = textoCelda(fila, "zona");
    const frecuenciaCalculo = textoCelda(fila, "frecuencia_calculo");
    if (!cliente && !zona && !frecuenciaCalculo) continue; // fila en blanco
    if (!cliente) { errores.push({ fila: numeroFila, mensaje: "Falta el cliente (nombre del centro)" }); continue; }
    const centro = centrosPorNombre.get(normalizar(cliente));
    if (!centro) {
      errores.push({ fila: numeroFila, mensaje: `El cliente «${cliente}» no coincide con ningún centro` });
      continue;
    }
    if (!zona) { errores.push({ fila: numeroFila, mensaje: "Falta el centro (zona)" }); continue; }
    if (!frecuenciaCalculo) { errores.push({ fila: numeroFila, mensaje: "Falta la frecuencia_calculo" }); continue; }
    const { turno, error: errorTurno } = turnoDe(valor(fila, "turno"));
    if (errorTurno) { errores.push({ fila: numeroFila, mensaje: errorTurno }); continue; }
    if (!parseFrecuencia(frecuenciaCalculo)) sinFrecuencia++;

    filas.push({
      fila: numeroFila,
      centro_id: centro.id,
      cliente,
      tipo_limpieza: textoCelda(fila, "tipo_limpieza"),
      zona,
      subzona: textoCelda(fila, "subzona"),
      tipo_zona: textoCelda(fila, "tipo_zona"),
      elemento: textoCelda(fila, "elemento"),
      frecuencia_calculo: frecuenciaCalculo,
      frecuencia_informativa: textoCelda(fila, "frecuencia_informativa"),
      tiempo: numero(valor(fila, "tiempo")),
      factor: numero(valor(fila, "factor")),
      horas_semana: numero(valor(fila, "horas_semana")),
      turno,
      auditable: booleano(valor(fila, "auditable")),
      fecha_inicio: parseFecha(valor(fila, "fecha_inicio")),
      ultima_realizacion: parseFecha(valor(fila, "ultima_realizacion")),
      proxima_fecha: parseFecha(valor(fila, "proxima_fecha")),
    });
  }

  if (sinFrecuencia) avisos.push(`${sinFrecuencia} tarea${sinFrecuencia === 1 ? "" : "s"} con una frecuencia de cálculo que no se reconoce: se importarán, pero no se programarán automáticamente.`);
  if (!filas.length && !errores.length) errores.push({ fila: 2, mensaje: "La hoja no contiene tareas" });
  return { filas, errores, avisos };
}

/** Descarga una plantilla Excel con las columnas del plan y una fila de ejemplo. */
export async function descargarPlantilla(): Promise<void> {
  const XLSX = await import("xlsx");
  const hoja = XLSX.utils.aoa_to_sheet([CABECERAS_PLANTILLA, EJEMPLO]);
  hoja["!cols"] = CABECERAS_PLANTILLA.map(() => ({ wch: 18 }));
  const libro = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(libro, hoja, "Plan de higiene");
  XLSX.writeFile(libro, "plan-higiene.xlsx");
}
