import { Hono } from "hono";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import { logMovimiento } from "./audit";
import { sendResumen } from "./email";
import type { D1Database, D1Statement, Env } from "./d1";
import type { Variables } from "./types";

// Ciclo del pedido de consumibles de un centro:
//   borrador → enviado (se manda al proveedor, se descarga el Excel)
//   → recibido (número de albarán + recuento real de lo que ha llegado)
//   → aplicado (lo contado se suma al stock de material de limpieza).
// Las diferencias entre lo pedido y lo contado se marcan para reclamar.
type Row = Record<string, unknown>;

const ESTADOS = ["borrador", "enviado", "recibido", "aplicado"] as const;
type Estado = (typeof ESTADOS)[number];
const ETIQUETA_ESTADO: Record<Estado, string> = {
  borrador: "Borrador", enviado: "Enviado", recibido: "Recibido", aplicado: "Aplicado",
};
const ORIGENES = ["fabrica", "empresa"] as const;

function texto(valor: unknown, max: number): string | null {
  if (valor === null || valor === undefined) return null;
  const s = String(valor).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

function entero(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isInteger(valor) ? valor : null;
  if (typeof valor !== "string" || !valor.trim()) return null;
  const n = Number(valor);
  return Number.isInteger(n) ? n : null;
}

function decimal(valor: unknown): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const n = typeof valor === "number" ? valor : Number(String(valor).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function esEstado(valor: unknown): valor is Estado {
  return typeof valor === "string" && (ESTADOS as readonly string[]).includes(valor);
}

function origenValido(valor: unknown): (typeof ORIGENES)[number] {
  return typeof valor === "string" && (ORIGENES as readonly string[]).includes(valor)
    ? (valor as (typeof ORIGENES)[number])
    : "empresa";
}

async function leerCuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Row> {
  try {
    const body: unknown = await c.req.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Row;
  } catch { /* JSON inválido */ }
  return {};
}

async function ejecutar(db: D1Database, statements: D1Statement[]): Promise<void> {
  if (!statements.length) return;
  if (db.batch) await db.batch(statements);
  else for (const statement of statements) await statement.run();
}

async function centrosVisibles(db: D1Database, user: SessionUser): Promise<Array<{ id: number; nombre: string }>> {
  if (user.rol === "admin") {
    const res = await db.prepare("SELECT id, nombre FROM centros ORDER BY nombre COLLATE NOCASE").all<{ id: number; nombre: string }>();
    return res.results.map((c) => ({ id: Number(c.id), nombre: String(c.nombre) }));
  }
  return centrosDeUsuario(db, user.id);
}

async function puedeVerCentro(db: D1Database, user: SessionUser, centroId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  const row = await db.prepare("SELECT 1 AS x FROM usuario_centros WHERE usuario_id = ? AND centro_id = ?")
    .bind(user.id, centroId).first();
  return Boolean(row);
}

async function puedeGestionarCentro(db: D1Database, user: SessionUser, centroId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  if (user.rol !== "admin_centros") return false;
  return puedeVerCentro(db, user, centroId);
}

interface PedidoDb {
  id: number;
  numero: string;
  centro_id: number;
  proveedor_id: number | null;
  estado: Estado;
  albaran: string | null;
  notas: string | null;
  reclamacion: string | null;
}

async function cargarPedido(db: D1Database, id: number): Promise<PedidoDb | null> {
  return db.prepare(
    "SELECT id, numero, centro_id, proveedor_id, estado, albaran, notas, reclamacion FROM pedidos WHERE id = ?",
  ).bind(id).first<PedidoDb>();
}

/** Siguiente número correlativo del año (P-2026-0001). */
async function siguienteNumero(db: D1Database): Promise<string> {
  const anio = new Date().getUTCFullYear();
  const row = await db.prepare("SELECT numero FROM pedidos WHERE numero LIKE ? ORDER BY numero DESC LIMIT 1")
    .bind(`P-${anio}-%`).first<{ numero: string }>();
  const ultimo = row ? Number(String(row.numero).split("-")[2]) : 0;
  return `P-${anio}-${String((Number.isFinite(ultimo) ? ultimo : 0) + 1).padStart(4, "0")}`;
}

interface LineaEntrada {
  codigo: string;
  producto: string;
  cantidad: number;
  precio: number | null;
  origen: (typeof ORIGENES)[number];
}

function leerLineas(valor: unknown): { lineas: LineaEntrada[]; error?: string } {
  if (!Array.isArray(valor)) return { lineas: [], error: "El pedido necesita al menos una línea" };
  const lineas: LineaEntrada[] = [];
  for (const raw of valor) {
    if (!raw || typeof raw !== "object") continue;
    const fila = raw as Row;
    const codigo = texto(fila.codigo, 40);
    const producto = texto(fila.producto, 200);
    const cantidad = entero(fila.cantidad);
    if (!codigo || !producto) return { lineas: [], error: "Cada línea necesita código y producto" };
    if (!cantidad || cantidad < 1) return { lineas: [], error: `La cantidad de «${producto}» debe ser mayor que 0` };
    lineas.push({ codigo, producto, cantidad, precio: decimal(fila.precio), origen: origenValido(fila.origen) });
  }
  if (!lineas.length) return { lineas: [], error: "El pedido necesita al menos una línea" };
  return { lineas };
}

/** Códigos duplicados (el stock se suma por código, así que cada uno va una vez). */
function codigoRepetido(lineas: Array<{ codigo: string }>): string | null {
  const vistos = new Set<string>();
  for (const l of lineas) {
    const clave = l.codigo.trim().toUpperCase();
    if (vistos.has(clave)) return l.codigo;
    vistos.add(clave);
  }
  return null;
}

export const pedidosRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
pedidosRoutes.use("*", requireAuth);

// Centros a los que puede pedir el usuario y proveedores disponibles para el
// selector de alta.
pedidosRoutes.get("/opciones", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centros = await centrosVisibles(db, user);
  const proveedores = await db.prepare(
    "SELECT id, codigo, nombre, contacto, email, telefono, dias_entrega FROM proveedores WHERE activo = 1 ORDER BY nombre COLLATE NOCASE",
  ).all<Row>();
  // `stock_minimo` viaja con el producto para que el alta del pedido pueda
  // proponer la cantidad que falta hasta el mínimo sin otra petición.
  const productos = await db.prepare(
    `SELECT p.id, p.proveedor_id, p.codigo, p.producto, p.precio, pr.codigo AS proveedor_codigo,
            (SELECT COALESCE(SUM(ml.cantidad), 0) FROM material_limpieza ml
              WHERE ml.codigo IS NOT NULL AND TRIM(UPPER(ml.codigo)) = TRIM(UPPER(p.codigo))) AS unidades_almacen,
            (SELECT COALESCE(MAX(ml.stock_minimo), 0) FROM material_limpieza ml
              WHERE ml.codigo IS NOT NULL AND TRIM(UPPER(ml.codigo)) = TRIM(UPPER(p.codigo))) AS stock_minimo,
            -- Reservado: lo pedido en pedidos aún no aplicados al stock.
            (SELECT COALESCE(SUM(pl.cantidad), 0) FROM pedido_lineas pl JOIN pedidos pe ON pe.id = pl.pedido_id
              WHERE pe.estado <> 'aplicado' AND TRIM(UPPER(pl.codigo)) = TRIM(UPPER(p.codigo))) AS unidades_reservadas,
            -- Último precio pagado por este producto (histórico de pedidos).
            (SELECT pl.precio FROM pedido_lineas pl JOIN pedidos pe ON pe.id = pl.pedido_id
              WHERE pl.precio IS NOT NULL AND TRIM(UPPER(pl.codigo)) = TRIM(UPPER(p.codigo))
              ORDER BY pe.fecha DESC, pl.id DESC LIMIT 1) AS ultimo_precio
     FROM productos_disponibles p LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     ORDER BY p.producto COLLATE NOCASE`,
  ).all<Row>();
  return c.json({
    centros,
    proveedores: proveedores.results,
    productos: productos.results,
    puede_gestionar: user.rol !== "usuario" && centros.length > 0,
    rol: user.rol,
  });
});

// Listado de pedidos con sus totales. Filtra por centro y estado.
pedidosRoutes.get("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const centroId = entero(c.req.query("centro_id"));
  const estado = c.req.query("estado") ?? "";
  const visibles = await centrosVisibles(db, user);
  if (centroId && !visibles.some((x) => x.id === centroId)) {
    return c.json({ error: "No tienes acceso a ese centro" }, 403);
  }
  const ids = centroId ? [centroId] : visibles.map((x) => x.id);
  if (!ids.length) return c.json({ items: [], total: 0 });

  const marcas = ids.map(() => "?").join(", ");
  const filtros: unknown[] = [...ids];
  let filtroEstado = "";
  if (esEstado(estado)) {
    filtroEstado = " AND p.estado = ?";
    filtros.push(estado);
  }
  const res = await db.prepare(
    `SELECT p.id, p.numero, p.centro_id, p.proveedor_id, p.estado, p.fecha, p.fecha_envio,
            p.fecha_prevista, p.fecha_recepcion, p.albaran, p.notas, p.reclamacion,
            pr.dias_entrega,
            CASE WHEN p.estado IN ('enviado', 'recibido') AND p.fecha_prevista IS NOT NULL
                   AND date(p.fecha_prevista) < date('now') THEN 1 ELSE 0 END AS retrasado,
            CASE WHEN p.estado IN ('enviado', 'recibido') AND p.fecha_prevista IS NOT NULL
                   AND date(p.fecha_prevista) < date('now')
                 THEN CAST(julianday('now') - julianday(p.fecha_prevista) AS INTEGER) ELSE 0 END AS dias_retraso,
            c.nombre AS centro_nombre, pr.nombre AS proveedor_nombre, pr.codigo AS proveedor_codigo,
            (SELECT COUNT(*) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS lineas,
            (SELECT COALESCE(SUM(l.cantidad), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS unidades,
            (SELECT COALESCE(SUM(l.cantidad * COALESCE(l.precio, 0)), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS importe,
            (SELECT COALESCE(SUM(CASE WHEN l.reclamar = 1 THEN 1 ELSE 0 END), 0) FROM pedido_lineas l WHERE l.pedido_id = p.id) AS reclamaciones
     FROM pedidos p JOIN centros c ON c.id = p.centro_id
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE p.centro_id IN (${marcas})${filtroEstado}
     ORDER BY p.fecha DESC, p.id DESC`,
  ).bind(...filtros).all<Row>();
  return c.json({
    items: res.results,
    total: res.results.length,
    puede_gestionar: user.rol !== "usuario" && visibles.length > 0,
    centros: visibles,
  });
});

