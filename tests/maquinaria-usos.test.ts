import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { CHECKLIST_DEFECTO, asegurarChecklist, validarRespuestas, type CheckItem } from "../src/worker/maquinaria-usos";

// Esquema mínimo del cuestionario de máquinas (equivalente al de db.ts).
const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL);
  CREATE TABLE maquinaria_check_items (id INTEGER PRIMARY KEY AUTOINCREMENT, maquina_id INTEGER NOT NULL,
    texto TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'booleano', orden INTEGER NOT NULL DEFAULT 0,
    activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
  INSERT INTO maquinaria (nombre) VALUES ('Fregadora test'), ('Aspiradora test');
`);
const db = makeD1(sqlite);
const itemsDe = (maquinaId: number): number =>
  Number((sqlite.query("SELECT COUNT(*) AS n FROM maquinaria_check_items WHERE maquina_id = ?").get(maquinaId) as { n: number }).n);

describe("cuestionario de uso de máquinas", () => {
  test("una máquina sin cuestionario recibe el de por defecto", async () => {
    const items = await asegurarChecklist(db, 1);
    expect(items.length).toBe(CHECKLIST_DEFECTO.length);
    expect(items.map((i) => i.texto)).toEqual(CHECKLIST_DEFECTO.map((i) => i.texto));
    expect(items.map((i) => i.tipo)).toEqual(CHECKLIST_DEFECTO.map((i) => i.tipo));
    expect(itemsDe(1)).toBe(CHECKLIST_DEFECTO.length);
  });

  test("no duplica el cuestionario si la máquina ya lo tiene", async () => {
    const antes = itemsDe(1);
    const items = await asegurarChecklist(db, 1);
    expect(itemsDe(1)).toBe(antes);
    expect(items.length).toBe(antes);
  });

  test("cada máquina tiene su propio cuestionario", async () => {
    await asegurarChecklist(db, 2);
    expect(itemsDe(2)).toBe(CHECKLIST_DEFECTO.length);
    sqlite.run("DELETE FROM maquinaria_check_items WHERE maquina_id = 2");
    expect(itemsDe(1)).toBe(CHECKLIST_DEFECTO.length);
  });
});

const items: CheckItem[] = [
  { id: 10, maquina_id: 1, texto: "¿Limpia?", tipo: "booleano", orden: 1, activo: 1 },
  { id: 11, maquina_id: 1, texto: "Estado general", tipo: "escala", orden: 2, activo: 1 },
  { id: 12, maquina_id: 1, texto: "¿Con accesorios?", tipo: "booleano", orden: 3, activo: 1 },
];

describe("respuestas del cuestionario", () => {
  test("acepta un cuestionario completo y lo guarda en orden", () => {
    const r = validarRespuestas(items, [
      { item_id: 12, valor: true },
      { item_id: 10, valor: false },
      { item_id: 11, valor: 4 },
    ]);
    expect(r.error).toBeUndefined();
    expect(r.respuestas?.map((x) => x.item_id)).toEqual([10, 11, 12]);
    expect(r.respuestas?.find((x) => x.item_id === 10)?.valor).toBe(false);
    expect(r.respuestas?.find((x) => x.item_id === 11)?.valor).toBe(4);
  });

  test("rechaza el cuestionario incompleto y dice qué falta", () => {
    const r = validarRespuestas(items, [{ item_id: 10, valor: true }]);
    expect(r.respuestas).toBeUndefined();
    expect(r.error).toContain("Faltan respuestas");
    expect(r.error).toContain("Estado general");
  });

  test("rechaza una puntuación fuera de 1-5", () => {
    const r = validarRespuestas(items, [
      { item_id: 10, valor: true }, { item_id: 11, valor: 9 }, { item_id: 12, valor: true },
    ]);
    expect(r.error).toContain("Puntúa de 1 a 5");
  });

  test("rechaza un Sí/No que no es booleano", () => {
    const r = validarRespuestas(items, [
      { item_id: 10, valor: "si" }, { item_id: 11, valor: 3 }, { item_id: 12, valor: true },
    ]);
    expect(r.error).toContain("Responde sí o no");
  });

  test("ignora preguntas de otra máquina o repetidas y exige las de esta", () => {
    const r = validarRespuestas(items, [
      { item_id: 10, valor: true }, { item_id: 999, valor: true }, { item_id: 10, valor: false },
    ]);
    expect(r.error).toContain("Faltan respuestas");
  });

  test("sin respuestas no se puede abrir el registro", () => {
    expect(validarRespuestas(items, null).error).toBeDefined();
    expect(validarRespuestas(items, []).error).toContain("Faltan respuestas");
  });
});
