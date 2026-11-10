import { Fragment, useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { formatFecha, formatNum } from "./ui";

type Turno = "dia" | "tarde" | "noche";

interface Registro { dia: number; usuario_id: number; usuario: string; creado: string }
interface TareaTabla {
  faena_id: number;
  zona: string;
  subzona: string | null;
  elemento: string | null;
  tipo_limpieza: string | null;
  frecuencia_informativa: string | null;
  frecuencia_calculo: string | null;
  dias: number[];
  registros: Registro[];
}
interface Bloque { dias: number | null; etiqueta: string; tareas: TareaTabla[] }
interface Extra {
  plan_id: number;
  zona: string;
  subzona: string | null;
  elemento: string | null;
  frecuencia_calculo: string;
  frecuencia_informativa: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
  faena_id: number | null;
  dia: number | null;
  toca_este_mes: boolean;
  registro: { usuario_id: number; usuario: string; creado: string } | null;
}
interface TurnoDatos { turno: Turno; etiqueta: string; bloques: Bloque[]; extras: Extra[] }
interface Tablas {
  centro: { id: number; nombre: string };
  anio: number;
  mes: number;
  dias_mes: number;
  fecha_hoy: string;
  festivos: string[];
  turnos: TurnoDatos[];
  puede_gestionar: boolean;
  resumen: { tareas: number; programadas: number; hechas: number; extras: number };
}

const ICONO: Record<Turno, string> = { dia: "☀️", tarde: "🌤️", noche: "🌙" };

const pad = (n: number): string => String(n).padStart(2, "0");
const iso = (anio: number, mes: number, dia: number): string => `${anio}-${pad(mes)}-${pad(dia)}`;
const indiceSemana = (anio: number, mes: number, dia: number): number => (new Date(anio, mes - 1, dia).getDay() + 6) % 7;
const esFinde = (anio: number, mes: number, dia: number): boolean => indiceSemana(anio, mes, dia) >= 5;
const nombreTarea = (t: { zona: string; subzona: string | null }): string => (t.subzona ? `${t.zona} / ${t.subzona}` : t.zona);

/** Tablas del mes: tareas por turno y frecuencia, con sus extras y la marca
 *  de realización. La misma vista se imprime en horizontal. */
export function TablasMes({ centro, anio, mes, mesTexto, version, userId, onAviso, onAbrirPlan }: {
  centro: { id: number; nombre: string };
  anio: number;
  mes: number;
  mesTexto: string;
  version: number;
  userId: number;
  onAviso: (mensaje: string, kind?: "ok" | "error") => void;
  onAbrirPlan?: () => void;
}) {
  const [datos, setDatos] = useState<Tablas | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recarga, setRecarga] = useState(0);
  const [pendiente, setPendiente] = useState<string | null>(null);

  const cargar = useCallback(() => setRecarga((n) => n + 1), []);

  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    const params = new URLSearchParams({ centro_id: String(centro.id), anio: String(anio), mes: String(mes) });
    api.get<Tablas>(`/api/limpieza/tablas?${params.toString()}`)
      .then((r) => { if (vivo) setDatos(r); })
      .catch((e) => { if (vivo) { setDatos(null); setError(e instanceof Error ? e.message : "No se pudieron cargar las tablas"); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [centro.id, anio, mes, version, recarga]);

  const alternar = async (faenaId: number, dia: number, hecho: boolean) => {
    setPendiente(`${faenaId}-${dia}`);
    try {
      await api.post("/api/limpieza/registros", { faena_id: faenaId, dia, hecho });
      cargar();
      onAviso(hecho ? "Tarea marcada como realizada" : "Marca retirada");
    } catch (e) {
      onAviso(e instanceof Error ? e.message : "No se pudo marcar la tarea", "error");
    } finally {
      setPendiente(null);
    }
  };

  const numerosDia = Array.from({ length: datos?.dias_mes ?? 0 }, (_, i) => i + 1);
  const festivos = new Set(datos?.festivos ?? []);
  const hoyISO = datos?.fecha_hoy ?? "";

  return <>
    <div className="no-print">
      <div className="card tablas-card">
        <div className="tablas-head">
          <div>
            <h3>Tablas de {mesTexto}</h3>
            <p>
              Tareas de <strong>{centro.nombre}</strong> agrupadas por turno y frecuencia. Pulsa un día para
              marcar la tarea como realizada; los días futuros se marcarán cuando lleguen.
            </p>
          </div>
          <button type="button" className="btn secondary" onClick={() => window.print()} disabled={!datos}>
            🖨️ Imprimir {mesTexto}
          </button>
        </div>

        {cargando && <div className="cal-loading-bar" role="progressbar" aria-label="Cargando tablas"><span /></div>}
        {error ? <div className="empty">⚠️ {error}</div>
          : !datos ? <div className="loading">Cargando las tablas del mes…</div>
          : <>
            <div className="tablas-resumen">
              <span><strong>{formatNum(datos.resumen.tareas)}</strong> tareas en el mes</span>
              <span><strong>{formatNum(datos.resumen.programadas)}</strong> días programados</span>
              <span><strong>{formatNum(datos.resumen.hechas)}</strong> marcadas</span>
              <span><strong>{formatNum(datos.resumen.extras)}</strong> extras tocan este mes</span>
            </div>

            {datos.turnos.map((t) => {
              const tareas = t.bloques.flatMap((b) => b.tareas);
              const programadas = tareas.reduce((n, x) => n + x.dias.length, 0);
              const hechas = tareas.reduce((n, x) => n + x.registros.length, 0);
              return <section className="tablas-turno" key={t.turno}>
                <header className="tablas-turno-head">
                  <h3>{ICONO[t.turno]} Turno de {t.etiqueta.toLowerCase()}</h3>
                  <span>
                    {formatNum(tareas.length)} tareas · {formatNum(hechas)}/{formatNum(programadas)} marcadas
                    {t.extras.length ? ` · ${formatNum(t.extras.length)} extras` : ""}
                  </span>
                </header>

                {!t.bloques.length && !t.extras.length && <div className="tablas-vacio">
                  <span>Este turno no tiene tareas generadas para {mesTexto}.</span>
                  {datos.puede_gestionar && onAbrirPlan && <button type="button" className="btn secondary small" onClick={onAbrirPlan}>📊 Generar el mes desde el plan de higiene</button>}
                </div>}

                {t.bloques.map((bloque) => {
                  const marcadas = bloque.tareas.reduce((n, x) => n + x.registros.length, 0);
                  const totalDias = bloque.tareas.reduce((n, x) => n + x.dias.length, 0);
                  return <div className={"tabla-bloque f" + (bloque.dias ?? "sin")} key={String(bloque.dias)}>
                    <div className="tabla-bloque-head">
                      <h4>{bloque.etiqueta}</h4>
                      <span>{formatNum(bloque.tareas.length)} tareas · {formatNum(marcadas)}/{formatNum(totalDias)} días hechos</span>
                    </div>
                    <div className="tabla-bloque-scroll">
                      <table className="tabla-frec">
                        <thead>
                          <tr>
                            <th className="tabla-th-tarea">Tarea</th>
                            <th>Frecuencia</th>
                            <th>Días del mes</th>
                            <th className="right">Hechas</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bloque.tareas.map((tarea) => {
                            const registros = new Map(tarea.registros.map((r) => [r.dia, r]));
                            return <tr key={tarea.faena_id}>
                              <td className="tabla-tarea">
                                <strong>{nombreTarea(tarea)}</strong>
                                {tarea.elemento && <small className="tabla-elemento">{tarea.elemento}</small>}
                              </td>
                              <td className="cal-soft">{tarea.frecuencia_informativa ?? "—"}</td>
                              <td>
                                <div className="dias-chips">
                                  {tarea.dias.map((dia) => {
                                    const fecha = iso(anio, mes, dia);
                                    const registro = registros.get(dia);
                                    const futuro = fecha > hoyISO;
                                    const ajeno = Boolean(registro) && !(datos.puede_gestionar || registro!.usuario_id === userId);
                                    const deshabilitado = pendiente === `${tarea.faena_id}-${dia}` || futuro || ajeno;
                                    const titulo = `${formatFecha(fecha)} · ${registro ? `hecha por ${registro.usuario}` : "sin marcar"}`
                                      + (futuro ? " · todavía no se puede marcar" : registro ? " · pulsa para desmarcar" : " · pulsa para marcar");
                                    return <button
                                      key={dia}
                                      type="button"
                                      className={"dia-chip" + (esFinde(anio, mes, dia) ? " weekend" : "") + (festivos.has(fecha) ? " holiday" : "") + (registro ? " done" : "") + (futuro ? " future" : "")}
                                      disabled={deshabilitado}
                                      onClick={() => void alternar(tarea.faena_id, dia, !registro)}
                                      title={titulo}
                                      aria-pressed={Boolean(registro)}
                                      aria-label={titulo}
                                    >{registro ? "✓" : dia}</button>;
                                  })}
                                </div>
                              </td>
                              <td className="right">{formatNum(tarea.registros.length)}/{formatNum(tarea.dias.length)}</td>
                            </tr>;
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>;
                })}

                <div className="tabla-bloque extras">
                  <div className="tabla-bloque-head">
                    <h4>Extras · frecuencia mayor de 32 días</h4>
                    <span>{formatNum(t.extras.length)} tareas fuera de las tablas de frecuencia</span>
                  </div>
                  {!t.extras.length
                    ? <p className="tablas-vacio">Este turno no tiene tareas de más de 32 días.</p>
                    : <div className="tabla-bloque-scroll">
                      <table className="tabla-frec tabla-extras">
                        <thead>
                          <tr>
                            <th className="tabla-th-tarea">Tarea</th>
                            <th>Frecuencia</th>
                            <th>Última</th>
                            <th>Próxima</th>
                            <th>Este mes</th>
                            <th className="right">Marcar</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.extras.map((extra) => {
                            const registro = extra.registro;
                            const futuro = Boolean(extra.dia && iso(anio, mes, extra.dia) > hoyISO);
                            return <tr key={extra.plan_id}>
                              <td className="tabla-tarea">
                                <strong>{nombreTarea(extra)}</strong>
                                {extra.elemento && <small className="tabla-elemento">{extra.elemento}</small>}
                              </td>
                              <td className="cal-soft">{extra.frecuencia_informativa ?? extra.frecuencia_calculo}</td>
                              <td className="cal-soft">{extra.ultima_realizacion ? formatFecha(extra.ultima_realizacion) : "—"}</td>
                              <td className="cal-soft">{extra.proxima_fecha ? formatFecha(extra.proxima_fecha) : "—"}</td>
                              <td>
                                {registro
                                  ? <span className="badge ok">✓ día {extra.dia}</span>
                                  : extra.faena_id && extra.dia
                                    ? <span className="badge info">Día {extra.dia}</span>
                                    : extra.toca_este_mes
                                      ? <span className="badge warn">Genera el mes</span>
                                      : <span className="badge muted">No toca</span>}
                              </td>
                              <td className="right">
                                {extra.faena_id && extra.dia
                                  ? <button
                                    type="button"
                                    className={"btn small " + (registro ? "secondary" : "")}
                                    disabled={pendiente === `${extra.faena_id}-${extra.dia}` || futuro}
                                    onClick={() => void alternar(extra.faena_id!, extra.dia!, !registro)}
                                    title={futuro ? "Todavía no se puede marcar" : registro ? "Deshacer la marca" : "Marcar como realizada"}
                                  >{registro ? "Desmarcar" : "Marcar"}</button>
                                  : <span className="muted">—</span>}
                              </td>
                            </tr>;
                          })}
                        </tbody>
                      </table>
                    </div>}
                </div>
              </section>;
            })}
          </>}
      </div>
    </div>

    {datos && <div className="print-only tablas-print">
      <div className="print-head">
        <h1>Plan de higiene · {datos.centro.nombre}</h1>
        <p>{mesTexto} · tablas por turno y frecuencia · los extras son las tareas de más de 32 días</p>
      </div>
      {datos.turnos.map((t) => {
        return <section className="print-turno" key={t.turno}>
          <h2>Turno de {t.etiqueta.toLowerCase()}</h2>
          {t.bloques.map((bloque) => <Fragment key={String(bloque.dias)}>
            <h3 className="print-bloque">{bloque.etiqueta} · {bloque.tareas.length} tareas</h3>
            <table className="print-table">
              <thead>
                <tr>
                  <th className="print-task">Tarea</th>
                  <th className="print-frec">Frecuencia</th>
                  {numerosDia.map((dia) => <th key={dia} className={"print-dia" + (esFinde(anio, mes, dia) ? " weekend" : "")}>{dia}</th>)}
                  <th className="print-total">Hecho</th>
                </tr>
              </thead>
              <tbody>
                {bloque.tareas.map((tarea) => {
                  const hechos = new Set(tarea.registros.map((r) => r.dia));
                  return <tr key={tarea.faena_id}>
                    <td className="print-task">
                      <strong>{nombreTarea(tarea)}</strong>{tarea.elemento ? ` · ${tarea.elemento}` : ""}
                    </td>
                    <td className="print-frec">{tarea.frecuencia_informativa ?? "—"}</td>
                    {numerosDia.map((dia) => <td key={dia} className={"print-dia" + (esFinde(anio, mes, dia) ? " weekend" : "") + (festivos.has(iso(anio, mes, dia)) ? " holiday" : "")}>
                      {hechos.has(dia) ? "✓" : tarea.dias.includes(dia) ? "·" : ""}
                    </td>)}
                    <td className="print-total">{tarea.registros.length}/{tarea.dias.length}</td>
                  </tr>;
                })}
              </tbody>
            </table>
          </Fragment>)}
          <table className="print-table print-extras">
            <thead>
              <tr><th className="print-task">Extras (más de 32 días)</th><th className="print-frec">Frecuencia</th><th>Última</th><th>Próxima</th><th>Hecha</th></tr>
            </thead>
            <tbody>
              {t.extras.length
                ? t.extras.map((e) => <tr key={e.plan_id}>
                  <td className="print-task"><strong>{nombreTarea(e)}</strong>{e.elemento ? ` · ${e.elemento}` : ""}</td>
                  <td className="print-frec">{e.frecuencia_informativa ?? e.frecuencia_calculo}</td>
                  <td>{e.ultima_realizacion ? formatFecha(e.ultima_realizacion) : "—"}</td>
                  <td>{e.proxima_fecha ? formatFecha(e.proxima_fecha) : "—"}</td>
                  <td>{e.registro ? `✓ día ${e.dia}` : e.toca_este_mes ? (e.dia ? `día ${e.dia}` : "toca este mes") : "no toca"}</td>
                </tr>)
                : <tr><td colSpan={5} className="print-vacio">Sin tareas de más de 32 días en este turno.</td></tr>}
            </tbody>
          </table>
        </section>;
      })}
      <p className="print-foot">Insuma · {datos.centro.nombre} · {mesTexto} · impreso el {formatFecha(new Date().toISOString().slice(0, 10))}</p>
    </div>}
  </>;
}
