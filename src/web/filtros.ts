import { useCallback, useState } from "react";

// Filtros de los informes que sobreviven a una recarga: se guardan en
// localStorage y se leen al montar el componente, de forma que la planta, el
// origen y el periodo elegidos no se pierdan al volver a la pestaña.
const leer = (clave: string): string => {
  try { return window.localStorage.getItem(clave) ?? ""; } catch { return ""; }
};
const guardar = (clave: string, valor: string): void => {
  try {
    if (valor) window.localStorage.setItem(clave, valor);
    else window.localStorage.removeItem(clave);
  } catch { /* almacenamiento no disponible (modo privado) */ }
};

export function useFiltroPersistido(clave: string, inicial: string): [string, (valor: string) => void] {
  const [valor, setValor] = useState<string>(() => leer(clave) || inicial);
  const set = useCallback((v: string) => { setValor(v); guardar(clave, v === inicial ? "" : v); }, [clave, inicial]);
  return [valor, set];
}

export interface PeriodoPersistido {
  desde: string;
  hasta: string;
  activo: boolean;
  etiqueta: string;
  setDesde: (valor: string) => void;
  setHasta: (valor: string) => void;
  limpiar: () => void;
}

export function usePeriodoPersistido(clave: string): PeriodoPersistido {
  const [desde, setDesdeEstado] = useState<string>(() => leer(`${clave}.desde`));
  const [hasta, setHastaEstado] = useState<string>(() => leer(`${clave}.hasta`));
  const setDesde = useCallback((v: string) => { setDesdeEstado(v); guardar(`${clave}.desde`, v); }, [clave]);
  const setHasta = useCallback((v: string) => { setHastaEstado(v); guardar(`${clave}.hasta`, v); }, [clave]);
  const limpiar = useCallback(() => {
    setDesdeEstado(""); setHastaEstado("");
    guardar(`${clave}.desde`, ""); guardar(`${clave}.hasta`, "");
  }, [clave]);
  const etiqueta = desde && hasta ? `${desde} a ${hasta}` : desde ? `desde ${desde}` : hasta ? `hasta ${hasta}` : "todo el histórico";
  return { desde, hasta, activo: Boolean(desde || hasta), etiqueta, setDesde, setHasta, limpiar };
}
