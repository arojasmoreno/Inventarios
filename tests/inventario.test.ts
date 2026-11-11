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

// ── Proveedores: cada producto se pide a uno solo y el pedido se filtra ──────
const del = (path: string) => call(path, { method: "DELETE", headers: { Cookie: `inv_session=${TOKEN}` } });

let prov1 = 0, prov2 = 0;

test("el esquema guarda el código de proveedor y el proveedor del producto", async () => {
  const proveedores = await d1.prepare("PRAGMA table_info(proveedores)").all<{ name: string }>();
  const productos = await d1.prepare("PRAGMA table_info(productos_disponibles)").all<{ name: string }>();
  expect(proveedores.results.map((c) => c.name)).toContain("codigo");
  expect(productos.results.map((c) => c.name)).toContain("proveedor_id");
  const tabla = await d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pedidos'").first();
  expect(tabla).toBeTruthy();
});

test("los proveedores tienen código único y los productos exigen proveedor", async () => {
  const p1 = await post("/api/proveedores", { codigo: "PROV-1", nombre: "Proveedor Uno", contacto: "Ana", email: "ana@prov1.test" });
  expect(p1.status).toBe(201);
  prov1 = Number((p1.body.item as Record<string, unknown>).id);
  expect(prov1).toBeGreaterThan(0);

  const p2 = await post("/api/proveedores", { codigo: "PROV-2", nombre: "Proveedor Dos" });
  expect(p2.status).toBe(201);
  prov2 = Number((p2.body.item as Record<string, unknown>).id);

  const repetido = await post("/api/proveedores", { codigo: "PROV-1", nombre: "Duplicado" });
  expect(repetido.status).toBe(400);

  const sinProveedor = await post("/api/productos-disponibles", { codigo: "P-1", producto: "Producto Uno" });
  expect(sinProveedor.status).toBe(400);
  expect(String(sinProveedor.body.error)).toContain("Proveedor");

  const prod1 = await post("/api/productos-disponibles", { proveedor_id: prov1, codigo: "P-1", producto: "Producto Uno", precio: 2.5 });
  expect(prod1.status).toBe(201);
  expect(Number((prod1.body.item as Record<string, unknown>).proveedor_id)).toBe(prov1);
  expect(String((prod1.body.item as Record<string, unknown>).proveedor_codigo)).toBe("PROV-1");

  const prod2 = await post("/api/productos-disponibles", { proveedor_id: prov2, codigo: "P-2", producto: "Producto Dos", precio: 4 });
  expect(prod2.status).toBe(201);
});

test("el catálogo se filtra por proveedor", async () => {
  const soloUno = await get("/api/productos-disponibles?proveedor_id=" + String(prov1));
  expect(soloUno.status).toBe(200);
  const items = soloUno.body.items as Array<Record<string, unknown>>;
  expect(items.length).toBe(1);
  expect(String(items[0].codigo)).toBe("P-1");
  expect(String(items[0].proveedor_codigo)).toBe("PROV-1");
});

test("el pedido rechaza productos de otro proveedor y aplica el stock", async () => {
  const opciones = await get("/api/pedidos/opciones");
  expect(opciones.status).toBe(200);
  const productos = opciones.body.productos as Array<Record<string, unknown>>;
  expect(productos.find((p) => p.codigo === "P-1")?.proveedor_id).toBe(prov1);

  const incorrecto = await post("/api/pedidos", {
    centro_id: 1, proveedor_id: prov2,
    lineas: [{ codigo: "P-1", producto: "Producto Uno", cantidad: 5 }],
  });
  expect(incorrecto.status).toBe(400);
  expect(String(incorrecto.body.error)).toContain("no pertenece");

  const creado = await post("/api/pedidos", {
    centro_id: 1, proveedor_id: prov1,
    lineas: [{ codigo: "P-1", producto: "Nombre manipulado", cantidad: 5, precio: 2.5 }],
  });
  expect(creado.status).toBe(201);
  const pedidoId = Number(creado.body.id);
  expect(pedidoId).toBeGreaterThan(0);

  const detalle = await get(`/api/pedidos/${String(pedidoId)}`);
  expect(detalle.status).toBe(200);
  const cabecera = detalle.body.pedido as Record<string, unknown>;
  expect(String(cabecera.proveedor_codigo)).toBe("PROV-1");
  expect(String(cabecera.proveedor_nombre)).toBe("Proveedor Uno");
  const lineas = detalle.body.lineas as Array<Record<string, unknown>>;
  expect(lineas.length).toBe(1);
  expect(String(lineas[0].producto)).toBe("Producto Uno");

  expect((await post(`/api/pedidos/${String(pedidoId)}/enviar`, {})).status).toBe(200);
  const recibido = await post(`/api/pedidos/${String(pedidoId)}/recibir`, {
    albaran: "ALB-TEST-1",
    lineas: [{ id: Number(lineas[0].id), cantidad_recibida: 5 }],
  });
  expect(recibido.status).toBe(200);
  expect((await post(`/api/pedidos/${String(pedidoId)}/aplicar`, {})).status).toBe(200);

  const material = await d1.prepare("SELECT cantidad FROM material_limpieza WHERE codigo = 'P-1'").first<{ cantidad: number }>();
  expect(Number(material?.cantidad)).toBe(5);
});

