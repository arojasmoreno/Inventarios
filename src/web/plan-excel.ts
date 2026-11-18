// Lectura del plan de higiene desde Excel (o CSV) y generación de la plantilla.
// Hay dos formatos de cabecera:
//  · el actual (el de la plantilla): CLIENTE, CENTRO, ORDEN, TIPO, ZONA,
//    SUBZONA, ELEMENTO, TIPO_ZONA, FRECUENCIA_*, TIEMPO, FACTOR, HORAS_SEM,
//    TURNO, AUDITABLE, FECHA_INICIO, FECHA_ULTIMA y PROXIMA_FECHA. El centro de
//    la app se localiza con CLIENTE + CENTRO (p. ej. «Mondelez» + «Granollers»
//    → «Mondelez Granollers»).
//  · el antiguo, en el que «cliente» era el centro, «centro» la zona y «zona»
//    la subzona. Se sigue aceptando para no romper los archivos de planta.
import { normalizar, parseFecha, parseFrecuencia } from "../worker/limpieza-plan";
import { leerTextoArchivo } from "./csv";

export interface FilaPlan {
  fila: number;
  centro_id: number;
  cliente: string;
  orden: number | null;
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

interface CentroPlan { id: number; nombre: string; }

type Clave =
  | "cliente" | "centro" | "orden" | "tipo_limpieza" | "zona" | "subzona" | "tipo_zona" | "elemento"
  | "frecuencia_calculo" | "frecuencia_informativa" | "tiempo" | "factor"
  | "horas_semana" | "turno" | "auditable" | "fecha_inicio" | "ultima_realizacion" | "proxima_fecha";

// Cabeceras admitidas por campo en la plantilla actual (se comparan
// normalizadas y exactas: sin acentos, sin mayúsculas y con «_» como espacio).
const ALIAS_NUEVO: Record<Clave, string[]> = {
  cliente: ["cliente"],
  centro: ["centro"],
  orden: ["orden", "n orden", "nº orden", "numero orden", "orden tarea"],
  tipo_limpieza: ["tipo", "tipo de limpieza", "tipo limpieza"],
  zona: ["zona"],
  subzona: ["subzona", "sub zona"],
  tipo_zona: ["tipo de zona", "tipo zona"],
  elemento: ["elemento", "elementos"],
  frecuencia_calculo: ["frecuencia calculo", "frecuencia de calculo", "frecuencia", "frecuencia calc"],
  frecuencia_informativa: ["frecuencia informativa", "frecuencia info"],
  tiempo: ["tiempo", "tiempo (min)", "tiempo min", "minutos"],
  factor: ["factor"],
  horas_semana: ["horas sem", "horas semana", "horas por semana", "horas semanales", "horas sem"],
  turno: ["turno"],
  auditable: ["auditable", "auditable (si/no)", "auditoria", "auditable si no"],
  fecha_inicio: ["fecha inicio", "inicio", "fecha de inicio"],
  ultima_realizacion: ["fecha ultima", "fecha ultima realizacion", "fecha de ultima realizacion", "ultima realizacion", "fecha ultima ejecucion"],
  proxima_fecha: ["proxima fecha", "proxima fecha ejecucion", "fecha proxima"],
};

// Cabeceras del formato antiguo: «cliente» era el centro, «centro» la zona y
// «zona» la subzona.
const ALIAS_LEGADO: Record<Clave, string[]> = {
  ...ALIAS_NUEVO,
  cliente: ["cliente", "nombre del centro", "nombre centro", "centro cliente"],
  centro: [],
  orden: [],
  zona: ["centro", "zona centro"],
  subzona: ["zona", "subzona", "sub zona"],
  tipo_limpieza: ["tipo de limpieza", "tipo limpieza", "tipo"],
  horas_semana: ["horas semana", "horas por semana", "horas semanales", "horas sem"],
  ultima_realizacion: ["fecha ultima realizacion", "ultima realizacion", "fecha ultima", "fecha ultima ejecucion"],
  proxima_fecha: ["fecha proxima_fecha", "proxima fecha", "proxima fecha ejecucion", "fecha proxima"],
};

/** Columnas de la plantilla, en el mismo orden que el Excel de planta. */
export const CABECERAS_PLANTILLA = [
  "CLIENTE", "CENTRO", "ORDEN", "TIPO", "ZONA", "SUBZONA", "ELEMENTO", "TIPO_ZONA",
  "FRECUENCIA_CALCULO", "FRECUENCIA_INFORMATIVA", "TIEMPO", "FACTOR", "HORAS_SEM",
  "TURNO", "AUDITABLE", "FECHA_INICIO", "FECHA_ULTIMA", "PROXIMA_FECHA",
];

const EJEMPLO = [
  "Mondelez", "Granollers", 1, "Limpieza general", "Producción", "Línea 2", "Suelo", "Zona de paso",
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

/** Localiza el centro de la app a partir del CLIENTE y el CENTRO del Excel:
 *  primero la combinación («Mondelez» + «Granollers» → «Mondelez Granollers»),
 *  después cada uno por separado y, si no hay coincidencia exacta, el centro
 *  cuyas palabras contengan las dos (sin acentos ni mayúsculas). */
function buscarCentro(cliente: string, centro: string, centros: CentroPlan[]): CentroPlan | null {
  const porNombre = new Map(centros.map((c) => [normalizar(c.nombre), c]));
  const combinaciones = [
    `${cliente} ${centro}`, `${cliente} - ${centro}`, `${centro} ${cliente}`, centro, cliente,
  ].map((v) => v.trim()).filter(Boolean);
  for (const valor of combinaciones) {
    const encontrado = porNombre.get(normalizar(valor));
    if (encontrado) return encontrado;
  }
  const palabras = normalizar(`${cliente} ${centro}`).split(" ").filter((w) => w.length > 2);
  if (palabras.length) {
    const candidatos = centros.filter((c) => {
      const nombre = normalizar(c.nombre);
      return palabras.every((w) => nombre.includes(w));
    });
    if (candidatos.length === 1) return candidatos[0];
  }
  // Instalaciones de un solo centro: cualquier nombre vale para ese centro.
  return centros.length === 1 ? centros[0] : null;
}

/** Lee la primera hoja del archivo y devuelve las tareas listas para importar. */
export async function leerPlanExcel(file: File, centros: CentroPlan[]): Promise<PlanLeido> {
  const XLSX = await import("xlsx");
  const errores: Array<{ fila: number; mensaje: string }> = [];
  const avisos: string[] = [];
  // Los CSV se leen como texto para respetar su codificación (Excel en España
  // guarda en Windows-1252); los Excel se leen como binario.
  const esTexto = /\.(csv|txt)$/i.test(file.name);
  const libro = esTexto
    ? XLSX.read(await leerTextoArchivo(file), { type: "string" })
    : XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: "array", cellDates: true });
  const hoja = libro.Sheets[libro.SheetNames[0] ?? ""];
  if (!hoja) return { filas: [], errores: [{ fila: 1, mensaje: "El archivo no tiene ninguna hoja con datos" }], avisos };

