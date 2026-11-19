import { Database } from "bun:sqlite";
import type { D1Database, D1Result } from "../src/worker/d1";

type V = string | number | null | Uint8Array;

// Shim mínimo de D1 sobre bun:sqlite: implementa prepare().bind().first/all/run
// y batch() (lo que usan las funciones del Worker) para poder testearlas en
// local sin una base D1 real.
export function makeD1(db: Database): D1Database {
  const wrap = (sql: string, values: V[] = []) => {
    // Ejecuta la sentencia y devuelve el resultado; `batch` lo usa dentro de una
    // transacción, el resto a través de run().
    const ejecutar = (): D1Result => {
      const info = values.length ? db.query(sql).run(...(values as never[])) : db.query(sql).run();
      return { results: [], success: true, meta: { last_row_id: Number(info.lastInsertRowid ?? 0) } };
    };
    return {
      bind: (...nuevos: V[]) => wrap(sql, nuevos),
      first: async <T = Record<string, unknown>>(): Promise<T | null> =>
        ((values.length ? db.query(sql).get(...(values as never[])) : db.query(sql).get()) as T | undefined) ?? null,
      all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> =>
        ({ results: (values.length ? db.query(sql).all(...(values as never[])) : db.query(sql).all()) as T[], success: true, meta: {} }),
      run: async () => ejecutar(),
      // Solo lo usa batch(): no forma parte de la interfaz pública de D1.
      __ejecutar: ejecutar,
    };
  };
  return {
    prepare: (sql: string) => wrap(sql),
    exec: async (sql: string) => db.exec(sql),
    // D1 ejecuta el batch como una transacción: si una sentencia falla, no se
    // aplica ninguna.
    batch: async <T = Record<string, unknown>>(statements: unknown[]): Promise<Array<D1Result<T>>> => {
      const ejecutarTodo = db.transaction(() =>
        statements.map((s) => (s as { __ejecutar: () => D1Result }).__ejecutar() as unknown as D1Result<T>));
      return ejecutarTodo();
    },
  } as unknown as D1Database;
}
