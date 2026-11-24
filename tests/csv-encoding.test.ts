import { describe, expect, test } from "bun:test";
import { leerTextoArchivo, normalizarClave } from "../src/web/csv";
import type { Catalogos } from "../src/web/importar";

// El módulo del importador lee `window.location` al cargarse: se simula lo
// mínimo para poder probar el parser sin navegador.
(globalThis as unknown as { window: unknown }).window = { location: { hostname: "localhost" } };
const { parseRow } = await import("../src/web/importar");
const { parseCsv } = await import("../src/web/pedido");

const catalogo = (proveedores: Array<Record<string, unknown>>): Catalogos => ({
  centros: [], proveedores, zonas: [], subzonas: [], usuarios: [], documento_tipos: [], maquinaria: [],
});

describe("codificación de los CSV", () => {
  test("lee un CSV de Excel en Windows-1252 con acentos y ñ", async () => {
    const texto = "Nombre proveedor;Código producto\r\nSuministros García Muñoz, S.L.;M-001\r\n";
    const archivo = new Blob([Buffer.from(texto, "latin1")]);
    const leido = await leerTextoArchivo(archivo);
    expect(leido).toContain("Suministros García Muñoz, S.L.");
    expect(leido).not.toContain("Ã");
  });

  test("lee un CSV UTF-8 con BOM sin dejar el BOM en la primera cabecera", async () => {
    const archivo = new Blob([new TextEncoder().encode("\uFEFFNombre proveedor;Código producto\nSuministros García;M-001")]);
    const leido = await leerTextoArchivo(archivo);
    expect(leido.startsWith("Nombre proveedor")).toBe(true);
    expect(leido).toContain("García");
  });

  test("no estropea un UTF-8 válido con eñes", async () => {
    const archivo = new Blob([new TextEncoder().encode("producto;precio\nLejía Ñandú;3,75")]);
    expect(await leerTextoArchivo(archivo)).toContain("Lejía Ñandú");
  });
});

describe("cotejo de nombres", () => {
  test("ignora acentos, ñ, mayúsculas y puntuación", () => {
    expect(normalizarClave("Suministros García, S.L.")).toBe("suministros garcia sl");
    expect(normalizarClave("SUMINISTROS GARCIA SL")).toBe("suministros garcia sl");
    expect(normalizarClave("Muñoz")).toBe("munoz");
    expect(normalizarClave("  PROV-001 ")).toBe("prov 001");
  });
});

describe("lectura del catálogo en la pestaña Productos disponibles", () => {
  test("con tabuladores, respeta las comas del nombre y del precio", () => {
    const texto = "Codigo proveedor\tNombre proveedor\tCodigo producto\tProducto\tPrecio\n"
      + "2180\tDARLIM, S.L.\tC06001_DAR_CO\tPAPEL HIG. IND. 45x130 (FARDO 18)\t11,69";
    expect(parseCsv(texto)).toEqual([
      ["Codigo proveedor", "Nombre proveedor", "Codigo producto", "Producto", "Precio"],
      ["2180", "DARLIM, S.L.", "C06001_DAR_CO", "PAPEL HIG. IND. 45x130 (FARDO 18)", "11,69"],
    ]);
  });

  test("con punto y coma, no parte el nombre ni el precio por la coma", () => {
    const texto = "Codigo proveedor;Nombre proveedor;Codigo producto;Producto;Precio\n"
      + "4247;DARDALO SL;C07012_DAR_CO;PAPEL 25 MT;15,6";
    expect(parseCsv(texto)[1]).toEqual(["4247", "DARDALO SL", "C07012_DAR_CO", "PAPEL 25 MT", "15,6"]);
  });
});

describe("importación de productos con nombres reales", () => {
  const cat = catalogo([
    { id: 7, id_proveedor: "PROV-001", codigo: "PROV-001", nombre: "Suministros García, S.L." },
    { id: 9, id_proveedor: "PROV-002", codigo: "PROV-002", nombre: "Limpiezas Muñoz" },
  ]);

  test("encuentra al proveedor aunque el CSV escriba el nombre sin tildes", () => {
    const r = parseRow("productos_disponibles", { proveedor: "suministros garcia sl", codigo: "M-001", producto: "Mopa de microfibra", precio: "3,75" }, 2, cat);
    expect(r).toMatchObject({ proveedor_id: 7, codigo: "M-001", producto: "Mopa de microfibra", precio: 3.75 });
  });

  test("encuentra al proveedor por su código", () => {
    const r = parseRow("productos_disponibles", { proveedor: "prov-002", codigo: "M-002", producto: "Bayeta azul" }, 2, cat);
    expect(r).toMatchObject({ proveedor_id: 9 });
  });

  test("acepta la ñ en el nombre del producto", () => {
    const r = parseRow("productos_disponibles", { proveedor: "Limpiezas Muñoz", codigo: "Q-010", producto: "Lejía Ñandú 5 L" }, 2, cat);
    expect(r).toMatchObject({ producto: "Lejía Ñandú 5 L", precio: null });
  });

  test("explica qué revisar si el proveedor no existe", () => {
    const r = parseRow("productos_disponibles", { proveedor: "Proveedor Fantasma", codigo: "X-1", producto: "Algo" }, 2, cat);
    expect(r).toContain("no existe");
    expect(r).toContain("código de proveedor");
  });

  test("entiende el precio con coma o con punto decimal", () => {
    const precio = (v: string) => {
      const r = parseRow("productos_disponibles", { proveedor: "PROV-001", codigo: "M-1", producto: "X", precio: v }, 2, cat);
      return (r as { precio: number }).precio;
    };
    expect(precio("4,50")).toBe(4.5);
    expect(precio("3.75")).toBe(3.75);
    expect(precio("1.234,56")).toBe(1234.56);
    expect(precio("1,234.56")).toBe(1234.56);
    expect(precio("1.234")).toBe(1234);
    expect(precio("8 €")).toBe(8);
  });
});