  const matriz = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: true, defval: "" });
  if (!matriz.length) return { filas: [], errores: [{ fila: 1, mensaje: "La primera hoja está vacía" }], avisos };

  const cabecera = (matriz[0] ?? []).map((valor) => normalizar(String(valor ?? "")));
  // La columna SUBZONA distingue la plantilla actual del formato antiguo.
  const formatoNuevo = cabecera.some((h) => h === "subzona" || h === "sub zona");
  const alias = formatoNuevo ? ALIAS_NUEVO : ALIAS_LEGADO;

  const posiciones = new Map<Clave, number>();
  for (const clave of Object.keys(alias) as Clave[]) {
    const pos = cabecera.findIndex((h) => alias[clave].some((a) => normalizar(a) === h));
    if (pos >= 0) posiciones.set(clave, pos);
  }
  const requeridas: Array<[Clave, string]> = formatoNuevo
    ? [["centro", "«CENTRO»"], ["zona", "«ZONA»"], ["frecuencia_calculo", "«FRECUENCIA_CALCULO»"]]
    : [["cliente", "«cliente» (nombre del centro)"], ["zona", "«centro» (zona)"], ["frecuencia_calculo", "«frecuencia_calculo»"]];
  for (const [clave, etiqueta] of requeridas) {
    if (!posiciones.has(clave)) errores.push({ fila: 1, mensaje: `Falta la columna ${etiqueta} en la cabecera` });
  }
  if (errores.length) return { filas: [], errores, avisos };

  const valor = (fila: unknown[], clave: Clave): unknown => {
    const pos = posiciones.get(clave);
    return pos === undefined ? "" : fila[pos];
  };
  const textoCelda = (fila: unknown[], clave: Clave): string => String(valor(fila, clave) ?? "").trim();
  const filas: FilaPlan[] = [];
  let sinFrecuencia = 0;

  for (let i = 1; i < matriz.length; i++) {
    const fila = matriz[i] ?? [];
    const numeroFila = i + 1;
    const cliente = textoCelda(fila, "cliente");
    const centroTexto = formatoNuevo ? textoCelda(fila, "centro") : "";
    const zona = textoCelda(fila, "zona");
    const frecuenciaCalculo = textoCelda(fila, "frecuencia_calculo");
    if (!cliente && !centroTexto && !zona && !frecuenciaCalculo) continue; // fila en blanco

    let centro: CentroPlan | null;
    if (formatoNuevo) {
      if (!centroTexto) { errores.push({ fila: numeroFila, mensaje: "Falta el centro (columna CENTRO)" }); continue; }
      centro = buscarCentro(cliente, centroTexto, centros);
      if (!centro) {
        errores.push({ fila: numeroFila, mensaje: `No se encuentra el centro «${[cliente, centroTexto].filter(Boolean).join(" · ")}» entre los centros de la app` });
        continue;
      }
    } else {
      if (!cliente) { errores.push({ fila: numeroFila, mensaje: "Falta el cliente (nombre del centro)" }); continue; }
      centro = buscarCentro(cliente, "", centros);
      if (!centro) {
        errores.push({ fila: numeroFila, mensaje: `El cliente «${cliente}» no coincide con ningún centro` });
        continue;
      }
    }

    if (!zona) { errores.push({ fila: numeroFila, mensaje: formatoNuevo ? "Falta la zona (columna ZONA)" : "Falta el centro (zona)" }); continue; }
    if (!frecuenciaCalculo) { errores.push({ fila: numeroFila, mensaje: "Falta la frecuencia_calculo" }); continue; }
    const { turno, error: errorTurno } = turnoDe(valor(fila, "turno"));
    if (errorTurno) { errores.push({ fila: numeroFila, mensaje: errorTurno }); continue; }
    if (!parseFrecuencia(frecuenciaCalculo)) sinFrecuencia++;

    filas.push({
      fila: numeroFila,
      centro_id: centro.id,
      cliente: cliente || centro.nombre,
      orden: numero(valor(fila, "orden")),
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

  // La columna ORDEN manda en el archivo: se importa en ese orden.
  filas.sort((a, b) => (a.orden ?? Number.MAX_SAFE_INTEGER) - (b.orden ?? Number.MAX_SAFE_INTEGER) || a.fila - b.fila);

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
  // Fila de ejemplo con el aspecto de la hoja de planta (números como números).
  XLSX.writeFile(libro, "plan-higiene.xlsx");
}