test("el material de limpieza muestra el proveedor de su código en el catálogo", async () => {
  const r = await get("/api/material-limpieza");
  const items = r.body.items as Array<Record<string, unknown>>;
  const conProveedor = items.find((i) => i.codigo === "P-1");
  expect(conProveedor).toBeTruthy();
  expect(String(conProveedor?.proveedor_codigo)).toBe("PROV-1");
  expect(String(conProveedor?.proveedor_nombre)).toBe("Proveedor Uno");

  // Sin código en el catálogo no hay proveedor: la tabla lo indica con vacío.
  const suelto = await post("/api/material-limpieza", { codigo: "SIN-CAT", nombre: "Material suelto", color: "Azul", cantidad: 2, centro_id: 1 });
  expect(suelto.status).toBe(201);
  const tras = await get("/api/material-limpieza");
  const fila = (tras.body.items as Array<Record<string, unknown>>).find((i) => i.codigo === "SIN-CAT");
  expect(fila).toBeTruthy();
  expect(fila?.proveedor_nombre ?? null).toBeNull();
});

test("un producto del catálogo sin proveedor aparece en el listado y se le puede asignar uno", async () => {
  await d1.prepare("INSERT INTO productos_disponibles (codigo, producto) VALUES ('HUERFANO-1', 'Producto huérfano')").run();
  const lista = await get("/api/productos-disponibles");
  const items = lista.body.items as Array<Record<string, unknown>>;
  const huerfano = items.find((p) => p.codigo === "HUERFANO-1");
  expect(huerfano).toBeTruthy();
  expect(huerfano?.proveedor_id ?? null).toBeNull();
  expect(huerfano?.proveedor_nombre ?? null).toBeNull();

  const asignado = await post("/api/productos-disponibles/import", {
    rows: [{ proveedor_id: prov1, codigo: "HUERFANO-1", producto: "Producto huérfano", precio: null }],
  });
  expect(asignado.status).toBe(200);
  expect(Number(asignado.body.actualizados)).toBe(1);

  const tras = await get("/api/productos-disponibles?proveedor_id=" + String(prov1));
  const fila = (tras.body.items as Array<Record<string, unknown>>).find((p) => p.codigo === "HUERFANO-1");
  expect(Number(fila?.proveedor_id)).toBe(prov1);
  expect(String(fila?.proveedor_nombre)).toBe("Proveedor Uno");
});

test("la importación asigna el proveedor seleccionado", async () => {
  const importado = await post("/api/productos-disponibles/import", {
    rows: [{ proveedor_id: prov1, codigo: "P-3", producto: "Producto Tres", precio: 1.25 }],
  });
  expect(importado.status).toBe(200);
  expect(Number(importado.body.creados)).toBe(1);
  const items = await get("/api/productos-disponibles?proveedor_id=" + String(prov1));
  const fila = (items.body.items as Array<Record<string, unknown>>).find((p) => p.codigo === "P-3");
  expect(fila).toBeTruthy();
  expect(Number(fila?.proveedor_id)).toBe(prov1);
});

