import type { CrudSpec } from "./crud";
import { createCrud, ValidationError, hashPasswordField } from "./crud";
import { requireAuth } from "./auth";
import { logMovimiento, movimientosSpec } from "./movimientos";

export const COLORES = ["Rojo", "Azul", "Verde", "Amarillo", "Blanco", "Negro", "Naranja", "Morado", "Gris", "Marrón", "Otro"];
export const TIPOS_MAQUINARIA = ["Fregadora", "Aspiradora", "Monobrocha", "Hidrolavadora", "Barredora", "Robot", "Carro de limpieza", "Otro"];
export const ESTADOS_MAQUINARIA = ["Operativa", "En reparación", "Averiada", "Baja"];
export const ROLES = ["admin", "usuario"];
const centro = { name: "centro_id", label: "Centro", type: "integer" as const, required: false, placeholder: "Sin centro asignado" };
const notas = { name: "notas", label: "Notas", type: "textarea" as const, required: false, maxLength: 2000 };
// Foto en base64 (el cliente la recimensiona antes de enviarla).
const foto = { name: "foto", label: "Foto", type: "text" as const, required: false, writeOnly: true, maxLength: 1500000 };
const stockMinimo = { name: "stock_minimo", label: "Stock mínimo (alerta)", type: "integer" as const, required: false, min: 0 };

