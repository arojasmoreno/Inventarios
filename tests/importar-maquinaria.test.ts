import { describe, expect, test } from "bun:test";
import type { Catalogos } from "../src/web/importar";

// El módulo del importador (y el cliente de API) leen `window.location` al
// cargarse: se simula lo mínimo para poder probar el parser sin navegador.
(globalThis as unknown as { window: unknown }).window = { location: { hostname: "localhost" } };
const { parseRow } = await import("../src/web/importar");

// Catálogos mínimos para probar la plantilla «Cuestionario de máquinas».
const catalogo = (maquinaria: Array<Record<string, unknown>>): Catalogos => ({
  centros: [], proveedores: [], zonas: [], subzonas: [], usuarios: [], documento_tipos: [], maquinaria,
});

const maquinas = [
  { id: 1, nombre: "Fregadora F-80", numero_serie: "F80-0012" },
  { id: 2, nombre: "Monobrocha MB-50", numero_serie: "MB50-0007" },
  { id: 3, nombre: "Monobrocha MB-50", numero_serie: "DUP-0001" },
];

describe("plantilla CSV del cuestionario de máquinas", () => {
  test("resuelve la máquina por nombre único", () => {
    const r = parseRow("maquinaria_checklist", { maquina: "Fregadora F-80", texto: "¿Está limpia?", tipo: "booleano", orden: "1" }, 2, catalogo(maquinas));
    expect(typeof r).toBe("object");
    expect(r).toMatchObject({ maquina_id: 1, texto: "¿Está limpia?", tipo: "booleano", orden: 1 });
  });

  test("resuelve por nº de serie aunque el nombre esté repetido", () => {
    const r = parseRow("maquinaria_checklist", { maquina: "DUP-0001", texto: "Filtro limpio", tipo: "si_no" }, 2, catalogo(maquinas));
    expect(r).toMatchObject({ maquina_id: 3, tipo: "booleano" });
  });

  test("avisa si el nombre está repetido en vez de elegir una máquina al azar", () => {
    const r = parseRow("maquinaria_checklist", { maquina: "Monobrocha MB-50", texto: "Batería" }, 2, catalogo(maquinas));
    expect(typeof r).toBe("string");
    expect(r).toContain("varias máquinas");
    expect(r).toContain("nº de serie");
  });

  test("avisa si la máquina no existe", () => {
    const r = parseRow("maquinaria_checklist", { maquina: "Robot X", texto: "Batería" }, 2, catalogo(maquinas));
    expect(r).toContain("no existe");
  });

  test("exige la pregunta y la máquina", () => {
    expect(parseRow("maquinaria_checklist", { texto: "Batería" }, 2, catalogo(maquinas))).toContain("'maquina'");
    expect(parseRow("maquinaria_checklist", { maquina: "Fregadora F-80" }, 2, catalogo(maquinas))).toContain("'texto'");
  });

  test("acepta la puntuación 1-5 con sus alias", () => {
    const r = parseRow("maquinaria_checklist", { maquina: "1", texto: "Estado general", tipo: "Escala" }, 2, catalogo(maquinas));
    expect(r).toMatchObject({ maquina_id: 1, tipo: "escala" });
  });
});
