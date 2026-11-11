import { test, expect } from "bun:test";
import { bajoMinimo, faltanteHastaMinimo, sugerenciasReposicion } from "../src/web/reposicion";

// Reposición: el alta del pedido propone la cantidad que falta hasta el mínimo
// de cada producto del catálogo, cruzando el stock de «Material de limpieza».

test("sin mínimo configurado no se propone nada", () => {
  expect(faltanteHastaMinimo(5, 0)).toBe(0);
  expect(faltanteHastaMinimo(5, null)).toBe(0);
  expect(faltanteHastaMinimo(5, undefined)).toBe(0);
});

test("propone la diferencia hasta el mínimo y nada si ya se supera", () => {
  expect(faltanteHastaMinimo(2, 10)).toBe(8);
  expect(faltanteHastaMinimo(0, 3)).toBe(3);
  expect(faltanteHastaMinimo(10, 10)).toBe(0);
  expect(faltanteHastaMinimo(12, 10)).toBe(0);
});

test("redondea hacia arriba y tolera valores no numéricos", () => {
  expect(faltanteHastaMinimo(1.2, 4)).toBe(3);
  expect(faltanteHastaMinimo("", 4)).toBe(4);
  expect(faltanteHastaMinimo(2, "8")).toBe(6);
});

test("las sugerencias solo incluyen los productos bajo el mínimo", () => {
  const productos = [
    { id: 1, codigo: "A", unidades_almacen: 2, stock_minimo: 5 },
    { id: 2, codigo: "B", unidades_almacen: 9, stock_minimo: 5 },
    { id: 3, codigo: "C", unidades_almacen: 0, stock_minimo: 0 },
    { id: 4, codigo: "D", unidades_almacen: null, stock_minimo: 3 },
  ];
  expect(sugerenciasReposicion(productos)).toEqual({ "1": "3", "4": "3" });
  expect(bajoMinimo(productos).map((p) => p.id)).toEqual([1, 4]);
});
