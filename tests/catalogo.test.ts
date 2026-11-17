import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { bootstrap } from "../src/worker/db";
import app from "../src/worker/index";

// Alta de proveedores y productos del catálogo: al reimportar, cada fila se
// reconoce por cualquiera de sus campos únicos (ID o código) y los códigos no
// se duplican cambiando mayúsculas.

const db = new Database(":memory:");
const d1 = makeD1(db);
const TOKEN = "tok-test-catalogo";
const fetcher = app.fetch as unknown as (r: Request, e: unknown) => Promise<Response>;

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetcher(new Request(`http://localhost${path}`, init), { DB: d1, ASSETS: { fetch: async () => new Response("404") } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const post = (path: string, data: unknown) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `inv_session=${TOKEN}` }, body: JSON.stringify(data) });
const get = (path: string) => call(path, { headers: { Cookie: `inv_session=${TOKEN}` } });

const idProveedor = async (codigo: string): Promise<number> =>
  Number((await d1.prepare("SELECT id FROM proveedores WHERE TRIM(UPPER(codigo)) = ?").bind(codigo).first<{ id: number }>())?.id ?? 0);
const contarProductos = async (codigo: string): Promise<number> =>
  Number((await d1.prepare("SELECT COUNT(*) AS n FROM productos_disponibles WHERE TRIM(UPPER(codigo)) = ?").bind(codigo).first<{ n: number }>())?.n ?? 0);

beforeAll(async () => {
  await bootstrap(d1);
  const admin = await d1.prepare("SELECT id FROM usuarios WHERE rol = 'admin' ORDER BY id LIMIT 1").first();
  await d1.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .bind(TOKEN, Number(admin?.id ?? 1)).run();
});

test("el alta de proveedor y producto deja el catálogo con su proveedor y sus columnas de pedido", async () => {
  const prov = await post("/api/proveedores", { id_proveedor: "PR-001", nombre: "Suministros Norte" });
  expect(prov.status).toBe(201);
  const proveedorId = Number((prov.body.item as Record<string, unknown>).id);

  const prod = await post("/api/productos-disponibles", { proveedor_id: proveedorId, codigo: "M-001", producto: "Mopa de microfibra", precio: 3.75 });
  expect(prod.status).toBe(201);

  const lista = await get("/api/productos-disponibles");
  const fila = (lista.body.items as Record<string, unknown>[]).find((p) => p.codigo === "M-001");
  expect(fila).toBeDefined();
  expect(fila?.proveedor_codigo).toBe("PR-001");
  expect(Number(fila?.unidades_reservadas)).toBe(0);
  expect(fila?.ultimo_precio).toBeNull();
});

test("reimportar un proveedor por su código lo actualiza en vez de fallar", async () => {
  const primera = await post("/api/proveedores/import", { rows: [{ codigo: "PR-002", nombre: "Proveedor Dos" }] });
  expect(primera.status).toBe(200);
  expect(Number(primera.body.creados)).toBe(1);

  // Misma fila del Excel: antes fallaba con «Ya existe un registro con Código».
  const segunda = await post("/api/proveedores/import", { rows: [{ codigo: "pr-002", nombre: "Proveedor Dos SL" }] });
  expect(segunda.status).toBe(200);
  expect(Number(segunda.body.actualizados)).toBe(1);
  expect(segunda.body.errores).toEqual([]);

  const fila = await d1.prepare("SELECT codigo, nombre FROM proveedores WHERE TRIM(UPPER(codigo)) = 'PR-002'").first<{ codigo: string; nombre: string }>();
  expect(fila?.nombre).toBe("Proveedor Dos SL");
  // Se conserva el código tal y como se guardó la primera vez.
  expect(fila?.codigo).toBe("PR-002");
  const total = await d1.prepare("SELECT COUNT(*) AS n FROM proveedores WHERE TRIM(UPPER(codigo)) = 'PR-002'").first<{ n: number }>();
  expect(Number(total?.n)).toBe(1);
});

test("un código de producto no se duplica cambiando mayúsculas", async () => {
  const proveedorId = await idProveedor("PR-001");
  const dup = await post("/api/productos-disponibles", { proveedor_id: proveedorId, codigo: "m-001", producto: "Mopa repetida" });
  expect(dup.status).toBe(400);
  expect(String(dup.body.error)).toContain("Ya existe");
  expect(await contarProductos("M-001")).toBe(1);
});

test("la importación de productos actualiza por código sin crear duplicados", async () => {
  const proveedorId = await idProveedor("PR-001");
  const antes = await contarProductos("M-001");
  const r = await post("/api/productos-disponibles/import", {
    rows: [{ proveedor_id: proveedorId, codigo: "M-001", producto: "Mopa de microfibra reforzada", precio: 4.2 }],
  });
  expect(r.status).toBe(200);
  expect(Number(r.body.actualizados)).toBe(1);
  expect(Number(r.body.creados)).toBe(0);
  expect(await contarProductos("M-001")).toBe(antes);

  const fila = await d1.prepare("SELECT producto FROM productos_disponibles WHERE TRIM(UPPER(codigo)) = 'M-001'").first<{ producto: string }>();
  expect(fila?.producto).toBe("Mopa de microfibra reforzada");
});

test("el catálogo muestra las unidades reservadas por los pedidos sin aplicar", async () => {
  const proveedorId = await idProveedor("PR-001");
  const centro = await d1.prepare("SELECT id FROM centros ORDER BY id LIMIT 1").first<{ id: number }>();
  const pedido = await post("/api/pedidos", {
    centro_id: Number(centro?.id),
    proveedor_id: proveedorId,
    lineas: [{ codigo: "M-001", producto: "Mopa de microfibra reforzada", cantidad: 4, precio: 4.2, origen: "fabrica" }],
  });
  expect(pedido.status).toBe(201);

  const lista = await get("/api/productos-disponibles");
  const fila = (lista.body.items as Record<string, unknown>[]).find((p) => p.codigo === "M-001");
  expect(Number(fila?.unidades_reservadas)).toBe(4);
  expect(Number(fila?.ultimo_precio)).toBe(4.2);
});
