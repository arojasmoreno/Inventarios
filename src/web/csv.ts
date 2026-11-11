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
