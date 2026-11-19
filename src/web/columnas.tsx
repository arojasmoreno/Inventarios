import { useCallback, useState } from "react";
import { formatNum } from "./ui";

/** Una columna que el usuario puede enseñar u ocultar en una tabla. */
export interface Columna {
  key: string;
  label: string;
}

/** Columnas guardadas en este navegador; si no hay ninguna válida, las de siempre. */
function leerColumnas(clave: string, todas: Columna[], porDefecto: string[]): string[] {
  try {
    const crudo = window.localStorage.getItem(clave);
    if (!crudo) return porDefecto;
    const leido: unknown = JSON.parse(crudo);
    if (!Array.isArray(leido)) return porDefecto;
    const validas = todas.filter((c) => leido.includes(c.key)).map((c) => c.key);
    return validas.length ? validas : porDefecto;
  } catch {
    return porDefecto;
  }
}

/** Estado de las columnas visibles de una tabla, recordado en el navegador.
 *  Nunca se queda sin columnas: siempre hay al menos una marcada. */
export function useColumnas<T extends Columna>(todas: T[], clave: string, porDefecto: string[]) {
  const [elegidas, setElegidas] = useState<string[]>(() => leerColumnas(clave, todas, porDefecto));
  const visibles = todas.filter((c) => elegidas.includes(c.key));

  const cambiar = useCallback((siguiente: string[]) => {
    const ordenadas = todas.filter((c) => siguiente.includes(c.key)).map((c) => c.key);
    if (!ordenadas.length) return;
    setElegidas(ordenadas);
    try { window.localStorage.setItem(clave, JSON.stringify(ordenadas)); } catch { /* almacenamiento no disponible */ }
  }, [clave, todas]);

  return { elegidas, visibles, cambiar };
}

/** Botón «🧩 Columnas» con la lista de casillas de una tabla. */
export function SelectorColumnas({ todas, elegidas, porDefecto, onChange, ariaLabel, resumen, etiqueta }: {
  todas: Columna[];
  elegidas: string[];
  porDefecto: string[];
  onChange: (siguiente: string[]) => void;
  ariaLabel: string;
  /** Texto corto del panel, p. ej. «Columnas de extras». */
  resumen?: string;
  /** Nombre del botón cuando hay varios selectores en la misma pantalla. */
  etiqueta?: string;
}) {
  return <details className="plan-cols">
    <summary className="btn secondary small">
      🧩 {etiqueta ?? "Columnas"} ({formatNum(elegidas.length)}/{formatNum(todas.length)})
    </summary>
    <div className="plan-cols-panel" role="group" aria-label={ariaLabel}>
      <div className="plan-cols-head">
        <strong>{resumen ?? "Columnas a mostrar"}</strong>
        <button type="button" className="btn secondary small"
          onClick={() => onChange(todas.map((c) => c.key))}>Todas</button>
        <button type="button" className="btn secondary small"
          onClick={() => onChange(porDefecto)}>Restablecer</button>
      </div>
      <div className="plan-cols-grid">
        {todas.map((c) => <label key={c.key} className="plan-cols-item">
          <input
            type="checkbox"
            checked={elegidas.includes(c.key)}
            onChange={(e) => onChange(e.target.checked
              ? [...elegidas, c.key]
              : elegidas.filter((k) => k !== c.key))}
          />
          <span>{c.label}</span>
        </label>)}
      </div>
      <p className="plan-cols-note">Se guarda en este navegador.</p>
    </div>
  </details>;
}
