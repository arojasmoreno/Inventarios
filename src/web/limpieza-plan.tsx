import { useEffect, useState } from "react";
import { api } from "./api";
import { descargarPlantilla, leerPlanExcel, type PlanLeido } from "./plan-excel";
import { Modal, formatFecha, formatNum } from "./ui";

interface Centro { id: number; nombre: string; }
interface PlanTarea {
  id: number;
  tipo_limpieza: string | null;
  zona: string;
  subzona: string | null;
  tipo_zona: string | null;
  elemento: string | null;
  frecuencia_calculo: string;
  frecuencia_informativa: string | null;
  turno: string;
  auditable: number;
  fecha_inicio: string | null;
  ultima_realizacion: string | null;
  proxima_fecha: string | null;
}
interface RespPlan { tareas: PlanTarea[]; total: number; puede_gestionar: boolean; }
interface RespImportar { insertadas: number; actualizadas: number; eliminadas: number; errores: Array<{ fila: number; mensaje: string }>; }

const ETIQUETA_TURNO: Record<string, string> = { dia: "Día", tarde: "Tarde", noche: "Noche" };

/** Carga masiva del plan de higiene de un centro: Excel, plantilla y
 *  generación del calendario del mes a partir de las frecuencias. */
export function PlanHigieneModal({ centro, anio, mes, mesTexto, centros, onClose, onGenerado }: {
  centro: Centro;
  anio: number;
  mes: number;
  mesTexto: string;
  centros: Centro[];
  onClose: () => void;
  onGenerado: (mensaje: string) => void;
}) {
  const [archivo, setArchivo] = useState<File | null>(null);
  const [leido, setLeido] = useState<PlanLeido | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [importando, setImportando] = useState(false);
  const [generando, setGenerando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<RespImportar | null>(null);
  const [plan, setPlan] = useState<RespPlan | null>(null);
  const [cargandoPlan, setCargandoPlan] = useState(true);

  const cargarPlan = async () => {
    setCargandoPlan(true);
    try {
      const r = await api.get<RespPlan>(`/api/limpieza/plan?centro_id=${centro.id}`);
      setPlan(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo cargar el plan del centro");
    } finally {
      setCargandoPlan(false);
    }
  };

  useEffect(() => { void cargarPlan(); }, [centro.id]);

  const elegirArchivo = async (file: File | null) => {
    setArchivo(file);
    setLeido(null);
    setResultado(null);
    setError(null);
    if (!file) return;
    setLeyendo(true);
    try {
      const r = await leerPlanExcel(file, centros);
      setLeido(r);
      if (r.errores.length) setError(`No se puede importar: ${r.errores.length} fila${r.errores.length === 1 ? "" : "s"} con problemas.`);
    } catch (e) {
      setError(e instanceof Error ? `No se pudo leer el archivo: ${e.message}` : "No se pudo leer el archivo");
    } finally {
      setLeyendo(false);
    }
  };

  const importar = async () => {
    if (!leido || !leido.filas.length) return;
    setImportando(true);
    setError(null);
    try {
      const r = await api.post<RespImportar>("/api/limpieza/plan/importar", { filas: leido.filas });
      setResultado(r);
      setLeido(null);
      setArchivo(null);
      await cargarPlan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo importar el plan");
    } finally {
      setImportando(false);
    }
  };

  const generar = async () => {
    setGenerando(true);
    setError(null);
    try {
      const r = await api.post<{ faenas_creadas: number; faenas_actualizadas: number; dias: number; omitidas: Array<{ zona: string; frecuencia_calculo: string }> }>(
        "/api/limpieza/plan/generar", { centro_id: centro.id, anio, mes },
      );
      const total = r.faenas_creadas + r.faenas_actualizadas;
      const aviso = r.omitidas.length ? ` (${r.omitidas.length} sin frecuencia reconocida)` : "";
      onGenerado(`Calendario de ${mesTexto}: ${total} faenas y ${formatNum(r.dias)} días programados${aviso}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo generar el calendario");
    } finally {
      setGenerando(false);
    }
  };

  const errores = leido?.errores ?? [];
  const avisos = leido?.avisos ?? [];
  const turnosDelPlan = ["dia", "tarde", "noche"]
    .map((t) => ({ turno: t, total: (plan?.tareas ?? []).filter((x) => x.turno === t).length }))
    .filter((t) => t.total > 0);

  return <Modal
    title="Plan de higiene"
    subtitle={`${centro.nombre} · calendario de ${mesTexto}`}
    onClose={onClose}
    wide
  >
    {error && <div className="form-error">{error}</div>}

    <section className="plan-step">
      <h3>1. Cargar el plan desde Excel</h3>
      <p className="plan-help">
        Una fila por tarea. Columnas: <code>cliente</code> (centro), <code>tipo de limpieza</code>,
        <code>centro</code> (zona), <code>zona</code> (subzona), <code>tipo de zona</code>, <code>elemento</code>,
        <code>frecuencia_calculo</code>, <code>frecuencia_informativa</code>, <code>tiempo</code>, <code>factor</code>,
        <code>horas semana</code>, <code>turno</code>, <code>auditable</code>, <code>fecha inicio</code>,
        <code>fecha última realización</code> y <code>fecha proxima_fecha</code>.
        La próxima fecha se calcula como <strong>última realización + frecuencia de cálculo</strong>.
      </p>
      <div className="plan-actions">
        <input
          className="input"
          type="file"
          accept=".xlsx,.xls,.csv"
          aria-label="Archivo del plan de higiene"
          onChange={(e) => void elegirArchivo(e.target.files?.[0] ?? null)}
        />
        <button type="button" className="btn secondary" onClick={() => void descargarPlantilla()}>⬇️ Plantilla</button>
      </div>

      {leyendo && <p className="plan-help">Leyendo {archivo?.name}…</p>}
      {leido && !leyendo && <div className="plan-preview">
        <strong>{formatNum(leido.filas.length)} tareas listas</strong>
        {archivo && <span> · {archivo.name}</span>}
        {avisos.length > 0 && <ul className="plan-avisos">{avisos.map((a) => <li key={a}>⚠️ {a}</li>)}</ul>}
        {errores.length > 0 && <ul className="plan-errores">
          {errores.slice(0, 8).map((e) => <li key={`${e.fila}-${e.mensaje}`}>Fila {e.fila}: {e.mensaje}</li>)}
          {errores.length > 8 && <li>… y {errores.length - 8} más</li>}
        </ul>}
        <button type="button" className="btn" disabled={importando || !leido.filas.length || errores.length > 0} onClick={() => void importar()}>
          {importando ? "Importando…" : `Importar ${formatNum(leido.filas.length)} tareas`}
        </button>
      </div>}

      {resultado && <p className="plan-ok">
        ✅ {formatNum(resultado.insertadas)} nuevas, {formatNum(resultado.actualizadas)} actualizadas y {formatNum(resultado.eliminadas)} quitadas.
        {resultado.errores.length > 0 && ` ${resultado.errores.length} filas con error.`}
      </p>}
    </section>

    <section className="plan-step">
      <h3>2. Generar el calendario de {mesTexto}</h3>
      <p className="plan-help">
        {cargandoPlan ? "Cargando el plan del centro…"
          : plan && plan.total > 0
            ? `El plan de ${centro.nombre} tiene ${formatNum(plan.total)} tareas${turnosDelPlan.length ? ` (${turnosDelPlan.map((t) => `${ETIQUETA_TURNO[t.turno]}: ${t.total}`).join(" · ")})` : ""}.`
            : "Este centro todavía no tiene plan cargado."}
      </p>
      {plan && plan.total > 0 && <button type="button" className="btn" onClick={() => void generar()} disabled={generando || !plan.puede_gestionar}>
        {generando ? "Generando…" : `🗓️ Generar ${mesTexto} desde el plan`}
      </button>}
      {plan && plan.total > 0 && <p className="plan-help">
        Crea las faenas de cada turno con los días que toca según la frecuencia. No borra los días ya programados.
      </p>}
    </section>

    {plan && plan.total > 0 && <section className="plan-step">
      <h3>Tareas del plan</h3>
      <div className="plan-table-wrap">
        <table className="plan-table">
          <thead><tr>
            <th>Zona</th><th>Subzona</th><th>Elemento</th><th>Frecuencia</th><th>Turno</th><th>Próxima</th><th>Última</th>
          </tr></thead>
          <tbody>
            {plan.tareas.map((t) => <tr key={t.id}>
              <td>{t.zona}</td>
              <td>{t.subzona ?? "—"}</td>
              <td>{t.elemento ?? "—"}</td>
              <td>{t.frecuencia_calculo}</td>
              <td>{ETIQUETA_TURNO[t.turno] ?? t.turno}</td>
              <td>{formatFecha(t.proxima_fecha)}</td>
              <td>{formatFecha(t.ultima_realizacion)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>}

    <div className="modal-footer">
      <button type="button" className="btn secondary" onClick={onClose}>Cerrar</button>
    </div>
  </Modal>;
}
