// Filtro de periodo compartido por los informes: valida las fechas de la
// petición (`desde`/`hasta`, AAAA-MM-DD) y construye el fragmento SQL que se
// añade a las consultas de movimientos. Los valores van siempre parametrizados.
export interface Periodo {
  desde: string | null;
  hasta: string | null;
  /** Fragmento que se concatena tras una condición: " AND m.created_at >= …". */
  sql: string;
  binds: string[];
}

export interface PeriodoInvalido { error: string; }

const esFecha = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export function leerPeriodo(desdeRaw?: string | null, hastaRaw?: string | null): Periodo | PeriodoInvalido {
  const desde = desdeRaw?.trim() ? desdeRaw.trim() : null;
  const hasta = hastaRaw?.trim() ? hastaRaw.trim() : null;
  if (desde && !esFecha(desde)) return { error: "Formato de 'desde' incorrecto (AAAA-MM-DD)" };
  if (hasta && !esFecha(hasta)) return { error: "Formato de 'hasta' incorrecto (AAAA-MM-DD)" };
  if (desde && hasta && desde > hasta) return { error: "'desde' no puede ser posterior a 'hasta'" };
  const partes: string[] = [];
  const binds: string[] = [];
  if (desde) { partes.push(" AND m.created_at >= datetime(?, '00:00:00')"); binds.push(desde); }
  if (hasta) { partes.push(" AND m.created_at <= datetime(?, '23:59:59')"); binds.push(hasta); }
  return { desde, hasta, sql: partes.join(""), binds };
}

/** Texto legible del periodo aplicado, para cabeceras y exportaciones. */
export function etiquetaPeriodo(desde: string | null, hasta: string | null): string {
  if (desde && hasta) return `${desde} a ${hasta}`;
  if (desde) return `desde ${desde}`;
  if (hasta) return `hasta ${hasta}`;
  return "todo el histórico";
}
