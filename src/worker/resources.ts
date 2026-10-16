import type { CrudSpec } from "./crud";
import { createCrud, ValidationError, hashPasswordField } from "./crud";

export const COLORES = ["Rojo", "Azul", "Verde", "Amarillo", "Blanco", "Negro", "Naranja", "Morado", "Gris", "Otro"];
export const TIPOS_MAQUINARIA = ["Fregadora", "Aspiradora", "Monobrocha", "Hidrolavadora", "Barredora", "Robot", "Carro de limpieza", "Otro"];
export const ESTADOS_MAQUINARIA = ["Operativa", "En reparación", "Averiada", "Baja"];
export const ROLES = ["admin", "usuario"];
const centro = { name: "centro_id", label: "Centro", type: "integer" as const, required: false, placeholder: "Sin centro asignado" };
const notas = { name: "notas", label: "Notas", type: "textarea" as const, required: false, maxLength: 2000 };

export const quimicosSpec: CrudSpec = {
  table: "quimicos", orderBy: "id", refCentro: true, computed: "t.litros_por_garrafa * t.num_garrafas AS total_litros",
  read: "all", create: "all", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Producto", type: "text", required: true, maxLength: 200 },
    { name: "numero_lote", label: "Nº de lote", type: "text", required: true, maxLength: 60 },
    { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true, min: 0 },
    { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true, min: 0 },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", required: true }, centro, notas,
  ],
};
export const materialSpec: CrudSpec = {
  table: "material_limpieza", orderBy: "id", refCentro: true, read: "all", create: "all", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Material", type: "text", required: true, maxLength: 200 },
    { name: "color", label: "Color", type: "enum", required: true, enumValues: COLORES },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 }, centro, notas,
  ],
};
export const maquinariaSpec: CrudSpec = {
  table: "maquinaria", orderBy: "id", refCentro: true, read: "all", create: "all", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Máquina", type: "text", required: true, maxLength: 200 },
    { name: "tipo", label: "Tipo", type: "enum", required: true, enumValues: TIPOS_MAQUINARIA },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    { name: "numero_serie", label: "Nº de serie", type: "text", required: false, maxLength: 60 },
    { name: "estado", label: "Estado", type: "enum", required: true, enumValues: ESTADOS_MAQUINARIA }, centro, notas,
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
    if (mode === "insert" && (data.password === undefined || data.password === "")) throw new ValidationError("La contraseña es obligatoria al crear un usuario");
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
    return null;
  },
};
export const centrosSpecForDelete: CrudSpec = {
  ...centrosSpec,
  beforeDelete: async (db, _user, row) => {
    const q = await db.prepare("SELECT (SELECT COUNT(*) FROM quimicos WHERE centro_id = ?) + (SELECT COUNT(*) FROM material_limpieza WHERE centro_id = ?) + (SELECT COUNT(*) FROM maquinaria WHERE centro_id = ?) AS n").bind(Number(row.id), Number(row.id), Number(row.id)).first();
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