test("la importación masiva crea proveedores y asigna cada producto a su código", async () => {
  const proveedoresImportados = await post("/api/proveedores/import", {
    rows: [{ codigo: "BULK-P1", nombre: "Proveedor Masivo Uno" }, { codigo: "BULK-P2", nombre: "Proveedor Masivo Dos" }],
  });
  expect(proveedoresImportados.status).toBe(200);
  expect(Number(proveedoresImportados.body.creados)).toBe(2);

  const lista = await get("/api/proveedores");
  const porCodigo = new Map((lista.body.items as Array<Record<string, unknown>>).map((p) => [String(p.codigo), Number(p.id)]));
  const p1 = Number(porCodigo.get("BULK-P1")), p2 = Number(porCodigo.get("BULK-P2"));
  expect(p1).toBeGreaterThan(0);
  expect(p2).toBeGreaterThan(0);

  const productosImportados = await post("/api/productos-disponibles/import", {
    rows: [
      { proveedor_id: p1, codigo: "BULK-A", producto: "Producto Masivo A", precio: 1.5 },
      { proveedor_id: p2, codigo: "BULK-B", producto: "Producto Masivo B", precio: 2.5 },
    ],
  });
  expect(productosImportados.status).toBe(200);
  expect(Number(productosImportados.body.creados)).toBe(2);

  const soloUno = await get("/api/productos-disponibles?proveedor_id=" + String(p1));
  const items = soloUno.body.items as Array<Record<string, unknown>>;
  expect(items.length).toBe(1);
  expect(String(items[0].codigo)).toBe("BULK-A");
  expect(Number(items[0].proveedor_id)).toBe(p1);
});

test("el alta del pedido conoce el stock mínimo de cada producto", async () => {
  await d1.prepare("UPDATE material_limpieza SET stock_minimo = 8 WHERE codigo = 'P-1'").run();
  const opciones = await get("/api/pedidos/opciones");
  expect(opciones.status).toBe(200);
  const producto = (opciones.body.productos as Array<Record<string, unknown>>).find((p) => p.codigo === "P-1");
  expect(producto).toBeTruthy();
  expect(Number(producto?.stock_minimo)).toBe(8);
  expect(Number(producto?.unidades_almacen)).toBe(5);
});

test("los proveedores muestran lo que queda por recibir de sus pedidos", async () => {
  const creado = await post("/api/pedidos", {
    centro_id: 1, proveedor_id: prov1,
    lineas: [{ codigo: "P-1", producto: "Producto Uno", cantidad: 3, precio: 2, origen: "fabrica" }],
  });
  expect(creado.status).toBe(201);

  const lista = await get("/api/proveedores");
  const prov = (lista.body.items as Array<Record<string, unknown>>).find((p) => Number(p.id) === prov1);
  expect(prov).toBeTruthy();
  expect(Number(prov?.pedidos_pendientes)).toBe(1);
  expect(Number(prov?.unidades_pendientes)).toBe(3);
  expect(Number(prov?.importe_pendiente)).toBe(6);

  // Al aplicar el pedido deja de contar como pendiente.
  const id = Number(creado.body.id);
  expect((await post(`/api/pedidos/${String(id)}/enviar`, {})).status).toBe(200);
  const detalle = await get(`/api/pedidos/${String(id)}`);
  const linea = (detalle.body.lineas as Array<Record<string, unknown>>)[0];
  expect((await post(`/api/pedidos/${String(id)}/recibir`, {
    albaran: "ALB-PEND", lineas: [{ id: Number(linea.id), cantidad_recibida: 3 }],
  })).status).toBe(200);
  expect((await post(`/api/pedidos/${String(id)}/aplicar`, {})).status).toBe(200);

  const tras = await get("/api/proveedores");
  const provTras = (tras.body.items as Array<Record<string, unknown>>).find((p) => Number(p.id) === prov1);
  expect(Number(provTras?.pedidos_pendientes)).toBe(0);
  expect(Number(provTras?.unidades_pendientes)).toBe(0);
});

test("un proveedor con productos o pedidos no se puede borrar", async () => {
  const borrado = await del(`/api/proveedores/${String(prov1)}`);
  expect(borrado.status).toBe(400);
  expect(String(borrado.body.error)).toContain("productos");
});
