export function agrupar(lotes) {
    const map = new Map();
    for (const l of lotes) {
        const nombre = String(l?.nombre ?? "");
        const marca = String(l?.marca ?? "");
        const clave = `${nombre.trim().toLowerCase()}|${marca.trim().toLowerCase()}`;
        if (!map.has(clave)) {
            map.set(clave, { clave, producto: nombre, marca, lotes: [] });
        }
        map.get(clave).lotes.push(l);
    }
    return [...map.values()]
        .sort((a, b) => a.producto.localeCompare(b.producto, "es") || a.marca.localeCompare(b.marca, "es"));
}
