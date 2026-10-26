import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { bootstrap } from "../src/worker/db";
import app from "../src/worker/index";

// Control de lotes de químicos: alta de entrada, salida por caducidad (FEFO)
// con retirada de lotes y recuento que ajusta el stock con lo contado.

const db = new Database(":memory:");
const d1 = makeD1(db);
const TOKEN = "tok-test-inventario";
const fetcher = app.fetch as unknown as (r: Request, e: unknown) => Promise<Response>;

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetcher(new Request(`http://localhost${path}`, init), { DB: d1, ASSETS: { fetch: async () => new Response("404") } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const post = (path: string, data: unknown) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `inv_session=${TOKEN}` }, body: JSON.stringify(data) });
const get = (path: string) => call(path, { headers: { Cookie: `inv_session=${TOKEN}` } });
const stock = async (lote: string): Promise<Record<string, unknown>> =>
  (await d1.prepare("SELECT id, num_garrafas, estado FROM quimicos WHERE numero_lote = ?").bind(lote).first()) ?? {};

let idLoteViejo = 0;
let idLoteNuevo = 0;
let idLoteDG = 0;

beforeAll(async () => {
  await bootstrap(d1);
  const admin = await d1.prepare("SELECT id FROM usuarios WHERE rol = 'admin' ORDER BY id LIMIT 1").first();
  await d1.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .bind(TOKEN, Number(admin?.id ?? 1)).run();
  idLoteViejo = Number((await d1.prepare("SELECT id FROM quimicos WHERE numero_lote = 'L-2024-001'").first())?.id ?? 0);
  idLoteDG = Number((await d1.prepare("SELECT id FROM quimicos WHERE numero_lote = 'L-2025-032'").first())?.id ?? 0);
});

test("la migración añade fecha_entrada, estado y las tablas de recuento", async () => {
  const cols = await d1.prepare("PRAGMA table_info(quimicos)").all<{ name: string }>();
  const nombres = cols.results.map((c) => c.name);
  expect(nombres).toContain("fecha_entrada");
  expect(nombres).toContain("estado");
  const tablas = await d1.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('inventarios', 'inventarios_lineas')",
  ).all<{ name: string }>();
  expect(tablas.results.length).toBe(2);
  // Los lotes previos quedan con fecha de entrada y estado derivado del stock.
  const fila = await d1.prepare("SELECT fecha_entrada, estado FROM quimicos WHERE id = ?").bind(idLoteViejo).first<{ fecha_entrada: string; estado: string }>();
  expect(fila?.fecha_entrada).toBeTruthy();
  expect(fila?.estado).toBe("activo");
});

test("la entrada da de alta un lote nuevo del mismo producto y puede sumar garrafas", async () => {
  const r = await post("/api/inventario/entrada", {
    nombre: "Detergente alcalino Q-200", marca: null, numero_lote: "L-2026-100",
    litros_por_garrafa: 5, num_garrafas: 4, fecha_entrada: "2026-10-26",
    fecha_caducidad: "2026-12-31", origen: "fabrica", centro_id: 1,
  });
  expect(r.status).toBe(200);
  const item = r.body.item as Record<string, unknown>;
  idLoteNuevo = Number(item.id);
  expect(idLoteNuevo).toBeGreaterThan(0);
  expect(Number(item.num_garrafas)).toBe(4);
  expect(Number(item.total_litros)).toBe(20);

  // El mismo producto con su propio lote y sus propias fechas: suma al almacén.
  const acum = await post("/api/inventario/entrada", {
    quimico_id: idLoteNuevo, nombre: "Detergente alcalino Q-200", numero_lote: "L-2026-100",
    litros_por_garrafa: 5, num_garrafas: 2, origen: "fabrica",
  });
  expect(acum.status).toBe(200);
  expect(Number((acum.body.item as Record<string, unknown>).num_garrafas)).toBe(6);
  expect(Number((await stock("L-2026-100")).num_garrafas)).toBe(6);
});

