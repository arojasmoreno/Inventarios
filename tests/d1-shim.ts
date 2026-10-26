import { Database } from "bun:sqlite";
import type { D1Database } from "../src/worker/d1";

type V = string | number | null | Uint8Array;

// Shim mínimo de D1 sobre bun:sqlite: implementa prepare().bind().first/all/run
// (lo único que usan las funciones del Worker) para poder testearlas en local
// sin una base D1 real.
export function makeD1(db: Database): D1Database {
  const wrap = (sql: string) => {
    const run = async (...values: V[]) => {
      // `last_row_id` es lo que el Worker lee de `meta` tras un INSERT.
      const info = values.length ? db.query(sql).run(...(values as never[])) : db.query(sql).run();
      return { results: [], success: true, meta: { last_row_id: Number(info.lastInsertRowid ?? 0) } };
    };
    return {
      bind: (...values: V[]) => ({
        first: async <T = Record<string, unknown>>(): Promise<T | null> =>
          ((values.length ? db.query(sql).get(...(values as never[])) : db.query(sql).get()) as T | undefined) ?? null,
        all: async <T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> =>
          ({ results: (values.length ? db.query(sql).all(...(values as never[])) : db.query(sql).all()) as T[], success: true, meta: {} }),
        run: () => run(...values),
      }),
      first: async <T = Record<string, unknown>>(): Promise<T | null> => (db.query(sql).get() as T | undefined) ?? null,
      all: async <T = Record<string, unknown>>(): Promise<{ results: T[]; success: boolean; meta: Record<string, unknown> }> =>
          ({ results: db.query(sql).all() as T[], success: true, meta: {} }),
      run: () => run(),
    };
  };
  return { prepare: wrap } as unknown as D1Database;
}