export const quimicosSpec: CrudSpec = {
  table: "quimicos", orderBy: "id", refCentro: true, computed: "t.litros_por_garrafa * t.num_garrafas AS total_litros",
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: false, unique: true, maxLength: 40 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "nombre", label: "Producto", type: "text", required: true, maxLength: 200 },
    { name: "numero_lote", label: "Nº de lote", type: "text", required: true, maxLength: 60 },
    { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true, min: 0 },
    { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true, min: 0 },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", required: true },
    stockMinimo, centro, notas, foto,
    { name: "coste_unitario", label: "Coste por garrafa (€)", type: "number", required: false, min: 0 },
  ],
};
export const materialSpec: CrudSpec = {
  table: "material_limpieza", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: false, unique: true, maxLength: 40 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "nombre", label: "Material", type: "text", required: true, maxLength: 200 },
    { name: "color", label: "Color", type: "enum", required: true, enumValues: COLORES },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    stockMinimo, centro, notas, foto,
    { name: "coste_unitario", label: "Coste por unidad (€)", type: "number", required: false, min: 0 },
  ],
};
export const maquinariaSpec: CrudSpec = {
  table: "maquinaria", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Máquina", type: "text", required: true, maxLength: 200 },
    // El tipo se valida contra la tabla tipos_maquinaria (CRUD en su pestaña).
    { name: "tipo", label: "Tipo", type: "text", required: true, maxLength: 80 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    { name: "numero_serie", label: "Nº de serie", type: "text", required: false, maxLength: 60 },
    { name: "estado", label: "Estado", type: "enum", required: true, enumValues: ESTADOS_MAQUINARIA }, centro, notas, foto,
  ],
  beforeWrite: async (db, data) => {
    if (typeof data.tipo === "string" && data.tipo.trim()) {
      const t = await db.prepare("SELECT id FROM tipos_maquinaria WHERE nombre = ?").bind(data.tipo.trim()).first();
      if (!t) throw new ValidationError("El tipo debe existir en la pestaña «Tipos de maquinaria»");
    }
    return data;
  },
};
export const centrosSpec: CrudSpec = {
  table: "centros", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del centro", type: "text", required: true, unique: true, maxLength: 120 },
    { name: "direccion", label: "Dirección", type: "text", required: false, maxLength: 200 },
    { name: "ciudad", label: "Ciudad", type: "text", required: false, maxLength: 100 },
    { name: "responsable", label: "Responsable", type: "text", required: false, maxLength: 120 },
    { name: "telefono", label: "Teléfono", type: "text", required: false, maxLength: 40 },
  ],
};
export const usuariosSpec: CrudSpec = {
  table: "usuarios", orderBy: "id", refCentro: true, read: "admin", create: "admin", update: "admin", delete: "admin",
  extraSelect: [
    "(SELECT GROUP_CONCAT(c2.nombre) FROM usuario_centros uc2 JOIN centros c2 ON c2.id = uc2.centro_id WHERE uc2.usuario_id = t.id) AS centros_nombre",
    "(SELECT GROUP_CONCAT(uc3.centro_id) FROM usuario_centros uc3 WHERE uc3.usuario_id = t.id) AS centros_ids",
  ],
  fields: [
    { name: "username", label: "Usuario (login)", type: "text", required: true, unique: true, maxLength: 60 },
    { name: "nombre", label: "Nombre completo", type: "text", required: true, maxLength: 120 },
    { name: "email", label: "Email", type: "text", required: false, maxLength: 200 },
    { name: "password", label: "Contraseña", type: "password", required: false, writeOnly: true, placeholder: "Déjalo en blanco para no cambiarla" },
    { name: "rol", label: "Rol", type: "enum", required: true, enumValues: ROLES },
    { name: "activo", label: "Activo", type: "boolean", required: true },
  ],
  beforeWrite: async (_db, data, mode) => {
    if (mode === "insert" && (typeof data.password !== "string" || data.password.length < 6)) throw new ValidationError("La contraseña es obligatoria y debe tener al menos 6 caracteres");
    if (mode === "update" && data.password === "") delete data.password;
    await hashPasswordField(data);
    if (mode === "insert" && (data.rol === undefined || data.rol === null)) data.rol = "usuario";
    if (mode === "insert" && (data.activo === undefined || data.activo === null)) data.activo = 1;
    return data;
  },
  beforeDelete: async (db, user, row) => {
    if (Number(row.id) === user.id) return "No puedes eliminar tu propia cuenta";
    const n = await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(Number(row.id)).run();
    // Limpia tallas, centros asignados e historial de entregas del operario eliminado.
    await db.prepare("DELETE FROM tallas_operarios WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM usuario_centros WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM ropa_entregas WHERE usuario_id = ?").bind(Number(row.id)).run();
    return null;
  },
};
// ---- EPIs (equipos de protección individual) ----
export const episSpec: CrudSpec = {
  table: "epis", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true, unique: true, maxLength: 40 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "talla", label: "Talla (opcional)", type: "text", required: false, maxLength: 20 },
    { name: "descripcion", label: "Descripción", type: "textarea", required: false, maxLength: 2000 },
    { name: "color", label: "Color", type: "enum", required: false, enumValues: COLORES },
    { name: "stock", label: "Stock", type: "integer", required: true, min: 0 },
    stockMinimo,
    { name: "fecha_revision", label: "Próxima revisión", type: "date", required: false },
    { name: "coste_unitario", label: "Coste por unidad (€)", type: "number", required: false, min: 0 }, centro,
  ],
};
// ---- Ropa de trabajo de los centros ----
export const ropaSpec: CrudSpec = {
  table: "ropa_trabajo", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true, unique: true, maxLength: 40 },
    { name: "prenda", label: "Prenda", type: "text", required: true, maxLength: 120 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "fabricante", label: "Fabricante", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "talla", label: "Talla", type: "text", required: false, maxLength: 20 },
    { name: "alta_visibilidad", label: "Alta visibilidad", type: "boolean", required: true },
    { name: "manga_larga", label: "Manga larga", type: "boolean", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea", required: false, maxLength: 2000 },
    { name: "color", label: "Color", type: "enum", required: false, enumValues: COLORES },
    { name: "stock", label: "Stock", type: "integer", required: true, min: 0 },
    stockMinimo,
    { name: "coste_unitario", label: "Coste por unidad (€)", type: "number", required: false, min: 0 }, centro,
  ],
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM ropa_entregas WHERE ropa_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: hay ${n.n} entregas registradas de esta prenda`;
    return null;
  },
};
// ---- Talla de cada operario ----
export const tallasSpec: CrudSpec = {
  table: "tallas_operarios", orderBy: "id", refUsuario: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "usuario_id", label: "Operario", type: "integer", required: true, min: 1 },
    { name: "prenda", label: "Prenda", type: "text", required: true, maxLength: 120, placeholder: "Ej. Chaqueta, Pantalón, Botas…" },
    { name: "talla", label: "Talla", type: "text", required: true, maxLength: 20 },
    { name: "notas", label: "Notas", type: "textarea", required: false, maxLength: 2000 },
  ],
  beforeWrite: async (_db, data) => {
    if (!data.fecha) data.fecha = new Date().toISOString().slice(0, 10);
    return data;
  },
};
// ---- Historial de ropa entregada a cada operario ----
export const entregasSpec: CrudSpec = {
  table: "ropa_entregas", orderBy: "id", refUsuario: true,
  extraJoins: [" LEFT JOIN ropa_trabajo r ON r.id = t.ropa_id", " LEFT JOIN usuarios p ON p.id = t.entregado_por"],
  extraSelect: ["r.prenda AS ropa_prenda", "r.codigo AS ropa_codigo", "r.marca AS ropa_marca", "r.modelo AS ropa_modelo", "r.talla AS ropa_talla", "r.coste_unitario AS ropa_coste", "p.nombre AS entregado_por_nombre"],
  extraSearchCols: ["u.nombre", "r.prenda", "r.codigo"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "usuario_id", label: "Operario", type: "integer", required: true, min: 1 },
    { name: "ropa_id", label: "Prenda de ropa", type: "integer", required: true, min: 1 },
    { name: "cantidad", label: "Cantidad", type: "integer", required: true, min: 1 },
    { name: "fecha", label: "Fecha de entrega", type: "date", required: false, placeholder: "Hoy si se deja en blanco" },
    { name: "notas", label: "Notas", type: "textarea", required: false, maxLength: 2000 },
  ],
  // La entrega descuenta stock de la prenda; editar o borrar la entrega
  // ajusta el stock de forma simétrica.
  beforeWrite: async (db, data, mode, existing) => {
    const toInt = (v: unknown): number => Number(v ?? 0);
    if (mode === "insert" && !data.fecha) data.fecha = new Date().toISOString().slice(0, 10);
    const oldRopa = existing ? toInt(existing.ropa_id) : 0;
    const oldCant = existing ? toInt(existing.cantidad) : 0;
    const newRopa = toInt(data.ropa_id), newCant = toInt(data.cantidad);
    if (mode === "update" && existing && (oldRopa !== newRopa || oldCant !== newCant)) {
      await db.prepare("UPDATE ropa_trabajo SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?").bind(oldCant, oldRopa).run();
    }
    if (mode === "insert" || (mode === "update" && existing && (oldRopa !== newRopa || oldCant !== newCant))) {
      const stock = await db.prepare("SELECT stock FROM ropa_trabajo WHERE id = ?").bind(newRopa).first();
      if (!stock) throw new ValidationError("La prenda de ropa seleccionada no existe");
      if (Number(stock.stock) < newCant) throw new ValidationError(`Stock insuficiente: quedan ${Number(stock.stock)} uds. de esa prenda`);
      await db.prepare("UPDATE ropa_trabajo SET stock = stock - ?, updated_at = datetime('now') WHERE id = ?").bind(newCant, newRopa).run();
    }
    return data;
  },
  beforeDelete: async (db, _user, row) => {
    await db.prepare("UPDATE ropa_trabajo SET stock = stock + ?, updated_at = datetime('now') WHERE id = ?").bind(Number(row.cantidad), Number(row.ropa_id)).run();
    return null;
  },
  afterWrite: async (db, user, row, mode) => {
    const costeUnit = Number(row.ropa_coste ?? 0) || 0;
    const coste = Number((costeUnit * Number(row.cantidad || 0)).toFixed(2));
    await logMovimiento(db, user, mode === "insert" ? "entrega" : "entrega_editada", "ropa_trabajo", Number(row.ropa_id) || null,
      `${String(row.ropa_prenda ?? "Prenda")} → ${String(row.usuario_nombre ?? "operario")} (#${row.id})`, Number(row.cantidad) || null, coste, null);
  },
  afterDelete: async (db, user, row) => {
    await logMovimiento(db, user, "entrega_anulada", "ropa_trabajo", Number(row.ropa_id) || null, `Entrega #${row.id} anulada`, Number(row.cantidad) || null);
  },
};
export const centrosSpecForDelete: CrudSpec = {
  ...centrosSpec,
  beforeDelete: async (db, _user, row) => {
    const q = await db.prepare("SELECT (SELECT COUNT(*) FROM quimicos WHERE centro_id = ?) + (SELECT COUNT(*) FROM material_limpieza WHERE centro_id = ?) + (SELECT COUNT(*) FROM maquinaria WHERE centro_id = ?) + (SELECT COUNT(*) FROM epis WHERE centro_id = ?) + (SELECT COUNT(*) FROM ropa_trabajo WHERE centro_id = ?) AS n").bind(Number(row.id), Number(row.id), Number(row.id), Number(row.id), Number(row.id)).first();
    if (q && Number(q.n) > 0) return `No se puede eliminar: ${q.n} registros de material están asignados a este centro`;
    const u = await db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE centro_id = ?").bind(Number(row.id)).first();
    if (u && Number(u.n) > 0) return `No se puede eliminar: ${u.n} usuarios están asignados a este centro`;
    return null;
  },
};
export const quimicos = createCrud(quimicosSpec);
export const material = createCrud(materialSpec);
export const maquinaria = createCrud(maquinariaSpec);
export const centros = createCrud(centrosSpecForDelete);
export const usuarios = createCrud(usuariosSpec);
export const epis = createCrud(episSpec);
export const ropa = createCrud(ropaSpec);
export const tallas = createCrud(tallasSpec);
export const entregas = createCrud(entregasSpec);
// ---- Tipos de maquinaria (CRUD gestionado) ----
export const tiposSpec: CrudSpec = {
  table: "tipos_maquinaria", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true, unique: true, maxLength: 80 },
    { name: "notas", label: "Notas", type: "textarea", required: false, maxLength: 2000 },
  ],
  beforeWrite: async (db, data, mode, existing) => {
    // Al renombrar un tipo, se propaga a las máquinas que lo usan.
    if (mode === "update" && existing && typeof data.nombre === "string" && data.nombre !== String(existing.nombre)) {
      await db.prepare("UPDATE maquinaria SET tipo = ?, updated_at = datetime('now') WHERE tipo = ?").bind(data.nombre, String(existing.nombre)).run();
    }
    return data;
  },
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM maquinaria WHERE tipo = ?").bind(String(row.nombre)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} máquinas usan este tipo`;
    return null;
  },
};
// ---- Puntos de consumo (centro → zona → subzona, con su producto) ----
export const puntosSpec: CrudSpec = {
  table: "puntos_consumo", orderBy: "id", refCentro: true,
  extraJoins: [
    " LEFT JOIN quimicos q ON q.id = t.producto_id AND t.producto_tipo = 'quimicos'",
    " LEFT JOIN material_limpieza m ON m.id = t.producto_id AND t.producto_tipo = 'material_limpieza'",
  ],
  extraSelect: [
    "(t.producto_tipo || ':' || t.producto_id) AS producto",
    "COALESCE(q.nombre, m.nombre) AS producto_nombre",
    "COALESCE(q.num_garrafas, m.cantidad) AS producto_stock",
    "q.numero_lote AS producto_lote", "m.color AS producto_color",
    "COALESCE((SELECT s2.nombre FROM subzonas s2 WHERE s2.id = t.subzona_id), t.subzona) AS subzona_nombre",
    "(SELECT z2.nombre FROM zonas z2 WHERE z2.id = (SELECT s3.zona_id FROM subzonas s3 WHERE s3.id = t.subzona_id)) AS zona_nombre",
  ],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del punto", type: "text", required: true, maxLength: 120 },
    centro,
    { name: "subzona_id", label: "Subzona (de «Zonas y subzonas»)", type: "integer", required: false, min: 1 },
    { name: "producto", label: "Producto del punto", type: "text", required: true, maxLength: 60, writeOnly: true, placeholder: "quimicos:1" },
  ],
  beforeWrite: async (db, data) => {
    if (data.subzona_id !== undefined && data.subzona_id !== null && data.subzona_id !== "") {
      const s = await db.prepare("SELECT id FROM subzonas WHERE id = ?").bind(Number(data.subzona_id)).first();
      if (!s) throw new ValidationError("La subzona seleccionada no existe");
    }
    if (typeof data.producto === "string") {
      const [tipo, idStr] = data.producto.split(":");
      const id = Number(idStr);
      if (!(tipo === "quimicos" || tipo === "material_limpieza") || !Number.isInteger(id) || id < 1) {
        throw new ValidationError("El producto del punto no es válido");
      }
      const tabla = tipo === "quimicos" ? "quimicos" : "material_limpieza";
      const row = await db.prepare(`SELECT id FROM ${tabla} WHERE id = ?`).bind(id).first();
      if (!row) throw new ValidationError("El producto seleccionado no existe");
      data.producto_tipo = tipo; data.producto_id = id;
      delete data.producto;
    }
    return data;
  },
};
// ---- Zonas y subzonas por centro ----
export const zonasSpec: CrudSpec = {
  table: "zonas", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "centro_id", label: "Centro", type: "integer", required: true, min: 1 },
    { name: "nombre", label: "Nombre de la zona", type: "text", required: true, maxLength: 80 },
    { name: "notas", label: "Notas", type: "textarea", required: false, maxLength: 2000 },
  ],
  beforeWrite: async (db, data, mode, existing) => {
    if (typeof data.nombre === "string" && data.centro_id !== undefined) {
      const dup = await db.prepare("SELECT id FROM zonas WHERE centro_id = ? AND nombre = ?").bind(Number(data.centro_id), data.nombre).first();
      if (dup && (mode === "insert" || Number(dup.id) !== Number(existing?.id))) {
        throw new ValidationError("Ya existe una zona con ese nombre en este centro");
      }
    }
    return data;
  },
};
export const subzonasSpec: CrudSpec = {
  table: "subzonas", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  extraJoins: [" LEFT JOIN zonas z ON z.id = t.zona_id"],
  extraSelect: ["z.nombre AS zona_nombre", "z.centro_id AS zona_centro_id", "(SELECT c.nombre FROM centros c WHERE c.id = z.centro_id) AS centro_nombre"],
  extraSearchCols: ["z.nombre"],
  fields: [
    { name: "zona_id", label: "Zona", type: "integer", required: true, min: 1 },
    { name: "nombre", label: "Nombre de la subzona", type: "text", required: true, maxLength: 80 },
    { name: "notas", label: "Notas", type: "textarea", required: false, maxLength: 2000 },
  ],
  beforeWrite: async (db, data) => {
    if (data.zona_id !== undefined) {
      const z = await db.prepare("SELECT id FROM zonas WHERE id = ?").bind(Number(data.zona_id)).first();
      if (!z) throw new ValidationError("La zona seleccionada no existe");
    }
    return data;
  },
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM puntos_consumo WHERE subzona_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} puntos de consumo usan esta subzona`;
    return null;
  },
};
export const movimientos = createCrud(movimientosSpec);
export const zonas = createCrud(zonasSpec);
export const subzonas = createCrud(subzonasSpec);
// Asignación de 1 o varios centros a un usuario (los admin no llevan centro).
usuarios.put("/:id/centros", requireAuth, async (c) => {
  if (c.get("user").rol !== "admin") return c.json({ error: "No tienes permiso para asignar centros" }, 403);
  const id = Number(c.req.param("id"));
  const user = await c.env.DB.prepare("SELECT id FROM usuarios WHERE id = ?").bind(id).first();
  if (!user) return c.json({ error: "Usuario no encontrado" }, 404);
  let body: { centros?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
  if (!Array.isArray(body.centros)) return c.json({ error: "Falta la lista de centros" }, 400);
  const ids = [...new Set(body.centros.map((n) => Number(n)))].filter((n) => Number.isInteger(n) && n >= 1);
  for (const centroId of ids) {
    const ce = await c.env.DB.prepare("SELECT id FROM centros WHERE id = ?").bind(centroId).first();
    if (!ce) return c.json({ error: `El centro ${centroId} no existe` }, 400);
  }
  await c.env.DB.prepare("DELETE FROM usuario_centros WHERE usuario_id = ?").bind(id).run();
  const ins = c.env.DB.prepare("INSERT INTO usuario_centros (usuario_id, centro_id) VALUES (?, ?)");
  for (const centroId of ids) await ins.bind(id, centroId).run();
  return c.json({ ok: true, centros: ids });
});
export const tipos = createCrud(tiposSpec);
// Punto de consumo: al escanear su QR se descuenta 1 unidad del producto.
export const puntos = createCrud(puntosSpec);
puntos.post("/:id/consumir", requireAuth, async (c) => {
  const id = Number(c.req.param("id"));
  const p = await c.env.DB.prepare(`SELECT p.nombre, p.zona, p.subzona, p.producto_tipo, p.producto_id,
    (SELECT s.nombre FROM subzonas s WHERE s.id = p.subzona_id) AS subzona_nombre,
    (SELECT z.nombre FROM zonas z WHERE z.id = (SELECT s2.zona_id FROM subzonas s2 WHERE s2.id = p.subzona_id)) AS zona_nombre
    FROM puntos_consumo p WHERE p.id = ?`).bind(id).first();
  if (!p) return c.json({ error: "Punto de consumo no encontrado" }, 404);
  let body: { cantidad?: unknown };
  try { body = await c.req.json(); } catch { body = {}; }
  const cantidad = body.cantidad === undefined ? 1 : Number(body.cantidad);
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 100) return c.json({ error: "La cantidad debe ser un número entero entre 1 y 100" }, 400);
  const tipo = String(p.producto_tipo), productoId = Number(p.producto_id);
  const tabla = tipo === "quimicos" ? "quimicos" : "material_limpieza";
  const columna = tipo === "quimicos" ? "num_garrafas" : "cantidad";
  const upd = await c.env.DB.prepare(
    `UPDATE ${tabla} SET ${columna} = ${columna} - ?, updated_at = datetime('now') WHERE id = ? AND ${columna} >= ?`,
  ).bind(cantidad, productoId, cantidad).run();
  if (Number((upd.meta as { changes?: number }).changes ?? 0) === 0) {
    const row = await c.env.DB.prepare(`SELECT ${columna} AS stock FROM ${tabla} WHERE id = ?`).bind(productoId).first();
    const restantes = Number(row?.stock ?? 0);
    return c.json({ error: `Stock insuficiente: queda${restantes === 1 ? "" : "n"} ${restantes}` }, 400);
  }
  const prod = await c.env.DB.prepare(`SELECT id, nombre, ${columna} AS stock, coste_unitario FROM ${tabla} WHERE id = ?`).bind(productoId).first();
  const ubicacion = [p.nombre, p.zona_nombre ?? p.zona, p.subzona_nombre ?? p.subzona].filter(Boolean).join(" · ");
  const coste = Number(((Number(prod?.coste_unitario ?? 0) || 0) * cantidad).toFixed(2));
  await logMovimiento(c.env.DB, c.get("user"), "consumo", tabla, productoId, `${String(prod?.nombre ?? "Producto")} → punto ${ubicacion}`, cantidad, coste, null);
  return c.json({ ok: true, item: prod, mensaje: `Descontada${cantidad === 1 ? "" : "s"} ${cantidad} unidad${cantidad === 1 ? "" : "es"} en ${ubicacion}` });
});
