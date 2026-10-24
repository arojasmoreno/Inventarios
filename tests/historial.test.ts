import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { seedHistorial, sincronizarEstado } from "../src/worker/maquinaria-historial";

// Esquema mínimo equivalente al de src/worker/db.ts para las tablas implicadas.
const sqlite = new Database(":memory:");
sqlite.exec(`
  CREATE TABLE maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, marca TEXT, modelo TEXT,
    estado TEXT NOT NULL DEFAULT 'Operativa', centro_id INTEGER, updated_at TEXT);
  CREATE TABLE situaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE);
  CREATE TABLE maquinaria_historial (id INTEGER PRIMARY KEY AUTOINCREMENT, maquina_id INTEGER NOT NULL,
    fecha TEXT NOT NULL DEFAULT (date('now')), situacion_id INTEGER NOT NULL, marca TEXT, modelo TEXT,
    centro_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
  INSERT INTO situaciones (nombre) VALUES ('Operativo'), ('En reparación'), ('Averiado'), ('Baja');
  INSERT INTO maquinaria (nombre, marca, modelo, centro_id) VALUES ('Fregadora test', 'Tomi', 'Mate', 1);
`);
const db = makeD1(sqlite);
const contarHistorial = (maquinaId: number): number =>
  Number((sqlite.query("SELECT COUNT(*) AS n FROM maquinaria_historial WHERE maquina_id = ?").get(maquinaId) as { n: number }).n);
const estadoDe = (maquinaId: number): string =>
  String((sqlite.query("SELECT estado FROM maquinaria WHERE id = ?").get(maquinaId) as { estado: string }).estado);

describe("histórico de maquinaria", () => {
  test("una máquina nueva recibe su primer registro «Operativo» y el estado se sincroniza", async () => {
    await seedHistorial(db, { id: 1, marca: "Tomi", modelo: "Mate", centro_id: 1 });
    expect(contarHistorial(1)).toBe(1);
    expect(estadoDe(1)).toBe("Operativo");
  });

  test("seedHistorial es idempotente: no duplica el registro inicial", async () => {
    await seedHistorial(db, { id: 1, marca: "Tomi", modelo: "Mate", centro_id: 1 });
    await seedHistorial(db, { id: 1 });
    expect(contarHistorial(1)).toBe(1);
  });

  test("el estado sigue al último registro (y vuelve al anterior al borrar)", async () => {
    // Registro más reciente: Averiado.
    sqlite.run(
      "INSERT INTO maquinaria_historial (maquina_id, fecha, situacion_id) VALUES (1, date('now', '+1 day'), (SELECT id FROM situaciones WHERE nombre = 'Averiado'))",
    );
    await sincronizarEstado(db, 1);
    expect(estadoDe(1)).toBe("Averiado");

    // Se elimina el registro más nuevo: el estado vuelve a «Operativo».
    const ultimo = sqlite.query("SELECT MAX(id) AS id FROM maquinaria_historial WHERE maquina_id = 1").get() as { id: number };
    sqlite.run("DELETE FROM maquinaria_historial WHERE id = ?", ultimo.id);
    await sincronizarEstado(db, 1);
    expect(estadoDe(1)).toBe("Operativo");
  });

  test("sin registros, sincronizarEstado no toca la columna estado", async () => {
    sqlite.run("INSERT INTO maquinaria (nombre, estado) VALUES ('Monobrocha test', 'En reparación')");
    const id = (sqlite.query("SELECT MAX(id) AS id FROM maquinaria").get() as { id: number }).id;
    await sincronizarEstado(db, id);
    expect(estadoDe(id)).toBe("En reparación");
  });
});
