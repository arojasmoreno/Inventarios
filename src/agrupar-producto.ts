export interface ProductoGrupo {
  clave: string;
  producto: string;
  marca: string;
  lotes: unknown[];
}

export function agrupar(lotes: unknown[]): ProductoGrupo[] {
  const map = new Map<string, ProductoGrupo>();
  for (const l of lotes) {
    const nombre = String((l as Record<string, unknown>)?.nombre ?? "");
    const marca = String((l as Record<string, unknown>)?.marca ?? "");
    const clave = `${nombre.trim().toLowerCase()}|${marca.trim().toLowerCase()}`;
    if (!map.has(clave)) {
      map.set(clave, { clave, producto: nombre, marca, lotes: [] });
    }
    map.get(clave)!.lotes.push(l);
  }
  return [...map.values()]
    .sort((a, b) => a.producto.localeCompare(b.producto, "es") || a.marca.localeCompare(b.marca, "es"));
}
