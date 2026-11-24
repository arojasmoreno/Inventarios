import { beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { bootstrap } from "../src/worker/db";
import app from "../src/worker/index";
import type { D1Database, D1Result, D1Statement } from "../src/worker/d1";

// Importación de catálogos grandes: D1 admite 1.000 consultas por invocación del
// Worker, así que la importación no puede hacer una consulta por fila. Aquí se
// cuenta cuántas consultas hace realmente un lote de 500 productos.

const db = new Database(":memory:");
const d1 = makeD1(db);
const TOKEN = "tok-test-masiva";
const fetcher = app.fetch as unknown as (r: Request, e: unknown) => Promise<Response>;

// Cada ejecución cuenta como una consulta; un `batch` entero cuenta como una,
// igual que en D1 (donde una tanda de sentencias es una sola consulta).
let consultas = 0;
const contar = (s: D1Statement): D1Statement => ({
  bind: (...v: unknown[]) => contar(s.bind(...v)),
  first: () => { consultas++; return s.first(); },
  all: () => { consultas++; return s.all(); },
  run: () => { consultas++; return s.run(); },
  // Solo lo usa el shim al ejecutar un batch (ahí ya se cuenta el batch).
  __ejecutar: () => (s as unknown as { __ejecutar: () => D1Result }).__ejecutar(),
} as unknown as D1Statement);
const contador: D1Database = {
  prepare: (sql: string) => contar(d1.prepare(sql)),
  exec: (sql: string) => d1.exec(sql),
  batch: async <T = Record<string, unknown>>(statements: unknown[]): Promise<Array<D1Result<T>>> => {
    consultas++;
    return d1.batch!<T>(statements as never[]);
  },
};

async function post(path: string, data: unknown) {
  const res = await fetcher(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `inv_session=${TOKEN}` },
    body: JSON.stringify(data),
  }), { DB: contador, ASSETS: { fetch: async () => new Response("404") } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

let proveedorId = 0;
const fila = (n: number) => ({
  proveedor_id: proveedorId,
  codigo: `MAS-${String(n).padStart(4, "0")}`,
  producto: `Producto de prueba ${n}`,
  precio: 1.5,
});

beforeAll(async () => {
  await bootstrap(d1);
  const admin = await d1.prepare("SELECT id FROM usuarios WHERE rol = 'admin' ORDER BY id LIMIT 1").first();
  await d1.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .bind(TOKEN, Number(admin?.id ?? 1)).run();
});

describe("importación masiva", () => {
  test("un lote completo se guarda sin agotar el cupo de consultas de D1", async () => {
    await post("/api/proveedores/import", { rows: [{ id_proveedor: "PROV-MAS", nombre: "Proveedor Masivo" }] });
    proveedorId = Number((await d1.prepare("SELECT id FROM proveedores WHERE codigo = 'PROV-MAS'").first<{ id: number }>())?.id ?? 0);
    expect(proveedorId).toBeGreaterThan(0);
    consultas = 0;
    const r = await post("/api/productos-disponibles/import", {
      rows: Array.from({ length: 200 }, (_, i) => fila(i + 1)),
    });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(200);
    // El límite de D1 es 1.000 consultas por invocación: un lote de 200 filas
    // debe quedar muy por debajo (1 consulta de índice + 1 por lote escrito).
    expect(consultas).toBeLessThan(300);
    const n = Number((await d1.prepare("SELECT COUNT(*) AS n FROM productos_disponibles").first<{ n: number }>())?.n ?? 0);
    expect(n).toBe(200);
  });

  test("rechaza más de 200 filas por petición", async () => {
    const r = await post("/api/productos-disponibles/import", {
      rows: Array.from({ length: 201 }, (_, i) => fila(i + 500)),
    });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toContain("200");
  });

  test("reimportar el mismo lote actualiza en vez de duplicar", async () => {
    const r = await post("/api/productos-disponibles/import", {
      rows: Array.from({ length: 200 }, (_, i) => ({ ...fila(i + 1), producto: `Producto actualizado ${i + 1}` })),
    });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(0);
    expect(r.body.actualizados).toBe(200);
    const n = Number((await d1.prepare("SELECT COUNT(*) AS n FROM productos_disponibles").first<{ n: number }>())?.n ?? 0);
    expect(n).toBe(200);
    const uno = await d1.prepare("SELECT producto FROM productos_disponibles WHERE codigo = 'MAS-0001'").first<{ producto: string }>();
    expect(uno?.producto).toBe("Producto actualizado 1");
  });

  test("avisa del código repetido dentro del mismo archivo", async () => {
    const r = await post("/api/productos-disponibles/import", { rows: [fila(900), { ...fila(900), precio: "2" }] });
    expect(r.status).toBe(200);
    expect(r.body.creados).toBe(1);
    expect((r.body.errores as string[])[0]).toContain("ya aparece en la fila 1");
  });

  // Un archivo entero rechazado devolvía un 400 con un solo mensaje y el cliente
  // reintentaba el lote: ahora se informa del total de fallos y de cada motivo
  // con cuántas filas afecta, para poder corregir el archivo de origen.
  test("si no se guarda ninguna fila, devuelve los motivos agrupados con su recuento", async () => {
    const r = await post("/api/productos-disponibles/import", {
      rows: Array.from({ length: 12 }, (_, i) => ({ ...fila(i + 300), proveedor_id: 999_999 })),
    });
    expect(r.status).toBe(200);
    expect(Number(r.body.creados)).toBe(0);
    expect(Number(r.body.actualizados)).toBe(0);
    expect(Number(r.body.fallos)).toBe(12);
    const causas = r.body.causas as { mensaje: string; filas: number; ejemplos: number[] }[];
    expect(causas.length).toBe(1);
    expect(causas[0].filas).toBe(12);
    expect(causas[0].mensaje).toContain("proveedor");
    expect(causas[0].ejemplos[0]).toBe(1);
  });
});
