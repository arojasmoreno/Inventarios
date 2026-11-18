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
