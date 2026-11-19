// Serialización CSV compartida por las descargas de la app (Excel español:
// separador «;» y BOM para que las tildes se lean bien).
export type CsvValor = string | number | null | undefined;

const escapar = (v: CsvValor): string => {
  const s = String(v ?? "");
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function construirCsv(headers: CsvValor[], rows: CsvValor[][]): string {
  return "\uFEFF" + [headers, ...rows].map((r) => r.map(escapar).join(";")).join("\r\n");
}

/** Texto normalizado para cotejar nombres: sin acentos, sin ñ (queda «n»), sin
 *  puntuación y sin diferencias de mayúsculas ni de espacios. */
export function normalizarClave(valor: unknown): string {
  return String(valor ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[.,;:'"()ºª]/g, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

/** Agrupa las filas que comparten clave (un catálogo de proveedor repite el
 *  mismo proveedor en cada línea): se queda con la última lectura de cada una
 *  y devuelve cuántas se han unido. Sin clave, no toca el archivo. */
export function agruparPorClave<T extends Record<string, unknown>>(
  filas: T[],
  clave: string[] | undefined,
): { filas: T[]; agrupadas: number } {
  if (!clave?.length) return { filas, agrupadas: 0 };
  const porClave = new Map<string, T>();
  const salida: T[] = [];
  let agrupadas = 0;
  for (const fila of filas) {
    const k = clave.map((c) => String(fila[c] ?? "").trim().toUpperCase()).join("\u0000");
    const previa = porClave.get(k);
    if (previa) { Object.assign(previa, fila); agrupadas++; }
    else { porClave.set(k, fila); salida.push(fila); }
  }
  return { filas: salida, agrupadas };
}

/** Mapeo automático de las cabeceras de un archivo a los campos de una tabla:
 *  primero el nombre exacto del campo y después los nombres habituales de los
 *  catálogos de proveedor («Codigo proveedor», «Codigo producto»…). Cada
 *  columna del archivo se usa una sola vez. */
export function mapearColumnas(
  cfg: { columns: string[]; alias?: Record<string, string[]> },
  heads: string[],
): Record<string, string> {
  const normalizadas = heads.map((h) => normalizarClave(h));
  const usadas = new Set<number>();
  const auto: Record<string, string> = {};
  for (const campo of cfg.columns) {
    const idx = normalizadas.findIndex((h, i) => !usadas.has(i) && h === normalizarClave(campo));
    if (idx >= 0) { auto[campo] = String(idx); usadas.add(idx); } else auto[campo] = "";
  }
  for (const campo of cfg.columns) {
    if (auto[campo] !== "") continue;
    for (const alt of cfg.alias?.[campo] ?? []) {
      const idx = normalizadas.findIndex((h, i) => !usadas.has(i) && h === normalizarClave(alt));
      if (idx < 0) continue;
      auto[campo] = String(idx); usadas.add(idx);
      break;
    }
  }
  return auto;
}

/** Lee un archivo de texto respetando su codificación. Excel en España guarda
 *  los CSV en Windows-1252: si se decodifican como UTF-8, «García» y «Muñoz»
 *  llegan rotos («GarcÃ­a», «MuÃ±oz») y dejan de coincidir con los proveedores
 *  y centros del catálogo. Se intenta UTF-8 estricto y, si falla, Windows-1252. */
export async function leerTextoArchivo(archivo: Blob): Promise<string> {
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  const sinBom = (t: string) => t.replace(/^\uFEFF/, "");
  try {
    return sinBom(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    try {
      return sinBom(new TextDecoder("windows-1252").decode(bytes));
    } catch {
      return sinBom(new TextDecoder().decode(bytes));
    }
  }
}