// Presupuesto por centro: pedidos e importe del año, pendiente de recibir y
// pedidos retrasados. Alimenta el cuadro de gasto del listado de pedidos.
pedidosRoutes.get("/resumen", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const visibles = await centrosVisibles(db, user);
  if (!visibles.length) return c.json({ items: [] });
  const marcas = visibles.map(() => "?").join(", ");
  const res = await db.prepare(
    `SELECT c.id, c.nombre,
       (SELECT COUNT(*) FROM pedidos p WHERE p.centro_id = c.id
          AND strftime('%Y', p.fecha) = strftime('%Y', 'now')) AS pedidos_anio,
       (SELECT COALESCE(SUM(l.cantidad * COALESCE(l.precio, 0)), 0) FROM pedidos p
          JOIN pedido_lineas l ON l.pedido_id = p.id
          WHERE p.centro_id = c.id AND strftime('%Y', p.fecha) = strftime('%Y', 'now')) AS importe_anio,
       (SELECT COALESCE(SUM(l.cantidad * COALESCE(l.precio, 0)), 0) FROM pedidos p
          JOIN pedido_lineas l ON l.pedido_id = p.id
          WHERE p.centro_id = c.id AND p.estado <> 'aplicado') AS importe_pendiente,
       (SELECT COUNT(*) FROM pedidos p WHERE p.centro_id = c.id AND p.estado IN ('enviado', 'recibido')
          AND p.fecha_prevista IS NOT NULL AND date(p.fecha_prevista) < date('now')) AS retrasados
     FROM centros c WHERE c.id IN (${marcas}) ORDER BY c.nombre COLLATE NOCASE`,
  ).bind(...visibles.map((x) => x.id)).all<Row>();
  return c.json({ items: res.results });
});

