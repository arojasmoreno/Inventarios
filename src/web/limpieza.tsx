import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api } from "./api";
import { Modal, Toast, formatFecha, formatNum } from "./ui";
import { PlanHigieneModal, type PlanTarea, type RespPlan } from "./limpieza-plan";


import { TablasMes } from "./limpieza-tablas";
import { CumplimientoMes } from "./limpieza-cumplimiento";

type Turno = "dia" | "tarde" | "noche";
type Modo = "planificar" | "marcar";
type Vista = "calendario" | "tablas" | "cumplimiento" | "plan";

interface Usuario { id: number; nombre: string; rol: string; }
interface Centro { id: number; nombre: string; }
interface Registro { dia: number; usuario_id: number; usuario: string; creado: string; }
interface Faena {
  id: number;
  zona: string;
  subzona: string | null;
  frecuencia_informativa: string | null;
  elemento?: string | null;
  tipo_limpieza?: string | null;
  dias: number[];
  registros: Registro[];
}
interface Calendario {
  centro: Centro;
  anio: number;
  mes: number;
  turno: Turno;
  dias_mes: number;
  festivos: string[];
  faenas: Faena[];
  zonas: string[];
  subzonas: Array<{ zona: string; nombre: string }>;
  puede_gestionar: boolean;
}
interface RespCentros {
  centros: Centro[];
  puede_gestionar: boolean;
  rol: string;
}

const TURNOS: Array<{ id: Turno; label: string; icon: string }> = [
  { id: "dia", label: "Día", icon: "☀️" },
  { id: "tarde", label: "Tarde", icon: "🌤️" },
  { id: "noche", label: "Noche", icon: "🌙" },
];
const ETIQUETA_TURNO: Record<Turno, string> = { dia: "Día", tarde: "Tarde", noche: "Noche" };
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS_SEMANA = ["L", "M", "X", "J", "V", "S", "D"];
const NOMBRES_SEMANA = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];

const pad = (n: number): string => String(n).padStart(2, "0");
const capitalizar = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const iso = (anio: number, mes: number, dia: number): string => `${anio}-${pad(mes)}-${pad(dia)}`;
const nombreMes = (anio: number, mes: number): string => `${MESES[mes - 1]} ${anio}`;
const diasDelMes = (anio: number, mes: number): number => new Date(anio, mes, 0).getDate();
const indiceSemana = (anio: number, mes: number, dia: number): number => (new Date(anio, mes - 1, dia).getDay() + 6) % 7;
const esFinde = (anio: number, mes: number, dia: number): boolean => indiceSemana(anio, mes, dia) >= 5;
const fechaHoy = (): { anio: number; mes: number; dia: number; iso: string } => {
  const d = new Date();
  return { anio: d.getFullYear(), mes: d.getMonth() + 1, dia: d.getDate(), iso: iso(d.getFullYear(), d.getMonth() + 1, d.getDate()) };
};

// Columnas que se pueden mostrar en la tabla del plan de higiene: cada una es
// un campo de `limpieza_plan`, en el orden en que se pintan.
interface ColumnaPlan { key: string; label: string; valor: (t: PlanTarea) => string }
const COLUMNAS_PLAN: ColumnaPlan[] = [
  { key: "zona", label: "Zona", valor: (t) => t.zona },
  { key: "subzona", label: "Subzona", valor: (t) => t.subzona ?? "—" },
  { key: "tipo_limpieza", label: "Tipo de limpieza", valor: (t) => t.tipo_limpieza ?? "—" },
  { key: "tipo_zona", label: "Tipo de zona", valor: (t) => t.tipo_zona ?? "—" },
  { key: "elemento", label: "Elemento", valor: (t) => t.elemento ?? "—" },
  { key: "frecuencia_calculo", label: "Frecuencia de cálculo", valor: (t) => t.frecuencia_calculo },
  { key: "frecuencia_informativa", label: "Frecuencia informativa", valor: (t) => t.frecuencia_informativa ?? "—" },
  { key: "tiempo", label: "Tiempo", valor: (t) => (t.tiempo == null ? "—" : formatNum(t.tiempo, 2)) },
  { key: "factor", label: "Factor", valor: (t) => (t.factor == null ? "—" : formatNum(t.factor, 2)) },
  { key: "horas_semana", label: "Horas/semana", valor: (t) => (t.horas_semana == null ? "—" : formatNum(t.horas_semana, 2)) },
  { key: "turno", label: "Turno", valor: (t) => capitalizar(t.turno) || "—" },
  { key: "auditable", label: "Auditable", valor: (t) => (Number(t.auditable) === 1 ? "Sí" : "No") },
  { key: "fecha_inicio", label: "Fecha de inicio", valor: (t) => formatFecha(t.fecha_inicio) },
  { key: "ultima_realizacion", label: "Última realización", valor: (t) => formatFecha(t.ultima_realizacion) },
  { key: "proxima_fecha", label: "Próxima fecha", valor: (t) => formatFecha(t.proxima_fecha) },
];
const COLUMNAS_PLAN_POR_DEFECTO = ["zona", "subzona", "tipo_limpieza", "frecuencia_calculo"];
const COLUMNAS_PLAN_CLAVE = "limpieza:plan:columnas";