test("la salida consume primero el lote que antes caduca y retira los lotes vacíos", async () => {
  // 8 L: salen del lote nuevo (caduca 2026-12-31) antes que del antiguo (2027-06-30).
  const r = await post("/api/inventario/salida", { ids: [idLoteViejo, idLoteNuevo], litros: 8 });
  expect(r.status).toBe(200);
  const detalle = r.body.detalle as Array<Record<string, unknown>>;
  expect(detalle.length).toBe(1);
  expect(Number(detalle[0].id)).toBe(idLoteNuevo);
  expect(Number(detalle[0].restantes)).toBeCloseTo(4.4, 2);
  expect(r.body.retirados).toBe(0);

  // 30 L: agotan el lote nuevo (se retira) y siguen en el lote antiguo.
  const r2 = await post("/api/inventario/salida", { ids: [idLoteViejo, idLoteNuevo], litros: 30 });
  expect(r2.status).toBe(200);
  const det2 = r2.body.detalle as Array<Record<string, unknown>>;
  expect(det2.length).toBe(2);
  expect(det2[0].retirado).toBe(true); // el lote nuevo queda vacío y se retira
  expect(det2[1].retirado).toBe(false);
  expect(Number(det2[1].restantes)).toBeCloseTo(10.4, 2);
  expect(r2.body.retirados).toBe(1);
  const nuevo = await stock("L-2026-100");
  expect(Number(nuevo.num_garrafas)).toBe(0);
  expect(String(nuevo.estado)).toBe("agotado");

  // No se puede retirar más de lo que hay.
  const ko = await post("/api/inventario/salida", { ids: [idLoteViejo, idLoteNuevo], litros: 9999 });
  expect(ko.status).toBe(400);
  expect(String(ko.body.error)).toContain("Stock insuficiente");
});

test("el recuento ajusta cada lote con los litros reales y retira los descartados", async () => {
  const r = await post("/api/inventario/recuento", {
    lineas: [
      { quimico_id: idLoteViejo, unidad: "litros", valor: 45 },
      { quimico_id: idLoteDG, unidad: "litros", valor: 0 },
      { quimico_id: idLoteNuevo, unidad: "litros", valor: 0 },
    ],
    notas: "Recuento de prueba",
  });
  expect(r.status).toBe(200);
  expect(r.body.ajustes).toBe(2);
  expect(r.body.retirados).toBe(1);
  expect(Number((r.body.inventario as Record<string, unknown>).lineas)).toBe(3);

  // 45 L reales / 5 L por garrafa = 9 garrafas.
  expect(Number((await stock("L-2024-001")).num_garrafas)).toBeCloseTo(9, 3);
  expect(String((await stock("L-2024-001")).estado)).toBe("activo");
  // Contado a cero con stock anterior: el lote queda descartado.
  const dg = await stock("L-2025-032");
  expect(Number(dg.num_garrafas)).toBe(0);
  expect(String(dg.estado)).toBe("descartado");

  const hist = await get("/api/inventario/recuentos");
  expect(hist.status).toBe(200);
  const items = hist.body.items as Array<Record<string, unknown>>;
  expect(items.length).toBe(1);
  expect(Number(items[0].lineas)).toBe(3);
  expect(Number(items[0].diferencia)).toBeCloseTo(-67, 2);
});

test("las tres operaciones quedan registradas en la auditoría", async () => {
  const movs = await d1.prepare(
    "SELECT accion, COUNT(*) AS n FROM movimientos WHERE accion IN ('entrada', 'salida', 'recuento') GROUP BY accion",
  ).all<{ accion: string; n: number }>();
  const porAccion = Object.fromEntries(movs.results.map((m) => [m.accion, Number(m.n)]));
  expect(porAccion.entrada).toBe(2);
  expect(porAccion.salida).toBe(2);
  expect(porAccion.recuento).toBe(1);
});