// Historial de precios de un producto: todos los pedidos en los que se compró.
pedidosRoutes.get("/precios", async (c) => {
  const codigo = texto(c.req.query("codigo"), 40);
  if (!codigo) return c.json({ error: "Indica el código del producto" }, 400);
  const res = await c.env.DB.prepare(
    `SELECT pl.codigo, pl.producto, pl.precio, pl.cantidad, pl.origen,
            p.numero, p.fecha, pr.nombre AS proveedor_nombre, pr.codigo AS proveedor_codigo
     FROM pedido_lineas pl JOIN pedidos p ON p.id = pl.pedido_id
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
     WHERE TRIM(UPPER(pl.codigo)) = TRIM(UPPER(?))
     ORDER BY p.fecha DESC, pl.id DESC LIMIT 60`,
  ).bind(codigo).all<Row>();
  return c.json({ items: res.results });
});

// Importación masiva de pedidos: cada fila es una línea y las filas con la
// misma referencia «pedido» se agrupan en una cabecera con sus líneas.
pedidosRoutes.post("/import", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  if (!Array.isArray(body.rows)) return c.json({ error: "Falta la lista de filas" }, 400);
  if (body.rows.length > 500) return c.json({ error: "Máximo 500 líneas por importación" }, 400);
  const errores: string[] = [];
  const grupos = new Map<string, Row[]>();
  for (const raw of body.rows) {
    if (!raw || typeof raw !== "object") continue;
    const fila = raw as Row;
    const clave = texto(fila.pedido, 40);
    if (!clave) { if (errores.length < 8) errores.push("Hay filas sin la referencia de pedido"); continue; }
    grupos.set(clave, [...(grupos.get(clave) ?? []), fila]);
  }
  let creados = 0, lineasCreadas = 0;
  for (const [clave, filas] of grupos) {
    const primera = filas[0];
    const centroId = entero(primera.centro_id);
    const proveedorId = entero(primera.proveedor_id);
    if (!centroId || !proveedorId) { if (errores.length < 8) errores.push(`Pedido ${clave}: faltan centro o proveedor`); continue; }
    if (!(await puedeGestionarCentro(db, user, centroId))) { if (errores.length < 8) errores.push(`Pedido ${clave}: no puedes gestionar ese centro`); continue; }
    const proveedor = await db.prepare("SELECT nombre FROM proveedores WHERE id = ?").bind(proveedorId).first<{ nombre: string }>();
    if (!proveedor) { if (errores.length < 8) errores.push(`Pedido ${clave}: el proveedor no existe`); continue; }
    const catalogo = await db.prepare("SELECT codigo, producto FROM productos_disponibles WHERE proveedor_id = ?")
      .bind(proveedorId).all<{ codigo: string; producto: string }>();
    const permitidos = new Map(catalogo.results.map((p) => [String(p.codigo).trim().toUpperCase(), String(p.producto)]));
    const lineas: Array<{ codigo: string; producto: string; cantidad: number; precio: number | null; origen: string }> = [];
    let falloGrupo: string | null = null;
    for (const fila of filas) {
      const codigo = texto(fila.codigo, 40);
      const cantidad = entero(fila.cantidad);
      if (!codigo) { falloGrupo = "hay una línea sin código"; break; }
      if (!cantidad || cantidad < 1) { falloGrupo = `la cantidad de «${codigo}» no es válida`; break; }
      if (!permitidos.has(codigo.toUpperCase())) { falloGrupo = `el producto «${codigo}» no pertenece al proveedor`; break; }
      // Un mismo código repetido en el CSV se suma en una sola línea.
      const repetida = lineas.find((l) => l.codigo.toUpperCase() === codigo.toUpperCase());
      if (repetida) { repetida.cantidad += cantidad; continue; }
      lineas.push({ codigo, producto: permitidos.get(codigo.toUpperCase()) ?? codigo, cantidad, precio: decimal(fila.precio), origen: origenValido(fila.origen) });
    }
    if (falloGrupo || !lineas.length) { if (errores.length < 8) errores.push(`Pedido ${clave}: ${falloGrupo ?? "sin líneas"}`); continue; }
    const numero = await siguienteNumero(db);
    const notas = texto(primera.notas, 500) ?? `Importado desde CSV (${clave})`;
    const res = await db.prepare(
      "INSERT INTO pedidos (numero, centro_id, proveedor_id, estado, notas, creado_por) VALUES (?, ?, ?, 'borrador', ?, ?)",
    ).bind(numero, centroId, proveedorId, notas, user.id).run();
    const id = Number((res.meta as { last_row_id?: number }).last_row_id);
    if (!id) { if (errores.length < 8) errores.push(`Pedido ${clave}: no se pudo crear`); continue; }
    await ejecutar(db, lineas.map((l) => db.prepare(
      "INSERT INTO pedido_lineas (pedido_id, codigo, producto, cantidad, precio, origen) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, l.codigo, l.producto, l.cantidad, l.precio, l.origen)));
    creados++;
    lineasCreadas += lineas.length;
    await logMovimiento(db, user, "alta", "pedidos", id, `Pedido ${numero} importado (${clave}) · ${lineas.length} líneas`, null, null);
  }
  if (!creados && errores.length) return c.json({ error: errores[0], errores }, 400);
  return c.json({ creados, actualizados: 0, lineas: lineasCreadas, errores });
});

// Detalle de un pedido con sus líneas.
pedidosRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeVerCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "No tienes acceso a este pedido" }, 403);
  }
  const [cabecera, lineas] = await Promise.all([
    db.prepare(
      `SELECT p.*, c.nombre AS centro_nombre, pr.nombre AS proveedor_nombre, pr.codigo AS proveedor_codigo,
              pr.email AS proveedor_email, pr.dias_entrega, u.nombre AS creado_por_nombre
       FROM pedidos p JOIN centros c ON c.id = p.centro_id
       LEFT JOIN proveedores pr ON pr.id = p.proveedor_id
       LEFT JOIN usuarios u ON u.id = p.creado_por
       WHERE p.id = ?`,
    ).bind(id).first<Row>(),
    db.prepare(
      `SELECT l.*,
              (SELECT COALESCE(SUM(ml.cantidad), 0) FROM material_limpieza ml
                WHERE ml.codigo IS NOT NULL AND TRIM(UPPER(ml.codigo)) = TRIM(UPPER(l.codigo))) AS stock_actual
       FROM pedido_lineas l WHERE l.pedido_id = ? ORDER BY l.id`,
    ).bind(id).all<Row>(),
  ]);
  return c.json({
    pedido: cabecera,
    lineas: lineas.results,
    puede_gestionar: await puedeGestionarCentro(db, user, Number(pedido.centro_id)),
  });
});

