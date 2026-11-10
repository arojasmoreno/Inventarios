// Cálculo del plan de higiene: convierte el texto de `frecuencia_calculo` (el
// que llega en el Excel) en un intervalo y proyecta, a partir de la próxima
// fecha, los días que caen dentro de un mes concreto.
//
// La próxima fecha del plan se define como:
//   proxima_fecha = fecha_ultima_realizacion + frecuencia_calculo
// (si el plan todavía no se ha realizado nunca se toma `fecha_inicio` como
// origen, para que la primera proyección no salga vacía).

export interface Intervalo {
  unidad: "dias" | "meses";
  valor: number;
}

const pad = (n: number): string => String(n).padStart(2, "0");

export function diasEnMes(anio: number, mes: number): number {
  return new Date(Date.UTC(anio, mes, 0)).getUTCDate();
}

function aISO(fecha: Date): string {
  return `${fecha.getUTCFullYear()}-${pad(fecha.getUTCMonth() + 1)}-${pad(fecha.getUTCDate())}`;
}

/** Minúsculas, sin acentos y con los espacios colapsados. */
export function normalizar(valor: string): string {
  return valor
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fecha ISO (YYYY-MM-DD) a partir de lo que trae el Excel: texto, número de
 *  serie o celda de fecha. Devuelve null si no es una fecha válida. */
export function parseFecha(valor: unknown): string | null {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) {
    return Number.isNaN(valor.getTime()) ? null : aISO(valor);
  }
  if (typeof valor === "number") {
    // Serie de Excel: días desde 1899-12-30.
    if (!Number.isFinite(valor) || valor < 1 || valor > 120000) return null;
    return aISO(new Date(Math.round((valor - 25569) * 86400000)));
  }
  const s = String(valor).trim();
  if (!s) return null;
  let anio: number, mes: number, dia: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) {
    anio = Number(iso[1]); mes = Number(iso[2]); dia = Number(iso[3]);
  } else {
    const local = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(s);
    if (!local) return null;
    dia = Number(local[1]); mes = Number(local[2]);
    anio = Number(local[3]);
    if (anio < 100) anio += 2000;
  }
  if (mes < 1 || mes > 12 || dia < 1 || dia > diasEnMes(anio, mes)) return null;
  return `${anio}-${pad(mes)}-${pad(dia)}`;
}

/** Intervalo entre dos ejecuciones según el texto de `frecuencia_calculo`.
 *  Acepta formas como «Diaria», «Semanal», «Cada 15 días», «2 veces por
 *  semana», «Mensual», «Trimestral», «Anual»… */
export function parseFrecuencia(texto: string | null | undefined): Intervalo | null {
  const t = normalizar(texto ?? "");
  if (!t) return null;
  // El plan de planta trae la frecuencia como número de días sin unidad
  // («1», «7», «31», «365»). Sin esto no se programaba ninguna faena.
  const soloDias = /^(\d+)(?:[.,]\d+)?$/.exec(t);
  if (soloDias) {
    const n = Number(soloDias[1]);
    return n >= 1 ? { unidad: "dias", valor: n } : null;
  }
  const dias = /(\d+)\s*dias?\b/.exec(t);
  if (dias) return { unidad: "dias", valor: Math.max(1, Number(dias[1])) };
  const semanas = /(\d+)\s*semanas?\b/.exec(t);
  if (semanas) return { unidad: "dias", valor: Math.max(1, Number(semanas[1]) * 7) };
  const meses = /(\d+)\s*mes(?:es)?\b/.exec(t);
  if (meses) return { unidad: "meses", valor: Math.max(1, Number(meses[1])) };
  const anios = /(\d+)\s*anos?\b/.exec(t);
  if (anios) return { unidad: "meses", valor: Math.max(1, Number(anios[1]) * 12) };
  // «2 veces por semana» se reparte en días: 7/n (redondeado) para no salir
  // del calendario mensual.
  const veces = /(\d+)\s*veces?\b(?:\s*(?:por|a la|al|\/)\s*)?semana/.exec(t)
    ?? /(\d+)\s*veces?\b/.exec(t);
  if (veces) {
    const n = Number(veces[1]);
    if (n >= 1 && n <= 7) return { unidad: "dias", valor: Math.max(1, Math.round(7 / n)) };
  }
  if (/diari/.test(t)) return { unidad: "dias", valor: 1 };
  if (/semanal/.test(t)) return { unidad: "dias", valor: 7 };
  if (/quincenal/.test(t)) return { unidad: "dias", valor: 15 };
  if (/bimensual|bimestral/.test(t)) return { unidad: "meses", valor: 2 };
  if (/trimestral/.test(t)) return { unidad: "meses", valor: 3 };
  if (/cuatrimestral/.test(t)) return { unidad: "meses", valor: 4 };
  if (/semestral/.test(t)) return { unidad: "meses", valor: 6 };
  if (/mensual/.test(t)) return { unidad: "meses", valor: 1 };
  if (/anual/.test(t)) return { unidad: "meses", valor: 12 };
  return null;
}

