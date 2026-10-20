import type { CrudSpec } from "./crud";
import { createCrud, ValidationError, hashPasswordField } from "./crud";
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
    { name: "nombre", label: "Producto", type: "text", required: true, maxLength: 200 },
    { name: "numero_lote", label: "Nº de lote", type: "text", required: true, maxLength: 60 },
    { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true, min: 0 },
    { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true, min: 0 },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", required: true },
    stockMinimo, centro, notas, foto,
  ],
};
export const materialSpec: CrudSpec = {
  table: "material_limpieza", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Material", type: "text", required: true, maxLength: 200 },
    { name: "color", label: "Color", type: "enum", required: true, enumValues: COLORES },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    stockMinimo, centro, notas, foto,
  ],
};
export const maquinariaSpec: CrudSpec = {
  table: "maquinaria", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Máquina", type: "text", required: true, maxLength: 200 },
    { name: "tipo", label: "Tipo", type: "enum", required: true, enumValues: TIPOS_MAQUINARIA },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    { name: "numero_serie", label: "Nº de serie", type: "text", required: false, maxLength: 60 },
    { name: "estado", label: "Estado", type: "enum", required: true, enumValues: ESTADOS_MAQUINARIA }, centro, notas, foto,
  ],
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
  fields: [
    { name: "username", label: "Usuario (login)", type: "text", required: true, unique: true, maxLength: 60 },
    { name: "nombre", label: "Nombre completo", type: "text", required: true, maxLength: 120 },
    { name: "email", label: "Email", type: "text", required: false, maxLength: 200 },
    { name: "password", label: "Contraseña", type: "password", required: false, writeOnly: true, placeholder: "Déjalo en blanco para no cambiarla" },
    { name: "rol", label: "Rol", type: "enum", required: true, enumValues: ROLES },
    { name: "activo", label: "Activo", type: "boolean", required: true }, centro,
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
    // Limpia tallas e historial de entregas del operario eliminado.
    await db.prepare("DELETE FROM tallas_operarios WHERE usuario_id = ?").bind(Number(row.id)).run();
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
    { name: "fecha_revision", label: "Próxima revisión", type: "date", required: false }, centro,
  ],
};
// ---- Ropa de trabajo de los centros ----
export const ropaSpec: CrudSpec = {
  table: "ropa_trabajo", orderBy: "id", refCentro: true, read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true, unique: true, maxLength: 40 },
    { name: "prenda", label: "Prenda", type: "text", required: true, maxLength: 120 },
    { name: "fabricante", label: "Fabricante", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "talla", label: "Talla", type: "text", required: false, maxLength: 20 },
    { name: "alta_visibilidad", label: "Alta visibilidad", type: "boolean", required: true },
    { name: "manga_larga", label: "Manga larga", type: "boolean", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea", required: false, maxLength: 2000 },
    { name: "color", label: "Color", type: "enum", required: false, enumValues: COLORES },
    { name: "stock", label: "Stock", type: "integer", required: true, min: 0 },
    stockMinimo, centro,
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
    { name: "talla", label: "Talla", type: "text", required: true, maxLength: 20 },
    { name: "fecha", label: "Fecha", type: "date", required: false, placeholder: "Hoy si se deja en blanco" },
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
  extraSelect: ["r.prenda AS ropa_prenda", "r.codigo AS ropa_codigo", "p.nombre AS entregado_por_nombre"],
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
    await logMovimiento(db, user, mode === "insert" ? "entrega" : "entrega_editada", "ropa_trabajo", Number(row.ropa_id) || null,
      `${String(row.ropa_prenda ?? "Prenda")} → ${String(row.usuario_nombre ?? "operario")} (#${row.id})`, Number(row.cantidad) || null);
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
export const movimientos = createCrud(movimientosSpec);
