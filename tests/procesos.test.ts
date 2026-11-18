import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { makeD1 } from "./d1-shim";
import { bootstrap } from "../src/worker/db";
import app from "../src/worker/index";

// Reglas de los procesos de gestión: pedidos que no se editan fuera del
// borrador, fichas de documento sin duplicados, trabajos con subzona coherente
// e importación sin repetidos, y el estado del lote químico en sync con el stock.

const db = new Database(":memory:");
const d1 = makeD1(db);
const TOKEN = "tok-test-procesos";
const fetcher = app.fetch as unknown as (r: Request, e: unknown) => Promise<Response>;

async function call(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetcher(new Request(`http://localhost${path}`, init), { DB: d1, ASSETS: { fetch: async () => new Response("404") } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const post = (path: string, data: unknown) =>
  call(path, { method: "POST", headers: { "Content-Type": "application/json", Cookie: `inv_session=${TOKEN}` }, body: JSON.stringify(data) });
const put = (path: string, data: unknown) =>
  call(path, { method: "PUT", headers: { "Content-Type": "application/json", Cookie: `inv_session=${TOKEN}` }, body: JSON.stringify(data) });

let centro = 0;
let zonaA = 0;
let zonaB = 0;
let subzonaB = 0;
let proveedorId = 0;

beforeAll(async () => {
  await bootstrap(d1);
  const admin = await d1.prepare("SELECT id FROM usuarios WHERE rol = 'admin' ORDER BY id LIMIT 1").first<{ id: number }>();
  await d1.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
    .bind(TOKEN, Number(admin?.id ?? 1)).run();
  centro = Number((await d1.prepare("SELECT id FROM centros ORDER BY id LIMIT 1").first<{ id: number }>())?.id ?? 1);
  const otro = Number((await d1.prepare("SELECT id FROM centros WHERE id != ? ORDER BY id LIMIT 1").bind(centro).first<{ id: number }>())?.id ?? centro);
  zonaA = Number((await d1.prepare("INSERT INTO zonas (nombre, centro_id) VALUES ('Zona A', ?)").bind(centro).run()).meta.last_row_id ?? 0);
  zonaB = Number((await d1.prepare("INSERT INTO zonas (nombre, centro_id) VALUES ('Zona B', ?)").bind(otro).run()).meta.last_row_id ?? 0);
  subzonaB = Number((await d1.prepare("INSERT INTO subzonas (nombre, zona_id) VALUES ('Subzona B', ?)").bind(zonaB).run()).meta.last_row_id ?? 0);
  const prov = await post("/api/proveedores", { id_proveedor: "PR-PROC", nombre: "Proveedor Procesos" });
  proveedorId = Number((prov.body.item as Record<string, unknown>).id);
});

test("un trabajo no acepta una subzona de otra zona", async () => {
  const malo = await post("/api/trabajos", {
    centro_id: centro, zona_id: zonaA, subzona_id: subzonaB, titulo: "Trabajo con subzona ajena",
  });
  expect(malo.status).toBe(400);
  expect(String(malo.body.error)).toContain("subzona");

  const bueno = await post("/api/trabajos", { centro_id: centro, zona_id: zonaA, titulo: "Limpieza de vestuarios" });
  expect(bueno.status).toBe(201);
});

test("importar dos veces los mismos trabajos no los duplica", async () => {
  const filas = [{ centro_id: centro, titulo: "Revisión de extintores", tipo: "mantenimiento", prioridad: "alta" }];
  const primera = await post("/api/trabajos/import", { rows: filas });
  expect(primera.status).toBe(200);
  expect(Number(primera.body.creados)).toBe(1);

  const segunda = await post("/api/trabajos/import", { rows: filas });
  expect(segunda.status).toBe(200);
  expect(Number(segunda.body.creados)).toBe(0);
  expect(Number(segunda.body.actualizados)).toBe(1);

  const total = await d1.prepare("SELECT COUNT(*) AS n FROM trabajos WHERE titulo = 'Revisión de extintores'").first<{ n: number }>();
  expect(Number(total?.n)).toBe(1);
});

test("un pedido enviado ya no se puede editar", async () => {
  await post("/api/productos-disponibles", { proveedor_id: proveedorId, codigo: "PROC-1", producto: "Producto de proceso", precio: 2 });
  const alta = await post("/api/pedidos", {
    centro_id: centro, proveedor_id: proveedorId,
    lineas: [{ codigo: "PROC-1", producto: "Producto de proceso", cantidad: 3, precio: 2, origen: "fabrica" }],
  });
  expect(alta.status).toBe(201);
  const id = Number(alta.body.id);

  const enBorrador = await put(`/api/pedidos/${id}`, { notas: "Nota en borrador" });
  expect(enBorrador.status).toBe(200);

  const enviado = await post(`/api/pedidos/${id}/enviar`, {});
  expect(enviado.status).toBe(200);

  const tarde = await put(`/api/pedidos/${id}`, { notas: "Cambio fuera de plazo" });
  expect(tarde.status).toBe(400);
  expect(String(tarde.body.error)).toContain("borrador");
});

test("no se puede dar de alta dos veces la misma ficha de documento", async () => {
  const tipo = Number((await d1.prepare("SELECT id FROM documento_tipos ORDER BY id LIMIT 1").first<{ id: number }>())?.id ?? 1);
  const ficha = { nombre: "Ficha de seguridad PROC", tipo_id: tipo, url: "https://example.com/fds.pdf", centros: [centro] };

  const primera = await post("/api/documentos", ficha);
  expect(primera.status).toBe(201);

  const repetida = await post("/api/documentos", { ...ficha, nombre: "Otra copia" });
  expect(repetida.status).toBe(400);
  expect(String(repetida.body.error)).toContain("misma URL");

  const total = await d1.prepare("SELECT COUNT(*) AS n FROM documentos WHERE TRIM(LOWER(url)) = 'https://example.com/fds.pdf'").first<{ n: number }>();
  expect(Number(total?.n)).toBe(1);
});

test("una entrada manual de stock reactiva el lote químico agotado", async () => {
  const lote = await d1.prepare("SELECT id FROM quimicos WHERE numero_lote IS NOT NULL ORDER BY id LIMIT 1").first<{ id: number }>();
  const id = Number(lote?.id);
  await d1.prepare("UPDATE quimicos SET num_garrafas = 0, estado = 'agotado' WHERE id = ?").bind(id).run();

  const entrada = await post("/api/movimientos/ajuste", { recurso: "quimicos", id, tipo: "entrada", cantidad: 4, motivo: "Devolución" });
  expect(entrada.status).toBe(200);

  const fila = await d1.prepare("SELECT num_garrafas, estado FROM quimicos WHERE id = ?").bind(id).first<{ num_garrafas: number; estado: string }>();
  expect(Number(fila?.num_garrafas)).toBe(4);
  expect(fila?.estado).toBe("activo");
});

test("no se puede repetir el número de lote al dar una entrada", async () => {
  const lote = await d1.prepare("SELECT numero_lote FROM quimicos WHERE numero_lote IS NOT NULL ORDER BY id LIMIT 1").first<{ numero_lote: string }>();
  const repetida = await post("/api/inventario/entrada", {
    nombre: "Detergente repetido", numero_lote: String(lote?.numero_lote), litros_por_garrafa: 5,
    num_garrafas: 2, origen: "fabrica",
  });
  expect(repetida.status).toBe(400);
  expect(String(repetida.body.error)).toContain("Ya existe un lote");
});