/** Suma un intervalo a una fecha ISO. En los meses se recorta el día al
 *  último del mes destino (31/01 + 1 mes = 28/02). */
export function sumarIntervalo(fecha: string, intervalo: Intervalo): string {
  const [anio, mes, dia] = fecha.split("-").map(Number);
  if (intervalo.unidad === "dias") {
    const d = new Date(Date.UTC(anio, mes - 1, dia));
    d.setUTCDate(d.getUTCDate() + intervalo.valor);
    return aISO(d);
  }
  const total = anio * 12 + (mes - 1) + intervalo.valor;
  const nuevoAnio = Math.floor(total / 12);
  const nuevoMes = (total % 12) + 1;
  return `${nuevoAnio}-${pad(nuevoMes)}-${pad(Math.min(dia, diasEnMes(nuevoAnio, nuevoMes)))}`;
}

/** Saltos necesarios para que la fecha no quede antes del día 1 del mes. */
function avanzarHasta(fecha: string, intervalo: Intervalo, limite: string): string {
  if (intervalo.unidad === "dias") {
    const [ay, am, ad] = fecha.split("-").map(Number);
    const [ly, lm, ld] = limite.split("-").map(Number);
    const desde = Date.UTC(ay, am - 1, ad);
    const hasta = Date.UTC(ly, lm - 1, ld);
    const saltos = Math.ceil((hasta - desde) / (intervalo.valor * 86400000));
    return aISO(new Date(desde + saltos * intervalo.valor * 86400000));
  }
  const [ay, am] = fecha.split("-").map(Number);
  const [ly, lm] = limite.split("-").map(Number);
  const saltos = Math.max(0, Math.floor(((ly * 12 + lm) - (ay * 12 + am)) / intervalo.valor));
  let actual = saltos ? sumarIntervalo(fecha, { unidad: "meses", valor: saltos * intervalo.valor }) : fecha;
  for (let i = 0; i < 64 && actual < limite; i++) actual = sumarIntervalo(actual, intervalo);
  return actual;
}

/** Días del mes (1-31) en los que cae la tarea. Si la frecuencia es
 *  desconocida o no hay fecha de partida devuelve una lista vacía. */
export function fechasDelMes(base: string | null, intervalo: Intervalo | null, anio: number, mes: number): number[] {
  if (!base || !intervalo || intervalo.valor < 1) return [];
  const primero = `${anio}-${pad(mes)}-01`;
  const ultimo = `${anio}-${pad(mes)}-${pad(diasEnMes(anio, mes))}`;
  let fecha = base < primero ? avanzarHasta(base, intervalo, primero) : base;
  const dias: number[] = [];
  for (let i = 0; i < 366 && fecha <= ultimo; i++) {
    if (fecha >= primero) dias.push(Number(fecha.slice(8, 10)));
    fecha = sumarIntervalo(fecha, intervalo);
  }
  return dias;
}