/** Columnas guardadas por el usuario; si no hay ninguna válida, las de siempre. */
function columnasPlanGuardadas(): string[] {
  try {
    const crudo = window.localStorage.getItem(COLUMNAS_PLAN_CLAVE);
    if (!crudo) return COLUMNAS_PLAN_POR_DEFECTO;
    const leido: unknown = JSON.parse(crudo);
    if (!Array.isArray(leido)) return COLUMNAS_PLAN_POR_DEFECTO;
    const validas = COLUMNAS_PLAN.filter((c) => leido.includes(c.key)).map((c) => c.key);
    return validas.length ? validas : COLUMNAS_PLAN_POR_DEFECTO;
  } catch {
    return COLUMNAS_PLAN_POR_DEFECTO;
  }
}

function recargarCentroGuardado(): number | null {
  try {
    const valor = Number(window.localStorage.getItem("limpieza:centro"));
    return Number.isInteger(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

/** Sección «Limpieza»: calendario mensual de faenas por centro y turno. */
export function LimpiezaPage({ user }: { user: Usuario }) {
  const hoy = fechaHoy();
  const [centros, setCentros] = useState<Centro[]>([]);
  const [centroId, setCentroId] = useState<number | null>(null);
  const [gestionInicial, setGestionInicial] = useState(user.rol !== "usuario");
  const [cargandoCentros, setCargandoCentros] = useState(true);
  const [errorCentros, setErrorCentros] = useState<string | null>(null);
  const [anio, setAnio] = useState(hoy.anio);
  const [mes, setMes] = useState(hoy.mes);
  const [turno, setTurno] = useState<Turno>("dia");
  const [vista, setVista] = useState<Vista>("calendario");
  const [planFiltro, setPlanFiltro] = useState<{ zona: string; subzona: string; frecuencia: string }>({ zona: "", subzona: "", frecuencia: "" });
  const [planTareas, setPlanTareas] = useState<PlanTarea[]>([]);
  const [planTotal, setPlanTotal] = useState(0);
  const [planCargando, setPlanCargando] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [planVersion, setPlanVersion] = useState(0);
  const [columnasPlan, setColumnasPlan] = useState<string[]>(columnasPlanGuardadas);
  const columnasVisibles = COLUMNAS_PLAN.filter((c) => columnasPlan.includes(c.key));
  // Nunca se queda sin columnas: la tabla siempre muestra al menos una.
  const cambiarColumnasPlan = (siguiente: string[]) => {
    const ordenadas = COLUMNAS_PLAN.filter((c) => siguiente.includes(c.key)).map((c) => c.key);
    if (!ordenadas.length) return;
    setColumnasPlan(ordenadas);
    try { window.localStorage.setItem(COLUMNAS_PLAN_CLAVE, JSON.stringify(ordenadas)); } catch { /* almacenamiento no disponible */ }
  };
  const [cal, setCal] = useState<Calendario | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [modo, setModo] = useState<Modo>(user.rol === "usuario" ? "marcar" : "planificar");
  const [faenaModal, setFaenaModal] = useState<Faena | "nueva" | null>(null);
  const [festivosModal, setFestivosModal] = useState(false);
  const [planModal, setPlanModal] = useState(false);
  const [pendientes, setPendientes] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  const centroActual = centros.find((c) => c.id === centroId) ?? null;
  const puedeGestionar = cal?.puede_gestionar ?? gestionInicial;

  useEffect(() => {
    let vivo = true;
    setCargandoCentros(true);
    setErrorCentros(null);
    api.get<RespCentros>("/api/limpieza/centros")
      .then((r) => {
        if (!vivo) return;
        setCentros(r.centros);
        setGestionInicial(r.puede_gestionar);
        if (r.centros.length) {
          setCentroId((prev) => {
            if (prev && r.centros.some((c) => c.id === prev)) return prev;
            const guardado = recargarCentroGuardado();
            return r.centros.find((c) => c.id === guardado)?.id ?? r.centros[0].id;
          });
        }
      })
      .catch((e) => { if (vivo) setErrorCentros(e instanceof Error ? e.message : "No se pudieron cargar los centros"); })
      .finally(() => { if (vivo) setCargandoCentros(false); });
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    if (!centroId) return;
    let vivo = true;
    setCargando(true);
    setError(null);
    const params = new URLSearchParams({
      centro_id: String(centroId), anio: String(anio), mes: String(mes), turno,
    });
    api.get<Calendario>(`/api/limpieza/calendario?${params.toString()}`)
      .then((r) => { if (vivo) setCal(r); })
      .catch((e) => { if (vivo) { setCal(null); setError(e instanceof Error ? e.message : "No se pudo cargar el calendario"); } })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [centroId, anio, mes, turno, version]);

  useEffect(() => {
    if (cal && !cal.puede_gestionar) setModo("marcar");
  }, [cal]);

  const resumen = useMemo(() => {
    const faenas = cal?.faenas ?? [];
    let programadas = 0;
    let completadas = 0;
    let transcurridas = 0;
    let pendientesHoy = 0;
    for (const faena of faenas) {
      const hechas = new Set(faena.registros.map((r) => r.dia));
      programadas += faena.dias.length;
      completadas += faena.registros.length;
      for (const dia of faena.dias) {
        const fecha = iso(anio, mes, dia);
        if (fecha <= hoy.iso) {
          transcurridas++;
          if (!hechas.has(dia)) pendientesHoy++;
        }
      }
    }
    return {
      faenas: faenas.length,
      programadas,
      completadas,
      transcurridas,
      pendientes: pendientesHoy,
      progreso: transcurridas ? Math.min(100, Math.round((completadas / transcurridas) * 100)) : 0,
    };
  }, [cal, anio, mes, hoy.iso]);

  useEffect(() => {
    if (vista !== "plan" || !centroId) return;
    let vivo = true;
    setPlanCargando(true);
    setPlanError(null);
    const params = new URLSearchParams({ centro_id: String(centroId) });
    if (planFiltro.zona.trim()) params.set("zona", planFiltro.zona.trim());
    if (planFiltro.subzona.trim()) params.set("subzona", planFiltro.subzona.trim());
    if (planFiltro.frecuencia.trim()) params.set("frecuencia", planFiltro.frecuencia.trim());
    api.get<RespPlan>(`/api/limpieza/plan?${params.toString()}`)
      .then((r) => { if (vivo) { setPlanTareas(r.tareas); setPlanTotal(r.total); } })
      .catch((e) => { if (vivo) setPlanError(e instanceof Error ? e.message : "No se pudo cargar el plan"); })
      .finally(() => { if (vivo) setPlanCargando(false); });
    return () => { vivo = false; };
  }, [centroId, vista, planFiltro, planVersion]);

  const cambiarMes = (delta: number) => {
    const d = new Date(anio, mes - 1 + delta, 1);
    setAnio(d.getFullYear());
    setMes(d.getMonth() + 1);
    setCal(null);
    setFaenaModal(null);
    setFestivosModal(false);
  };

  const irAHoy = () => {
    setAnio(hoy.anio);
    setMes(hoy.mes);
    setCal(null);
    setFaenaModal(null);
    setFestivosModal(false);
  };

  const elegirCentro = (id: number) => {
    setCentroId(id);
    setCal(null);
    setFaenaModal(null);
    setFestivosModal(false);
    try { window.localStorage.setItem("limpieza:centro", String(id)); } catch { /* almacenamiento no disponible */ }
  };

  const ejecutar = async (clave: string, accion: () => Promise<unknown>, mensaje?: string) => {
    setPendientes((prev) => new Set(prev).add(clave));
    try {
      await accion();
      setVersion((v) => v + 1);
      if (mensaje) setToast({ message: mensaje, kind: "ok" });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : "No se pudo guardar el cambio", kind: "error" });
    } finally {
      setPendientes((prev) => {
        const siguiente = new Set(prev);
        siguiente.delete(clave);
        return siguiente;
      });
    }
  };

  const alternarDia = (faena: Faena, dia: number) => {
    if (!puedeGestionar || modo !== "planificar") return;
    const activo = !faena.dias.includes(dia);
    void ejecutar(`dia-${faena.id}-${dia}`, () => api.post(`/api/limpieza/faenas/${faena.id}/dias`, { dia, activo }));
  };

  const alternarRegistro = (faena: Faena, dia: number, fecha: string, registro: Registro | undefined) => {
    if (modo !== "marcar" || fecha > hoy.iso) return;
    if (registro && !puedeGestionar && registro.usuario_id !== user.id) return;
    void ejecutar(`registro-${faena.id}-${dia}`, () => api.post("/api/limpieza/registros", {
      faena_id: faena.id, dia, hecho: !registro,
    }));
  };

  const faenaGuardada = (mensaje: string) => {
    setFaenaModal(null);
    setVersion((v) => v + 1);
    setToast({ message: mensaje, kind: "ok" });
  };

  const festivosGuardados = (mensaje: string) => {
    setFestivosModal(false);
    setVersion((v) => v + 1);
    setToast({ message: mensaje, kind: "ok" });
  };

  if (cargandoCentros) return <div className="loading">Cargando centros…</div>;
  if (errorCentros) return <div className="card empty">⚠️ {errorCentros}</div>;
  if (!centros.length) {
    return <div className="card empty">
      <span className="icon">🏢</span>
      <strong>No tienes centros asignados</strong>
      <p>{user.rol === "admin" ? "Crea un centro para poder preparar su plan de higiene." : "Pide a un administrador que asocie tu usuario al centro donde trabajas."}</p>
      {user.rol === "admin" && <a className="btn" href="#/gestion-centros">Ir a Gestión de centros</a>}
    </div>;
  }

  const diasMes = diasDelMes(anio, mes);
  const numerosDia = Array.from({ length: diasMes }, (_, i) => i + 1);
  const festivos = new Set(cal?.festivos ?? []);
  const etiquetaTurno = ETIQUETA_TURNO[turno];

  return <>
    <section className={"cal-hero" + (vista === "tablas" ? " no-print" : "")}>
      <div className="cal-hero-main">
        <div className="cal-eyebrow">🧹 Plan de higiene</div>
        <div className="cal-title-row">
          <h2>{capitalizar(nombreMes(anio, mes))}</h2>
          <span className="cal-turno-pill">{TURNOS.find((t) => t.id === turno)?.icon} Turno de {etiquetaTurno.toLowerCase()}</span>
        </div>
        <p className="cal-sub">
          Calendario de faenas de <strong>{centroActual?.nombre ?? cal?.centro.nombre ?? "—"}</strong>. Cada centro y cada turno tienen su propio plan.
        </p>

        <div className="cal-controls">
          <label className="cal-control">
            <span>Centro</span>
            <select className="input cal-select" value={centroId ?? ""} onChange={(e) => elegirCentro(Number(e.target.value))} disabled={centros.length < 2} aria-label="Centro del plan">
              {centros.map((c) => <option key={c.id} value={c.id}>{c.nombre}</option>)}
            </select>
          </label>
          <div className="cal-month">
            <button type="button" className="cal-nav" onClick={() => cambiarMes(-1)} aria-label="Mes anterior">←</button>
            <span>{capitalizar(nombreMes(anio, mes))}</span>
            <button type="button" className="cal-nav" onClick={() => cambiarMes(1)} aria-label="Mes siguiente">→</button>
          </div>
          <button type="button" className="cal-hoy" onClick={irAHoy}>Hoy</button>
        </div>

        <div className="cal-tabs" role="tablist" aria-label="Vista de limpieza">
          <button type="button" role="tab" aria-selected={vista === "calendario"} className={vista === "calendario" ? "active" : ""} onClick={() => setVista("calendario")}>📅 Calendario</button>
          <button type="button" role="tab" aria-selected={vista === "tablas"} className={vista === "tablas" ? "active" : ""} onClick={() => setVista("tablas")}>🗂️ Tablas del mes</button>
          <button type="button" role="tab" aria-selected={vista === "cumplimiento"} className={vista === "cumplimiento" ? "active" : ""} onClick={() => setVista("cumplimiento")}>📈 Cumplimiento</button>
          <button type="button" role="tab" aria-selected={vista === "plan"} className={vista === "plan" ? "active" : ""} onClick={() => setVista("plan")}>📋 Plan de higiene</button>
        </div>

        {vista === "calendario" && <div className="cal-turns" role="group" aria-label="Turno del calendario">
          {TURNOS.map((t) => <button
            key={t.id}
            type="button"
            className={"cal-turn" + (t.id === turno ? " active" : "")}
            aria-pressed={t.id === turno}
            onClick={() => { setTurno(t.id); setCal(null); setFaenaModal(null); setFestivosModal(false); }}
          >
            <span aria-hidden="true">{t.icon}</span>{t.label}
          </button>)}
        </div>}
      </div>

      {vista === "calendario" && <div className="cal-progress-card">
        <div className="cal-progress-top">
          <span>Progreso del mes</span>
          <strong>{resumen.progreso}%</strong>
        </div>
        <div className="cal-progress-bar" aria-hidden="true"><span style={{ width: `${resumen.progreso}%` }} /></div>
        <p>
          {resumen.transcurridas
            ? `${formatNum(resumen.completadas)} de ${formatNum(resumen.transcurridas)} tareas marcadas`
            : "Todavía no hay días programados que marcar"}
        </p>
        <div className="cal-legend">
          <span><i className="cal-key prog" />Programada</span>
          <span><i className="cal-key done" />Realizada</span>
          <span><i className="cal-key holiday" />Festivo</span>
        </div>
      </div>}
    </section>

    {vista === "calendario" && <>
    <div className="kpis cal-kpis">
      <div className="kpi"><div className="label">Faenas</div><div className="value">{formatNum(resumen.faenas)}</div><div className="kpi-sub">en el turno de {etiquetaTurno.toLowerCase()}</div></div>
      <div className="kpi"><div className="label">Días programados</div><div className="value">{formatNum(resumen.programadas)}</div><div className="kpi-sub">en {capitalizar(nombreMes(anio, mes))}</div></div>
      <div className="kpi"><div className="label">Completadas</div><div className="value">{formatNum(resumen.completadas)}</div><div className="kpi-sub">marcadas por los operarios</div></div>
      <div className={"kpi" + (resumen.pendientes > 0 ? " alert" : "")}><div className="label">Pendientes</div><div className="value">{formatNum(resumen.pendientes)}</div><div className="kpi-sub">hasta hoy</div></div>
    </div>

    <div className="card cal-card">
      <div className="cal-toolbar">
        <div className="cal-toolbar-title">
          <h3>Calendario de {etiquetaTurno.toLowerCase()}</h3>
          <p>
            {puedeGestionar && modo === "planificar"
              ? "Haz clic en un día para programarlo o quitarlo. Usa ✎ junto a la zona para editar la faena."
              : "Marca las tareas que vayas realizando. Solo se pueden marcar el día de hoy y los anteriores."}
          </p>
        </div>
        <div className="cal-actions">
          {puedeGestionar && <div className="cal-mode" role="group" aria-label="Modo del calendario">
            <button type="button" className={modo === "planificar" ? "active" : ""} aria-pressed={modo === "planificar"} onClick={() => setModo("planificar")}>✏️ Planificar</button>
            <button type="button" className={modo === "marcar" ? "active" : ""} aria-pressed={modo === "marcar"} onClick={() => setModo("marcar")}>✅ Marcar tareas</button>
          </div>}
          {puedeGestionar && <button type="button" className="btn secondary" onClick={() => setFestivosModal(true)} disabled={!cal || cargando}>🎉 Festivos</button>}
          {puedeGestionar && <button type="button" className="btn secondary" onClick={() => setPlanModal(true)} disabled={!cal || cargando}>📊 Plan de higiene</button>}
          {puedeGestionar && <button type="button" className="btn" onClick={() => setFaenaModal("nueva")} disabled={!cal || cargando}>＋ Añadir faena</button>}
        </div>
      </div>

      {cargando && <div className="cal-loading-bar" role="progressbar" aria-label="Cargando calendario"><span /></div>}

      {error ? <div className="empty">⚠️ {error}</div>
        : !cal ? <div className="loading">Cargando el calendario…</div>
        : !cal.faenas.length ? <div className="empty cal-empty">
          <span className="icon">📋</span>
          <strong>No hay faenas en el turno de {etiquetaTurno.toLowerCase()}</strong>
          <p>{puedeGestionar ? "Crea la primera faena y marca los días en los que hay que realizarla." : "El responsable del centro todavía no ha creado el plan de este turno."}</p>
          {puedeGestionar && <button type="button" className="btn" onClick={() => setFaenaModal("nueva")}>＋ Añadir la primera faena</button>}
        </div>
        : <div className="cal-table-wrap">
          <table className="cal-table">
            <colgroup>
              <col style={{ width: 96 }} />
              <col style={{ width: 128 }} />
              <col style={{ width: 126 }} />
              <col style={{ width: 178 }} />
              {numerosDia.map((dia) => <col key={dia} style={{ width: 36 }} />)}
            </colgroup>
            <thead>
              <tr>
                <th className="cal-sticky cal-col-centro">Centro</th>
                <th className="cal-sticky cal-col-zona">Zona</th>
                <th className="cal-sticky cal-col-sub">Subzona</th>
                <th className="cal-sticky cal-col-frec">Frecuencia informativa</th>
                {numerosDia.map((dia) => {
                  const fecha = iso(anio, mes, dia);
                  const festivo = festivos.has(fecha);
                  const finde = esFinde(anio, mes, dia);
                  const esHoy = fecha === hoy.iso;
                  return <th
                    key={dia}
                    className={"cal-dayhead" + (finde ? " weekend" : "") + (festivo ? " holiday" : "") + (esHoy ? " today" : "")}
                    title={`${NOMBRES_SEMANA[indiceSemana(anio, mes, dia)]} ${dia}${festivo ? " · Festivo" : ""}`}
                  >
                    <span className="cal-dow">{DIAS_SEMANA[indiceSemana(anio, mes, dia)]}</span>
                    <span className="cal-daynum">{dia}</span>
                  </th>;
                })}
              </tr>
            </thead>
            <tbody>
              {cal.faenas.map((faena) => {
                const registros = new Map(faena.registros.map((r) => [r.dia, r]));
                return <tr key={faena.id}>
                  <td className="cal-sticky cal-col-centro cal-soft" title={cal.centro.nombre}>{cal.centro.nombre}</td>
                  <td className="cal-sticky cal-col-zona">
                    <div className="cal-zona-cell">
                      <div className="cal-zona-text">
                        <strong>{faena.zona}</strong>
                        {faena.elemento && <small className="cal-elemento" title={faena.elemento}>{faena.elemento}</small>}
                      </div>
                      {puedeGestionar && <button
                        type="button"
                        className="cal-edit"
                        title={`Editar ${faena.zona}`}
                        aria-label={`Editar ${faena.zona}`}
                        onClick={() => setFaenaModal(faena)}
                      >✎</button>}
                    </div>
                  </td>
                  <td className="cal-sticky cal-col-sub cal-soft" title={faena.subzona ?? undefined}>{faena.subzona ?? "—"}</td>
                  <td className="cal-sticky cal-col-frec cal-soft" title={faena.frecuencia_informativa ?? undefined}>{faena.frecuencia_informativa ?? "—"}</td>
                  {numerosDia.map((dia) => {
                    const fecha = iso(anio, mes, dia);
                    const festivo = festivos.has(fecha);
                    const finde = esFinde(anio, mes, dia);
                    return <td
                      key={dia}
                      className={"cal-daycell" + (finde ? " weekend" : "") + (festivo ? " holiday" : "") + (fecha === hoy.iso ? " today" : "")}
                    >
                      <CeldaDia
                        faena={faena}
                        dia={dia}
                        fecha={fecha}
                        festivo={festivo}
                        hoyISO={hoy.iso}
                        modo={modo}
                        puedeGestionar={puedeGestionar}
                        userId={user.id}
                        registro={registros.get(dia)}
                        pendiente={cargando || pendientes.has(`dia-${faena.id}-${dia}`) || pendientes.has(`registro-${faena.id}-${dia}`)}
                        onPlanificar={() => alternarDia(faena, dia)}
                        onMarcar={() => alternarRegistro(faena, dia, fecha, registros.get(dia))}
                      />
                    </td>;
                  })}
                </tr>;
              })}
            </tbody>
          </table>
        </div>}

      <div className="cal-foot">
        <div className="cal-legend cal-legend-foot">
          <span><i className="cal-key prog" />Programada</span>
          <span><i className="cal-key done" />Realizada</span>
          <span><i className="cal-key holiday" />Festivo</span>
        </div>
        <span className="cal-foot-note">Los festivos se comparten entre los tres turnos del centro.</span>
      </div>
    </div>

    </>}

    {vista === "tablas" && centroActual && <TablasMes
      centro={centroActual}
      anio={anio}
      mes={mes}
      mesTexto={capitalizar(nombreMes(anio, mes))}
      version={version}
      userId={user.id}
      onAviso={(mensaje, kind) => setToast({ message: mensaje, kind: kind ?? "ok" })}
      onAbrirPlan={() => setPlanModal(true)}
    />}

    {vista === "cumplimiento" && centroActual && (
      <CumplimientoMes centro={centroActual} anio={anio} mes={mes} mesTexto={capitalizar(nombreMes(anio, mes))} version={version} />
    )}

    {vista === "plan" && centroActual && (
      <div className="card">
        <div className="cal-toolbar">
          <div className="cal-toolbar-title">
            <h3>Plan de higiene de {centroActual.nombre}</h3>
            <p>Tareas cargadas desde Excel. Busca por zona, subzona o frecuencia de cálculo.</p>
          </div>
          {planCargando && <div className="cal-loading-bar" role="progressbar" aria-label="Cargando plan"><span /></div>}
        </div>

        <div className="plan-buscar">
          <input
            className="input plan-buscar-input"
            type="text"
            placeholder="Filtrar por zona…"
            value={planFiltro.zona}
            onChange={(e) => { setPlanFiltro((p) => ({ ...p, zona: e.target.value })); setPlanVersion((v) => v + 1); }}
            aria-label="Filtrar por zona"
          />
          <input
            className="input plan-buscar-input"
            type="text"
            placeholder="Filtrar por subzona…"
            value={planFiltro.subzona}
            onChange={(e) => { setPlanFiltro((p) => ({ ...p, subzona: e.target.value })); setPlanVersion((v) => v + 1); }}
            aria-label="Filtrar por subzona"
          />
          <input
            className="input plan-buscar-input"
            type="text"
            placeholder="Filtrar por frecuencia…"
            value={planFiltro.frecuencia}
            onChange={(e) => { setPlanFiltro((p) => ({ ...p, frecuencia: e.target.value })); setPlanVersion((v) => v + 1); }}
            aria-label="Filtrar por frecuencia"
          />
          <button
            type="button"
            className="btn secondary small"
            onClick={() => { setPlanFiltro({ zona: "", subzona: "", frecuencia: "" }); setPlanVersion((v) => v + 1); }}
            disabled={!planFiltro.zona && !planFiltro.subzona && !planFiltro.frecuencia}
          >
            Limpiar filtros
          </button>
        </div>
        {/* El panel va fuera de la barra de filtros para que se despliegue en el
            flujo de la tarjeta y no quede recortado por su overflow. */}
        <details className="plan-cols">
          <summary className="btn secondary small">
            🧩 Columnas ({formatNum(columnasVisibles.length)}/{formatNum(COLUMNAS_PLAN.length)})
          </summary>
          <div className="plan-cols-panel" role="group" aria-label="Columnas a mostrar del plan">
            <div className="plan-cols-head">
              <strong>Columnas a mostrar</strong>
              <button type="button" className="btn secondary small"
                onClick={() => cambiarColumnasPlan(COLUMNAS_PLAN.map((c) => c.key))}>Todas</button>
              <button type="button" className="btn secondary small"
                onClick={() => cambiarColumnasPlan(COLUMNAS_PLAN_POR_DEFECTO)}>Restablecer</button>
            </div>
            <div className="plan-cols-grid">
              {COLUMNAS_PLAN.map((c) => <label key={c.key} className="plan-cols-item">
                <input
                  type="checkbox"
                  checked={columnasPlan.includes(c.key)}
                  onChange={(e) => cambiarColumnasPlan(e.target.checked
                    ? [...columnasPlan, c.key]
                    : columnasPlan.filter((k) => k !== c.key))}
                />
                <span>{c.label}</span>
              </label>)}
            </div>
            <p className="plan-cols-note">Se guarda en este navegador.</p>
          </div>
        </details>

        {planError ? <div className="empty">⚠️ {planError}</div>
          : planCargando ? <div className="loading">Cargando el plan…</div>
          : planTotal === 0 ? <div className="empty">
              <span className="icon">📋</span>
              <strong>No hay tareas en el plan de higiene</strong>
              <p>Importa el plan desde Excel o genera el calendario desde el modal de plan.</p>
              {planVersion === 0 && <button type="button" className="btn secondary" onClick={() => setPlanModal(true)}>📊 Cargar plan</button>}
            </div>
          : <div className="plan-table-wrap">
              <table className="plan-table">
                <thead><tr>
                  {columnasVisibles.map((c) => <th key={c.key}>{c.label}</th>)}
                </tr></thead>
                <tbody>
                  {planTareas.map((t) => <tr key={t.id}>
                    {columnasVisibles.map((c) => <td key={c.key}>{c.valor(t)}</td>)}
                  </tr>)}
                </tbody>
              </table>
            </div>}

        {planTotal > 0 && (
          <p className="cal-foot-note">{planTotal} tarea{planTotal === 1 ? "" : "s"} del plan de higiene de {centroActual.nombre}.</p>
        )}
      </div>
    )}

    {faenaModal && centroActual && <FaenaModal
      centro={centroActual}
      anio={anio}
      mes={mes}
      turno={turno}
      faena={faenaModal === "nueva" ? null : faenaModal}
      zonas={cal?.zonas ?? []}
      subzonas={cal?.subzonas ?? []}
      festivos={cal?.festivos ?? []}
      onClose={() => setFaenaModal(null)}
      onSaved={faenaGuardada}
    />}

    {planModal && centroActual && <PlanHigieneModal
      centro={centroActual}
      centros={centros}
      anio={anio}
      mes={mes}
      mesTexto={capitalizar(nombreMes(anio, mes))}
      onClose={() => setPlanModal(false)}
      onGenerado={(mensaje) => {
        setPlanModal(false);
        setVersion((v) => v + 1);
        setToast({ message: mensaje, kind: "ok" });
      }}
    />}

    {festivosModal && centroActual && <FestivosModal
      centro={centroActual}
      anio={anio}
      mes={mes}
      festivos={cal?.festivos ?? []}
      onClose={() => setFestivosModal(false)}
      onSaved={festivosGuardados}
    />}

    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}

function CeldaDia({ faena, dia, fecha, festivo, hoyISO, modo, puedeGestionar, userId, registro, pendiente, onPlanificar, onMarcar }: {
  faena: Faena;
  dia: number;
  fecha: string;
  festivo: boolean;
  hoyISO: string;
  modo: Modo;
  puedeGestionar: boolean;
  userId: number;
  registro: Registro | undefined;
  pendiente: boolean;
  onPlanificar: () => void;
  onMarcar: () => void;
}) {
  const programada = faena.dias.includes(dia);
  const futuro = fecha > hoyISO;
  const esHoy = fecha === hoyISO;
  const base = "cal-cell" + (festivo ? " holiday" : "") + (esHoy ? " today" : "");

  if (modo === "planificar") {
    const titulo = `${formatFecha(fecha)} · ${programada ? "programada" : "sin programar"}${registro ? ` · realizada por ${registro.usuario}` : ""}. Clic para ${programada ? "quitar" : "programar"}.`;
    return <button
      type="button"
      className={base + (programada ? " scheduled" : " add") + (registro ? " done" : "")}
      disabled={pendiente}
      onClick={onPlanificar}
      title={titulo}
      aria-label={titulo}
    >
      {programada ? (registro ? "✓" : "•") : ""}
    </button>;
  }

  if (!programada) return <span className="cal-cell blank" aria-hidden="true" />;
  const puedeDesmarcar = !registro || puedeGestionar || registro.usuario_id === userId;
  const disabled = pendiente || futuro || !puedeDesmarcar;
  let titulo: string;
  if (!registro && futuro) titulo = `${formatFecha(fecha)} · programada; todavía no se puede marcar`;
  else if (registro) {
    titulo = `Realizada por ${registro.usuario}${registro.creado ? ` el ${formatFecha(registro.creado)}` : ""}.`;
    if (!puedeDesmarcar) titulo += " Solo un responsable puede desmarcarla.";
    else titulo += " Clic para desmarcar.";
  } else titulo = `${formatFecha(fecha)} · clic para marcar como realizada`;

  return <button
    type="button"
    className={base + " mark" + (registro ? " done" : " pending") + (futuro ? " future" : "")}
    disabled={disabled}
    onClick={onMarcar}
    title={titulo}
    aria-label={titulo}
    aria-pressed={Boolean(registro)}
  >
    {registro ? "✓" : ""}
  </button>;
}

function FaenaModal({ centro, anio, mes, turno, faena, zonas, subzonas, festivos, onClose, onSaved }: {
  centro: Centro;
  anio: number;
  mes: number;
  turno: Turno;
  faena: Faena | null;
  zonas: string[];
  subzonas: Array<{ zona: string; nombre: string }>;
  festivos: string[];
  onClose: () => void;
  onSaved: (mensaje: string) => void;
}) {
  const editando = Boolean(faena);
  const [zona, setZona] = useState(faena?.zona ?? "");
  const [subzona, setSubzona] = useState(faena?.subzona ?? "");
  const [frecuencia, setFrecuencia] = useState(faena?.frecuencia_informativa ?? "");
  const [dias, setDias] = useState<Set<number>>(() => new Set(faena?.dias ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalDias = diasDelMes(anio, mes);
  const festivosMes = new Set(festivos);
  const zonaNormalizada = zona.trim().toLowerCase();
  const subzonasDeZona = subzonas.filter((s) => !zonaNormalizada || s.zona.trim().toLowerCase() === zonaNormalizada);
  const opcionesSubzona = [...new Set((subzonasDeZona.length ? subzonasDeZona : subzonas).map((s) => s.nombre))];
  const numeros = Array.from({ length: totalDias }, (_, i) => i + 1);

  const alternar = (dia: number) => setDias((prev) => {
    const siguiente = new Set(prev);
    if (siguiente.has(dia)) siguiente.delete(dia);
    else siguiente.add(dia);
    return siguiente;
  });
  const marcarLaborables = () => setDias(new Set(numeros.filter((dia) => !esFinde(anio, mes, dia))));
  const marcarTodos = () => setDias(new Set(numeros));

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!zona.trim()) { setError("La zona es obligatoria"); return; }
    setBusy(true);
    setError(null);
    const body = {
      centro_id: centro.id,
      anio,
      mes,
      turno,
      zona: zona.trim(),
      subzona: subzona.trim() || null,
      frecuencia_informativa: frecuencia.trim() || null,
      dias: [...dias].sort((a, b) => a - b),
    };
    try {
      if (faena) await api.put(`/api/limpieza/faenas/${faena.id}`, body);
      else await api.post("/api/limpieza/faenas", body);
      onSaved(faena ? "Faena actualizada" : "Faena creada");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo guardar la faena");
    } finally {
      setBusy(false);
    }
  };

  const eliminar = async () => {
    if (!faena || !window.confirm(`¿Eliminar la faena «${faena.zona}${faena.subzona ? ` / ${faena.subzona}` : ""}»? También se borrarán sus días y sus marcas.`)) return;
    setBusy(true);
    setError(null);
    try {
      await api.del(`/api/limpieza/faenas/${faena.id}`);
      onSaved("Faena eliminada");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudo eliminar la faena");
    } finally {
      setBusy(false);
    }
  };

  return <Modal
    title={editando ? "Editar faena" : "Nueva faena"}
    subtitle={`${centro.nombre} · turno ${ETIQUETA_TURNO[turno].toLowerCase()} · ${capitalizar(nombreMes(anio, mes))}`}
    onClose={onClose}
  >
    <form onSubmit={(e) => void guardar(e)}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-grid">
        <div className="field full"><label htmlFor="cal-centro">Centro</label><input id="cal-centro" className="input" value={centro.nombre} disabled /></div>
        <div className="field">
          <label htmlFor="cal-zona">Zona <span className="req">*</span></label>
          <input id="cal-zona" className="input" list="cal-zonas" value={zona} onChange={(e) => setZona(e.target.value)} placeholder="Ej. Producción" autoFocus required maxLength={120} />
          <datalist id="cal-zonas">{zonas.map((z) => <option key={z} value={z} />)}</datalist>
        </div>
        <div className="field">
          <label htmlFor="cal-subzona">Subzona</label>
          <input id="cal-subzona" className="input" list="cal-subzonas" value={subzona} onChange={(e) => setSubzona(e.target.value)} placeholder="Ej. Línea 2" maxLength={120} />
          <datalist id="cal-subzonas">{opcionesSubzona.map((s) => <option key={s} value={s} />)}</datalist>
        </div>
        <div className="field full">
          <label htmlFor="cal-frecuencia">Frecuencia informativa</label>
          <input id="cal-frecuencia" className="input" value={frecuencia} onChange={(e) => setFrecuencia(e.target.value)} placeholder="Ej. Diaria, 2 veces por semana, semanal…" maxLength={200} />
          <small>Texto libre para indicar cada cuánto se realiza la faena.</small>
        </div>
      </div>

      <div className="cal-picker-head">
        <div>
          <strong>Días del mes</strong>
          <small>Marca los días en que hay que realizar esta faena.</small>
        </div>
        <div className="cal-quick">
          <button type="button" className="btn secondary small" onClick={marcarLaborables}>L–V</button>
          <button type="button" className="btn secondary small" onClick={marcarTodos}>Todos</button>
          <button type="button" className="btn secondary small" onClick={() => setDias(new Set())}>Limpiar</button>
        </div>
      </div>

      <div className="cal-daypick">
        {numeros.map((dia) => {
          const finde = esFinde(anio, mes, dia);
          const festivo = festivosMes.has(iso(anio, mes, dia));
          return <button
            key={dia}
            type="button"
            className={"cal-pick" + (dias.has(dia) ? " on" : "") + (finde ? " weekend" : "") + (festivo ? " holiday" : "")}
            aria-pressed={dias.has(dia)}
            onClick={() => alternar(dia)}
            title={`${NOMBRES_SEMANA[indiceSemana(anio, mes, dia)]} ${dia}${festivo ? " · Festivo" : ""}`}
          >
            <span>{DIAS_SEMANA[indiceSemana(anio, mes, dia)]}</span>
            <strong>{dia}</strong>
            {festivo && <i className="cal-pick-holiday" aria-hidden="true" />}
          </button>;
        })}
      </div>
      <p className="cal-picker-count">
        {dias.size
          ? `${formatNum(dias.size)} día${dias.size === 1 ? "" : "s"} seleccionado${dias.size === 1 ? "" : "s"}`
          : "Sin días seleccionados: podrás marcarlos después desde el calendario."}
      </p>

      <div className="modal-footer cal-modal-footer">
        {faena ? <button type="button" className="btn danger" onClick={() => void eliminar()} disabled={busy}>🗑️ Eliminar</button> : <span />}
        <div className="cal-footer-actions">
          <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancelar</button>
          <button className="btn" disabled={busy}>{busy ? "Guardando…" : faena ? "Guardar cambios" : "Crear faena"}</button>
        </div>
      </div>
    </form>
  </Modal>;
}

function FestivosModal({ centro, anio, mes, festivos, onClose, onSaved }: {
  centro: Centro;
  anio: number;
  mes: number;
  festivos: string[];
  onClose: () => void;
  onSaved: (mensaje: string) => void;
}) {
  const [seleccion, setSeleccion] = useState<Set<string>>(() => new Set(festivos));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const totalDias = diasDelMes(anio, mes);
  const numeros = Array.from({ length: totalDias }, (_, i) => i + 1);

  const alternar = (fecha: string) => setSeleccion((prev) => {
    const siguiente = new Set(prev);
    if (siguiente.has(fecha)) siguiente.delete(fecha);
    else siguiente.add(fecha);
    return siguiente;
  });

  const guardar = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.put("/api/limpieza/festivos", {
        centro_id: centro.id, anio, mes, fechas: [...seleccion].sort(),
      });
      onSaved("Festivos actualizados");
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron guardar los festivos");
    } finally {
      setBusy(false);
    }
  };

  return <Modal
    title="Días festivos"
    subtitle={`${centro.nombre} · ${capitalizar(nombreMes(anio, mes))}`}
    onClose={onClose}
  >
    {error && <div className="form-error">{error}</div>}
    <p className="cal-modal-help">Marca los días festivos del centro. Se aplicarán a los turnos de día, tarde y noche.</p>
    <div className="cal-daypick festivos">
      {numeros.map((dia) => {
        const fecha = iso(anio, mes, dia);
        const activo = seleccion.has(fecha);
        const finde = esFinde(anio, mes, dia);
        return <button
          key={dia}
          type="button"
          className={"cal-pick" + (activo ? " on holiday-on" : "") + (finde ? " weekend" : "")}
          aria-pressed={activo}
          onClick={() => alternar(fecha)}
          title={`${NOMBRES_SEMANA[indiceSemana(anio, mes, dia)]} ${dia}`}
        >
          <span>{DIAS_SEMANA[indiceSemana(anio, mes, dia)]}</span>
          <strong>{dia}</strong>
        </button>;
      })}
    </div>
    <p className="cal-picker-count">{seleccion.size ? `${formatNum(seleccion.size)} festivo${seleccion.size === 1 ? "" : "s"} seleccionado${seleccion.size === 1 ? "" : "s"}` : "Sin festivos en este mes"}</p>
    <div className="modal-footer">
      <button type="button" className="btn secondary" onClick={onClose} disabled={busy}>Cancelar</button>
      <button type="button" className="btn" onClick={() => void guardar()} disabled={busy}>{busy ? "Guardando…" : "Guardar festivos"}</button>
    </div>
  </Modal>;
}
