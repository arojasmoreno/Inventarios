// Cálculo de la reposición de un producto del catálogo a partir del stock que
// hay en «Material de limpieza» (por código) y de su mínimo configurado.
//
// Vive fuera de los componentes para poder probarlo: el alta del pedido solo
// rellena los campos del formulario con lo que devuelve esta función.

type Fila = Record<string, unknown>;

const numero = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Unidades que faltan para llegar al mínimo: la diferencia redondeada hacia
 *  arriba y nunca menos de 1 (si no hay mínimo, no se propone nada). */
export function faltanteHastaMinimo(stock: unknown, minimo: unknown): number {
  const min = numero(minimo);
  if (min <= 0) return 0;
  const falta = min - numero(stock);
  return falta > 0 ? Math.ceil(falta) : 0;
}

/** Cantidades sugeridas por id de producto: solo los que están en el mínimo o
 *  por debajo. Se usa para rellenar de una vez el pedido de un proveedor. */
export function sugerenciasReposicion(productos: Fila[]): Record<string, string> {
  const salida: Record<string, string> = {};
  for (const p of productos) {
    const cantidad = faltanteHastaMinimo(p.unidades_almacen, p.stock_minimo);
    if (cantidad > 0) salida[String(p.id)] = String(cantidad);
  }
  return salida;
}

/** Productos del proveedor que están en el mínimo o por debajo. */
export function bajoMinimo(productos: Fila[]): Fila[] {
  return productos.filter((p) => faltanteHastaMinimo(p.unidades_almacen, p.stock_minimo) > 0);
}