// Alta del pedido: centro, proveedor y líneas.
pedidosRoutes.post("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const body = await leerCuerpo(c);
  const centroId = entero(body.centro_id);
  const proveedorId = entero(body.proveedor_id);
  if (!centroId) return c.json({ error: "Indica el centro del pedido" }, 400);
  const centro = await db.prepare("SELECT nombre FROM centros WHERE id = ?").bind(centroId).first<{ nombre: string }>();
  if (!centro) return c.json({ error: "Centro no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, centroId))) {
    return c.json({ error: "Solo los responsables del centro pueden crear pedidos" }, 403);
  }
  const proveedor = proveedorId
    ? await db.prepare("SELECT nombre FROM proveedores WHERE id = ?").bind(proveedorId).first<{ nombre: string }>()
    : null;
  if (proveedorId && !proveedor) return c.json({ error: "Proveedor no encontrado" }, 404);
  if (!proveedorId) return c.json({ error: "El pedido debe ir a un proveedor" }, 400);

  const { lineas, error } = leerLineas(body.lineas);
  if (error) return c.json({ error }, 400);
  const repetido = codigoRepetido(lineas);
  if (repetido) return c.json({ error: `El código «${repetido}» aparece dos veces en el pedido` }, 400);
  // Cada línea debe ser de un producto del proveedor elegido y toma su nombre
  // del catálogo (no del texto que envíe el navegador).
  const catalogo = await db.prepare("SELECT codigo, producto FROM productos_disponibles WHERE proveedor_id = ?")
    .bind(proveedorId).all<{ codigo: string; producto: string }>();
  const permitidos = new Map(catalogo.results.map((p) => [String(p.codigo).trim().toUpperCase(), String(p.producto)]));
  const ajeno = lineas.find((l) => !permitidos.has(l.codigo.trim().toUpperCase()));
  if (ajeno) return c.json({ error: `El producto «${ajeno.producto}» no pertenece al proveedor seleccionado` }, 400);

  const numero = await siguienteNumero(db);
  const res = await db.prepare(
    `INSERT INTO pedidos (numero, centro_id, proveedor_id, estado, notas, creado_por)
     VALUES (?, ?, ?, 'borrador', ?, ?)`,
  ).bind(numero, centroId, proveedorId, texto(body.notas, 500), user.id).run();
  const id = Number((res.meta as { last_row_id?: number }).last_row_id);
  if (!id) return c.json({ error: "No se pudo crear el pedido" }, 500);

  await ejecutar(db, lineas.map((l) => db.prepare(
    `INSERT INTO pedido_lineas (pedido_id, codigo, producto, cantidad, precio, origen)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, l.codigo, permitidos.get(l.codigo.trim().toUpperCase()) ?? l.producto, l.cantidad, l.precio, l.origen)));

  await logMovimiento(db, user, "alta", "pedidos", id,
    `Pedido ${numero} creado para ${String(centro.nombre)} · ${lineas.length} líneas`, null, null);
  return c.json({ id, numero, ok: true }, 201);
});

// Cambiar proveedor o notas mientras siga en borrador.
pedidosRoutes.put("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden editar el pedido" }, 403);
  }
  // Fuera del borrador el pedido ya está enviado (o recepcionado y aplicado al
  // stock): cambiarle el proveedor dejaría las líneas apuntando a un catálogo
  // que no es el suyo.
  if (pedido.estado !== "borrador") {
    return c.json({ error: "Solo se puede modificar un pedido en borrador" }, 400);
  }
  const body = await leerCuerpo(c);
  const proveedorId = body.proveedor_id === undefined ? pedido.proveedor_id : entero(body.proveedor_id);
  if (!proveedorId) return c.json({ error: "El pedido debe ir a un proveedor" }, 400);
  const proveedor = await db.prepare("SELECT id FROM proveedores WHERE id = ?").bind(proveedorId).first();
  if (!proveedor) return c.json({ error: "Proveedor no encontrado" }, 404);
  if (Number(proveedorId) !== Number(pedido.proveedor_id)) {
    const lineas = await db.prepare("SELECT codigo FROM pedido_lineas WHERE pedido_id = ?").bind(id).all<{ codigo: string }>();
    const catalogo = await db.prepare("SELECT codigo FROM productos_disponibles WHERE proveedor_id = ?")
      .bind(proveedorId).all<{ codigo: string }>();
    const permitidos = new Set(catalogo.results.map((p) => String(p.codigo).trim().toUpperCase()));
    const ajeno = lineas.results.find((l) => !permitidos.has(String(l.codigo).trim().toUpperCase()));
    if (ajeno) return c.json({ error: "El pedido tiene productos que no pertenecen al nuevo proveedor" }, 400);
  }
  const notas = body.notas === undefined ? pedido.notas : texto(body.notas, 500);
  await db.prepare(
    "UPDATE pedidos SET proveedor_id = ?, notas = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(proveedorId, notas, id).run();
  return c.json({ ok: true });
});

// Añadir una línea al pedido (solo en borrador).
pedidosRoutes.post("/:id/lineas", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden editar el pedido" }, 403);
  }
  if (pedido.estado !== "borrador") return c.json({ error: "El pedido ya se ha enviado: no se pueden añadir líneas" }, 400);
  const { lineas, error } = leerLineas([await leerCuerpo(c)]);
  if (error) return c.json({ error }, 400);
  const linea = lineas[0];
  const producto = await db.prepare(
    "SELECT id, producto FROM productos_disponibles WHERE proveedor_id = ? AND TRIM(UPPER(codigo)) = TRIM(UPPER(?))",
  ).bind(Number(pedido.proveedor_id), linea.codigo).first<{ id: number; producto: string }>();
  if (!producto) return c.json({ error: "El producto no pertenece al proveedor del pedido" }, 400);
  const repetida = await db.prepare(
    "SELECT 1 AS x FROM pedido_lineas WHERE pedido_id = ? AND TRIM(UPPER(codigo)) = TRIM(UPPER(?))",
  ).bind(id, linea.codigo).first();
  if (repetida) return c.json({ error: `El código «${linea.codigo}» ya está en el pedido` }, 400);
  const res = await db.prepare(
    "INSERT INTO pedido_lineas (pedido_id, codigo, producto, cantidad, precio, origen) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(id, linea.codigo, producto.producto, linea.cantidad, linea.precio, linea.origen).run();
  return c.json({ id: Number((res.meta as { last_row_id?: number }).last_row_id), ok: true }, 201);
});

// Cambiar cantidad, precio u origen de una línea (solo en borrador).
pedidosRoutes.put("/:id/lineas/:lineaId", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const lineaId = Number(c.req.param("lineaId"));
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(lineaId) || lineaId < 1) {
    return c.json({ error: "Línea no válida" }, 400);
  }
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden editar el pedido" }, 403);
  }
  if (pedido.estado !== "borrador") return c.json({ error: "El pedido ya se ha enviado: no se puede editar" }, 400);
  const linea = await db.prepare("SELECT id, codigo, producto, cantidad, precio, origen FROM pedido_lineas WHERE id = ? AND pedido_id = ?")
    .bind(lineaId, id).first<Row>();
  if (!linea) return c.json({ error: "Línea no encontrada" }, 404);
  const body = await leerCuerpo(c);
  const cantidad = body.cantidad === undefined ? Number(linea.cantidad) : entero(body.cantidad);
  if (!cantidad || cantidad < 1) return c.json({ error: "La cantidad debe ser mayor que 0" }, 400);
  const precio = body.precio === undefined ? (linea.precio as number | null) : decimal(body.precio);
  const origen = body.origen === undefined ? origenValido(linea.origen) : origenValido(body.origen);
  await db.prepare(
    "UPDATE pedido_lineas SET cantidad = ?, precio = ?, origen = ?, updated_at = datetime('now') WHERE id = ? AND pedido_id = ?",
  ).bind(cantidad, precio, origen, lineaId, id).run();
  return c.json({ ok: true });
});

pedidosRoutes.delete("/:id/lineas/:lineaId", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  const lineaId = Number(c.req.param("lineaId"));
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(lineaId) || lineaId < 1) {
    return c.json({ error: "Línea no válida" }, 400);
  }
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden editar el pedido" }, 403);
  }
  if (pedido.estado !== "borrador") return c.json({ error: "El pedido ya se ha enviado: no se puede editar" }, 400);
  await db.prepare("DELETE FROM pedido_lineas WHERE id = ? AND pedido_id = ?").bind(lineaId, id).run();
  return c.json({ ok: true });
});

// Cerrar el pedido y mandarlo al proveedor.
pedidosRoutes.post("/:id/enviar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden enviar el pedido" }, 403);
  }
  if (pedido.estado !== "borrador") return c.json({ error: "El pedido ya se ha enviado" }, 400);
  const n = await db.prepare("SELECT COUNT(*) AS n FROM pedido_lineas WHERE pedido_id = ?").bind(id).first<{ n: number }>();
  if (!Number(n?.n)) return c.json({ error: "El pedido no tiene líneas" }, 400);
  // Fecha prevista = hoy + plazo de entrega configurado en el proveedor.
  const prov = pedido.proveedor_id
    ? await db.prepare("SELECT dias_entrega FROM proveedores WHERE id = ?").bind(Number(pedido.proveedor_id)).first<{ dias_entrega: number }>()
    : null;
  const dias = Math.max(0, Number(prov?.dias_entrega ?? 0));
  await db.prepare(
    "UPDATE pedidos SET estado = 'enviado', fecha_envio = date('now'), fecha_prevista = date('now', ?), updated_at = datetime('now') WHERE id = ?",
  ).bind(`+${dias} days`, id).run();
  await logMovimiento(db, user, "edicion", "pedidos", id, `Pedido ${pedido.numero} enviado al proveedor · entrega prevista en ${dias} días`, null, null);
  return c.json({ ok: true, estado: "enviado", dias_entrega: dias });
});

// Duplicar un pedido: crea un borrador nuevo con las mismas líneas y centro.
pedidosRoutes.post("/:id/duplicar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden duplicar el pedido" }, 403);
  }
  const lineas = await db.prepare(
    "SELECT codigo, producto, cantidad, precio, origen FROM pedido_lineas WHERE pedido_id = ? ORDER BY id",
  ).bind(id).all<LineaEntrada>();
  if (!lineas.results.length) return c.json({ error: "El pedido no tiene líneas que duplicar" }, 400);
  const numero = await siguienteNumero(db);
  const notas = texto(`Duplicado de ${pedido.numero}${pedido.notas ? ` · ${pedido.notas}` : ""}`, 500);
  const res = await db.prepare(
    "INSERT INTO pedidos (numero, centro_id, proveedor_id, estado, notas, creado_por) VALUES (?, ?, ?, 'borrador', ?, ?)",
  ).bind(numero, Number(pedido.centro_id), pedido.proveedor_id, notas, user.id).run();
  const nuevoId = Number((res.meta as { last_row_id?: number }).last_row_id);
  if (!nuevoId) return c.json({ error: "No se pudo duplicar el pedido" }, 500);
  await ejecutar(db, lineas.results.map((l) => db.prepare(
    "INSERT INTO pedido_lineas (pedido_id, codigo, producto, cantidad, precio, origen) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(nuevoId, l.codigo, l.producto, l.cantidad, l.precio, l.origen)));
  await logMovimiento(db, user, "alta", "pedidos", nuevoId, `Pedido ${numero} duplicado de ${pedido.numero}`, null, null);
  return c.json({ id: nuevoId, numero, ok: true }, 201);
});

// Enviar la hoja del pedido al proveedor por correo (SendGrid). Si no hay
// proveedor de correo configurado responde «simulado», sin romper el flujo.
pedidosRoutes.post("/:id/enviar-email", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden enviar el pedido" }, 403);
  }
  const cabecera = await db.prepare(
    `SELECT p.numero, c.nombre AS centro_nombre, pr.nombre AS proveedor_nombre,
            pr.email AS proveedor_email, pr.contacto AS proveedor_contacto
     FROM pedidos p JOIN centros c ON c.id = p.centro_id
     LEFT JOIN proveedores pr ON pr.id = p.proveedor_id WHERE p.id = ?`,
  ).bind(id).first<Row>();
  const email = String(cabecera?.proveedor_email ?? "").trim();
  if (!email) return c.json({ error: "El proveedor no tiene correo electrónico configurado" }, 400);
  const lineas = await db.prepare(
    "SELECT codigo, producto, cantidad, precio, origen FROM pedido_lineas WHERE pedido_id = ? ORDER BY producto",
  ).bind(id).all<Row>();
  if (!lineas.results.length) return c.json({ error: "El pedido no tiene líneas" }, 400);
  const total = lineas.results.reduce((n, l) => n + Number(l.cantidad ?? 0) * Number(l.precio ?? 0), 0);
  const filas = lineas.results.map((l) => `<tr>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${String(l.codigo ?? "")}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0">${String(l.producto ?? "")}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${Number(l.cantidad ?? 0)}</td>
    <td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;text-align:right">${l.precio == null ? "—" : Number(l.precio).toFixed(2) + " €"}</td>
  </tr>`).join("");
  const html = `<div style="font-family:Segoe UI,system-ui,sans-serif;max-width:680px;margin:0 auto">
    <h2 style="color:#1e3a8a">Pedido ${String(cabecera?.numero ?? "")}</h2>
    <p><strong>Centro:</strong> ${String(cabecera?.centro_nombre ?? "")}<br/>
       <strong>Proveedor:</strong> ${String(cabecera?.proveedor_nombre ?? "")}</p>
    <table style="border-collapse:collapse;width:100%;font-size:14px">
      <thead><tr style="background:#eff6ff"><th style="padding:8px 10px;text-align:left">Código</th><th style="padding:8px 10px;text-align:left">Producto</th><th style="padding:8px 10px;text-align:right">Cantidad</th><th style="padding:8px 10px;text-align:right">Precio</th></tr></thead>
      <tbody>${filas}</tbody>
    </table>
    <p style="text-align:right"><strong>Total estimado: ${total.toFixed(2)} €</strong></p>
    <p style="color:#64748b;font-size:12px">Enviado desde Inventarios por ${String(user.nombre)}.</p>
  </div>`;
  const text = `Pedido ${String(cabecera?.numero ?? "")}\nCentro: ${String(cabecera?.centro_nombre ?? "")}\nProveedor: ${String(cabecera?.proveedor_nombre ?? "")}\n\n` +
    lineas.results.map((l) => `${String(l.codigo)} · ${String(l.producto)} · ${Number(l.cantidad ?? 0)} uds · ${l.precio == null ? "—" : Number(l.precio).toFixed(2) + " €"}`).join("\n") +
    `\n\nTotal estimado: ${total.toFixed(2)} €`;
  try {
    const resultado = await sendResumen(c.env, email, `Pedido ${String(cabecera?.numero ?? "")} · Inventarios`, html, text);
    await logMovimiento(db, user, "edicion", "pedidos", id, `Pedido ${pedido.numero} enviado por correo a ${email} (${resultado})`, null, null);
    return c.json({ ok: true, enviado: resultado === "enviado", simulado: resultado === "simulado", to: email });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : "No se pudo enviar el correo" }, 502);
  }
});

// Recepción: número de albarán y recuento real línea a línea. Las líneas donde
// lo contado no coincide con lo pedido pueden marcarse para reclamar.
pedidosRoutes.post("/:id/recibir", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden recepcionar el pedido" }, 403);
  }
  if (pedido.estado === "aplicado") return c.json({ error: "El pedido ya está aplicado al stock" }, 400);
  if (pedido.estado === "borrador") return c.json({ error: "Marca el pedido como enviado antes de recepcionarlo" }, 400);

  const body = await leerCuerpo(c);
  const albaran = texto(body.albaran, 60);
  if (!albaran) return c.json({ error: "Indica el número de albarán" }, 400);
  if (!Array.isArray(body.lineas)) return c.json({ error: "Falta el recuento de las líneas" }, 400);

  const existentes = await db.prepare(
    "SELECT id, codigo, producto, cantidad FROM pedido_lineas WHERE pedido_id = ? ORDER BY id",
  ).bind(id).all<{ id: number; codigo: string; producto: string; cantidad: number }>();
  if (!existentes.results.length) return c.json({ error: "El pedido no tiene líneas" }, 400);

  const recuento = new Map<number, { recibida: number; reclamar: boolean; motivo: string | null }>();
  for (const raw of body.lineas) {
    if (!raw || typeof raw !== "object") continue;
    const fila = raw as Row;
    const lineaId = entero(fila.id);
    const recibida = entero(fila.cantidad_recibida);
    if (!lineaId) continue;
    if (recibida === null || recibida < 0) return c.json({ error: "Las cantidades contadas deben ser números enteros" }, 400);
    recuento.set(lineaId, { recibida, reclamar: fila.reclamar === true, motivo: texto(fila.motivo, 200) });
  }
  const faltan = existentes.results.filter((l) => !recuento.has(Number(l.id)));
  if (faltan.length) {
    return c.json({ error: `Falta contar ${faltan.length} línea${faltan.length === 1 ? "" : "s"}: «${faltan[0].producto}»` }, 400);
  }

  const differences: string[] = [];
  const statements: D1Statement[] = [];
  for (const linea of existentes.results) {
    const dato = recuento.get(Number(linea.id))!;
    const diferencia = dato.recibida - Number(linea.cantidad);
    if (diferencia !== 0) {
      differences.push(`${linea.codigo}: pedido ${Number(linea.cantidad)}, recibido ${dato.recibida}`);
    }
    statements.push(db.prepare(
      "UPDATE pedido_lineas SET cantidad_recibida = ?, reclamar = ?, motivo = ?, updated_at = datetime('now') WHERE id = ? AND pedido_id = ?",
    ).bind(dato.recibida, dato.reclamar ? 1 : 0, dato.motivo, Number(linea.id), id));
  }
  const reclamacion = differences.length
    ? `Albarán ${albaran}: ${differences.join(" · ")}`
    : null;
  statements.push(db.prepare(
    `UPDATE pedidos SET estado = 'recibido', albaran = ?, fecha_recepcion = date('now'),
            reclamacion = COALESCE(?, reclamacion), updated_at = datetime('now') WHERE id = ?`,
  ).bind(albaran, reclamacion, id));
  await ejecutar(db, statements);

  await logMovimiento(db, user, "edicion", "pedidos", id,
    `Pedido ${pedido.numero} recepcionado · albarán ${albaran}${differences.length ? ` · ${differences.length} diferencias` : ""}`, null, null);
  return c.json({ ok: true, estado: "recibido", albaran, diferencias: differences });
});

// Nota de reclamación al proveedor (por diferencias o por cualquier incidencia).
pedidosRoutes.post("/:id/reclamar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden reclamar" }, 403);
  }
  const body = await leerCuerpo(c);
  const motivo = texto(body.motivo, 500);
  if (!motivo) return c.json({ error: "Escribe el motivo de la reclamación" }, 400);
  await db.prepare(
    "UPDATE pedidos SET reclamacion = ?, updated_at = datetime('now') WHERE id = ?",
  ).bind(motivo, id).run();
  await logMovimiento(db, user, "edicion", "pedidos", id,
    `Reclamación del pedido ${pedido.numero}: ${motivo}`, null, null);
  return c.json({ ok: true });
});

// Sumar al stock lo contado. Cada línea entra en `material_limpieza` por su
// código (si no existe, se da de alta en el centro del pedido).
pedidosRoutes.post("/:id/aplicar", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden aplicar el pedido" }, 403);
  }
  if (pedido.estado === "aplicado") return c.json({ error: "El pedido ya se ha aplicado al stock" }, 400);
  if (pedido.estado !== "recibido") return c.json({ error: "Recepciona el pedido con su albarán antes de aplicarlo" }, 400);

  const lineas = await db.prepare(
    "SELECT id, codigo, producto, cantidad, cantidad_recibida, precio, origen FROM pedido_lineas WHERE pedido_id = ? ORDER BY id",
  ).bind(id).all<{ id: number; codigo: string; producto: string; cantidad: number; cantidad_recibida: number | null; precio: number | null; origen: string }>();

  let creados = 0;
  let actualizados = 0;
  let unidades = 0;
  for (const linea of lineas.results) {
    const cantidad = Number(linea.cantidad_recibida ?? 0);
    if (cantidad < 1) continue;
    const codigo = String(linea.codigo).trim();
    const existente = await db.prepare(
      `SELECT id FROM material_limpieza
       WHERE codigo IS NOT NULL AND TRIM(UPPER(codigo)) = TRIM(UPPER(?))
         AND (centro_id = ? OR centro_id IS NULL)
       ORDER BY CASE WHEN centro_id = ? THEN 0 ELSE 1 END, id LIMIT 1`,
    ).bind(codigo, Number(pedido.centro_id), Number(pedido.centro_id)).first<{ id: number }>();
    if (existente) {
      await db.prepare(
        "UPDATE material_limpieza SET cantidad = cantidad + ?, updated_at = datetime('now') WHERE id = ?",
      ).bind(cantidad, Number(existente.id)).run();
      actualizados++;
    } else {
      await db.prepare(
        `INSERT INTO material_limpieza (codigo, nombre, color, cantidad, precio, origen, centro_id, notas)
         VALUES (?, ?, 'Otro', ?, ?, ?, ?, ?)`,
      ).bind(codigo, linea.producto, cantidad, linea.precio, origenValido(linea.origen),
        Number(pedido.centro_id), `Alta por pedido ${pedido.numero}`).run();
      creados++;
    }
    unidades += cantidad;
    await logMovimiento(db, user, "entrada", "material_limpieza", null,
      `Pedido ${pedido.numero}${pedido.albaran ? ` (albarán ${pedido.albaran})` : ""}: +${cantidad} uds · ${linea.producto} (${codigo})`,
      cantidad, "Recepción de pedido");
  }
  if (!unidades) return c.json({ error: "No hay unidades recibidas que sumar al stock" }, 400);

  await db.prepare(
    "UPDATE pedidos SET estado = 'aplicado', updated_at = datetime('now') WHERE id = ?",
  ).bind(id).run();
  await logMovimiento(db, user, "edicion", "pedidos", id,
    `Pedido ${pedido.numero} aplicado al stock: ${unidades} uds (${actualizados} actualizados, ${creados} nuevos)`, unidades, null);
  return c.json({ ok: true, estado: "aplicado", unidades, creados, actualizados });
});

// Borrar un pedido que todavía no se ha enviado.
pedidosRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Pedido no válido" }, 400);
  const pedido = await cargarPedido(db, id);
  if (!pedido) return c.json({ error: "Pedido no encontrado" }, 404);
  if (!(await puedeGestionarCentro(db, user, Number(pedido.centro_id)))) {
    return c.json({ error: "Solo los responsables del centro pueden borrar el pedido" }, 403);
  }
  if (pedido.estado !== "borrador") {
    return c.json({ error: "Solo se puede borrar un pedido en borrador" }, 400);
  }
  await ejecutar(db, [
    db.prepare("DELETE FROM pedido_lineas WHERE pedido_id = ?").bind(id),
    db.prepare("DELETE FROM pedidos WHERE id = ?").bind(id),
  ]);
  await logMovimiento(db, user, "borrado", "pedidos", id, `Pedido ${pedido.numero} eliminado`, null, null);
  return c.json({ ok: true });
});

export { ETIQUETA_ESTADO };
