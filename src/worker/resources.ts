import type { CrudSpec } from "./crud";
import { createCrud, ValidationError, hashPasswordField, hoyISO } from "./crud";
import { requireAuth } from "./auth";
import { movimientosSpec } from "./movimientos";
import { seedHistorial } from "./maquinaria-historial";

export const COLORES = ["Rojo", "Azul", "Verde", "Amarillo", "Blanco", "Negro", "Naranja", "Morado", "Gris", "Marrón", "Otro"];
export const TIPOS_MAQUINARIA = ["Fregadora", "Aspiradora", "Monobrocha", "Hidrolavadora", "Barredora", "Robot", "Carro de limpieza", "Otro"];
export const ROLES = ["admin", "admin_centros", "usuario"];
// Origen del consumible (químicos y material de limpieza): de fábrica o de la
// empresa gestora. Solo se admiten estos dos valores.
export const ORIGENES = ["fabrica", "empresa"] as const;
const origen = { name: "origen", label: "Origen", type: "enum" as const, required: false, enumValues: [...ORIGENES] };
// Estado de un producto químico: Activo, Agotado o Descartado.
const ESTADOS = ["activo", "agotado", "descartado"] as const;
const centro = { name: "centro_id", label: "Centro", type: "integer" as const, required: false, placeholder: "Sin centro asignado" };
const notas = { name: "notas", label: "Notas", type: "textarea" as const, required: false, maxLength: 2000 };
// Foto en base64 (el cliente la recimensiona antes de enviarla).
const foto = { name: "foto", label: "Foto", type: "text" as const, required: false, writeOnly: true, maxLength: 1500000 };
const stockMinimo = { name: "stock_minimo", label: "Stock mínimo (alerta)", type: "integer" as const, required: false, min: 0 };
// Precio unitario opcional: alimenta el «valor del inventario» de los
// informes. Los productos sin precio conocido quedan en NULL y no suman.
const precio = (label: string) => ({ name: "precio", label, type: "number" as const, required: false, min: 0, placeholder: "Opcional" });
// Stock mínimo de los químicos medido en litros (no en garrafas).
const stockMinimoLitros = { name: "stock_minimo", label: "Stock mínimo en litros (L)", type: "number" as const, required: true, min: 0 };
// Stock máximo del producto en litros: vacío o 0 significa «sin máximo».
const stockMaximoLitros = { name: "stock_maximo", label: "Stock máximo en litros (L)", type: "number" as const, required: false, min: 0 };
// El origen siempre queda con uno de los dos valores admitidos: si no viene en
// el payload (importaciones antiguas) se conserva el actual o se asume fábrica.
// También se asegura la fecha de entrada del lote: hoy en las altas y la que
// ya tuviera al editar (nunca se vacía, porque ordena el consumo FEFO).
const normalizaOrigen = async (_db: unknown, data: Record<string, unknown>, mode: "insert" | "update", existing?: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const raw = typeof data.origen === "string" ? data.origen.trim().toLowerCase() : "";
  const esOrigen = (v: string): v is (typeof ORIGENES)[number] => (ORIGENES as readonly string[]).includes(v);
  data.origen = esOrigen(raw) ? raw
    : mode === "update" && typeof existing?.origen === "string" && esOrigen(existing.origen) ? existing.origen
    : "fabrica";
  if (data.fecha_entrada === undefined || data.fecha_entrada === null || data.fecha_entrada === "") {
    data.fecha_entrada = mode === "insert" ? hoyISO() : existing?.fecha_entrada ?? null;
  }
  // El producto no puede quedar con 0 litros por garrafa: con él se convierten
  // los litros de cada lote en garrafas en el inventario.
  if (data.litros_por_garrafa !== undefined && Number(data.litros_por_garrafa) <= 0) {
    throw new ValidationError("Litros por garrafa (L): debe ser mayor que 0");
  }
  // El alta desde la pestaña «Químicos» da de alta el PRODUCTO: todavía no tiene
  // lote. La columna es NOT NULL, así que se queda vacía; las filas con lote son
  // las entradas creadas desde «Inventario por producto».
  if (mode === "insert" && (data.numero_lote === undefined || data.numero_lote === null || data.numero_lote === "")) {
    data.numero_lote = "";
    if (data.num_garrafas === undefined || data.num_garrafas === null) data.num_garrafas = 0;
  }
  return data;
};

export const quimicosSpec: CrudSpec = {
  table: "quimicos", orderBy: "id", refCentro: true, computed: "t.litros_por_garrafa * t.num_garrafas AS total_litros",
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    // ── Ficha del producto (pestaña «Químicos»): todo obligatorio salvo foto ──
    { name: "codigo", label: "Código de producto", type: "text", required: true, maxLength: 40 },
    { name: "marca", label: "Marca", type: "text", required: true, maxLength: 80 },
    { name: "nombre", label: "Nombre de producto", type: "text", required: true, maxLength: 200 },
    { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true, min: 0 },
    stockMinimoLitros,
    stockMaximoLitros,
    { name: "estado", label: "Estado", type: "enum", required: true, enumValues: [...ESTADOS] },
    { ...centro, required: true },
    foto,
    // ── Datos del lote (pestaña «Inventario por producto») ──────────────────
    { name: "numero_lote", label: "Nº de lote", type: "text", required: false, maxLength: 60 },
    { name: "num_garrafas", label: "Nº de garrafas", type: "number", required: false, min: 0 },
    // Recepción del lote en almacén: ordena el consumo FEFO junto a la caducidad.
    { name: "fecha_entrada", label: "Fecha de entrada", type: "date", required: false },
    { name: "fecha_produccion", label: "Fecha de fabricación", type: "date", required: false },
    { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", required: false },
    precio("Precio por garrafa (€)"), origen, notas,
  ],
  beforeWrite: async (db, data, mode, existing) => {
    const out = await normalizaOrigen(db, data, mode, existing);
    // Stock máximo en litros: vacío o 0 queda guardado como «sin máximo».
    if (out.stock_maximo === null || out.stock_maximo === undefined || out.stock_maximo === "") out.stock_maximo = 0;
    // El CÓDIGO es el que identifica al producto: no puede repetirse. La
    // comprobación se limita a las fichas (fila sin lote), porque los lotes
    // heredan el código de su producto.
    const codigo = typeof out.codigo === "string" ? out.codigo.trim() : "";
    const esFicha = mode === "update"
      ? String(existing?.numero_lote ?? "").trim() === ""
      : String(out.numero_lote ?? "").trim() === "";
    if (codigo && esFicha) {
      let sql = "SELECT id FROM quimicos WHERE TRIM(COALESCE(codigo, '')) = ? COLLATE NOCASE AND TRIM(COALESCE(numero_lote, '')) = ''";
      const params: unknown[] = [codigo];
      if (mode === "update") { sql += " AND id != ?"; params.push(Number(existing?.id)); }
      const dup = await db.prepare(sql).bind(...params).first();
      if (dup) throw new ValidationError(`Código de producto: ya existe un producto con el código «${codigo}»`);
    }
    return out;
  },
};
export const materialSpec: CrudSpec = {
  table: "material_limpieza", orderBy: "id", refCentro: true,
  // El tipo de consumible del producto (clasificación para filtrarlo en
  // «Puntos de consumo»): se muestra junto a su nombre.
  extraJoins: [" LEFT JOIN consumibles_tipos tcon ON tcon.id = t.tipo_consumible_id"],
  extraSelect: ["tcon.nombre AS tipo_consumible_nombre"],
  extraSearchCols: ["tcon.nombre"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: false, unique: true, maxLength: 40 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "nombre", label: "Material", type: "text", required: true, maxLength: 200 },
    { name: "color", label: "Color", type: "enum", required: true, enumValues: COLORES },
    { name: "tipo_consumible_id", label: "Tipo de consumible", type: "integer", required: false, min: 1 },
    { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true, min: 0 },
    stockMinimo, precio("Precio por unidad (€)"), origen, centro, notas, foto,
  ],
  // IMPORTANTE: aquí NO vale `normalizaOrigen` (la de los químicos): insertaba
  // `numero_lote`, `num_garrafas` y `fecha_entrada`, columnas que no existen en
  // `material_limpieza`, y el alta fallaba con un 500 «Error interno».
  beforeWrite: async (db, data, mode, existing) => {
    // Origen: siempre uno de los dos admitidos; al editar se conserva el actual.
    const esOrigen = (v: unknown): v is (typeof ORIGENES)[number] => typeof v === "string" && (ORIGENES as readonly string[]).includes(v);
    const actual = mode === "update" && esOrigen(existing?.origen) ? existing.origen : null;
    data.origen = esOrigen(data.origen) ? data.origen : actual ?? "fabrica";
    // Tipo de consumible opcional, pero si se indica debe existir en la
    // pestaña «Tipos de consumible».
    if (data.tipo_consumible_id !== undefined && data.tipo_consumible_id !== null) {
      const t = await db.prepare("SELECT id FROM consumibles_tipos WHERE id = ?").bind(Number(data.tipo_consumible_id)).first();
      if (!t) throw new ValidationError("El tipo de consumible seleccionado no existe");
    }
    return data;
  },
};
// Máquinas: solo sus datos (marca, modelo, nº de serie, tipo) y su ubicación
// (centro → zona → subzona). Sin cantidad y sin estado editable: el estado es
// el último registro del histórico (columna derivada `estado`, sincronizada).
export const maquinariaSpec: CrudSpec = {
  // La tabla de máquinas se muestra ordenada por tipo (luego por nombre).
  table: "maquinaria", orderBy: "tipo", refCentro: true,
  extraJoins: [" LEFT JOIN zonas z ON z.id = t.zona_id", " LEFT JOIN subzonas sb ON sb.id = t.subzona_id"],
  extraSelect: [
    "z.nombre AS zona_nombre",
    "sb.nombre AS subzona_nombre",
    `COALESCE((SELECT st.nombre FROM maquinaria_historial h JOIN situaciones st ON st.id = h.situacion_id
      WHERE h.maquina_id = t.id ORDER BY h.fecha DESC, h.id DESC LIMIT 1), t.estado) AS estado`,
  ],
  extraSearchCols: ["z.nombre", "sb.nombre"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Máquina", type: "text", required: false, maxLength: 200 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "tipo", label: "Tipo", type: "text", required: true, maxLength: 80 },
    { name: "numero_serie", label: "Nº de serie", type: "text", required: false, maxLength: 60 },
    { name: "centro_id", label: "Centro", type: "integer", required: true, min: 1 },
    { name: "zona_id", label: "Zona", type: "integer", required: true, min: 1 },
    { name: "subzona_id", label: "Subzona", type: "integer", required: false, min: 1 },
    notas, foto,
  ],
  beforeWrite: async (db, data, mode, existing) => {
    if (typeof data.tipo === "string" && data.tipo.trim()) {
      const t = await db.prepare("SELECT id FROM tipos_maquinaria WHERE nombre = ?").bind(data.tipo.trim()).first();
      if (!t) throw new ValidationError("El tipo debe existir en la pestaña «Tipos de maquinaria»");
    }
    // Nombre interno (para búsquedas y auditoría): si no viene en el payload
    // (el formulario ya no lo pide) se deriva de marca + modelo + tipo.
    if (typeof data.nombre !== "string" || !data.nombre.trim()) {
      delete data.nombre;
      const marca = String(data.marca ?? existing?.marca ?? "").trim();
      const modelo = String(data.modelo ?? existing?.modelo ?? "").trim();
      const tipo = String(data.tipo ?? existing?.tipo ?? "").trim();
      const auto = `${marca} ${modelo}`.trim() || tipo;
      if (auto) data.nombre = auto;
      else if (mode === "insert") data.nombre = "Máquina";
    }
    // Ubicación: la zona debe pertenecer al centro y la subzona a la zona.
    if (data.zona_id === undefined || data.zona_id === null) throw new ValidationError("La zona es obligatoria");
    const zona = await db.prepare("SELECT id, centro_id FROM zonas WHERE id = ?").bind(Number(data.zona_id)).first();
    if (!zona) throw new ValidationError("La zona seleccionada no existe");
    if (data.centro_id !== undefined && data.centro_id !== null && Number(data.centro_id) !== Number(zona.centro_id)) {
      throw new ValidationError("La zona elegida no pertenece a ese centro");
    }
    data.centro_id = Number(zona.centro_id);
    if (data.subzona_id !== undefined && data.subzona_id !== null) {
      const sub = await db.prepare("SELECT id, zona_id FROM subzonas WHERE id = ?").bind(Number(data.subzona_id)).first();
      if (!sub) throw new ValidationError("La subzona seleccionada no existe");
      if (Number(sub.zona_id) !== Number(data.zona_id)) throw new ValidationError("La subzona no pertenece a la zona elegida");
    }
    return data;
  },
  afterWrite: async (db, _user, row, mode) => {
    // Toda máquina nueva nace con su primer registro del histórico (Operativo).
    if (mode === "insert") await seedHistorial(db, row);
  },
};
// ---- Situaciones de la maquinaria (catálogo del histórico) ----
export const situacionesSpec: CrudSpec = {
  table: "situaciones", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Situación", type: "text", required: true, unique: true, maxLength: 80 },
  ],
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT COUNT(*) AS n FROM maquinaria_historial WHERE situacion_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} registros del histórico usan esta situación`;
    return null;
  },
};
export const centrosSpec: CrudSpec = {
  table: "centros", orderBy: "id", read: "all", create: "centros", update: "centros", delete: "centros",
  fields: [
    { name: "nombre", label: "Nombre del centro", type: "text", required: true, unique: true, maxLength: 120 },
    { name: "direccion", label: "Dirección", type: "text", required: false, maxLength: 200 },
    { name: "ciudad", label: "Ciudad", type: "text", required: false, maxLength: 100 },
    { name: "responsable", label: "Responsable", type: "text", required: false, maxLength: 120 },
    { name: "telefono", label: "Teléfono", type: "text", required: false, maxLength: 40 },
  ],
};
export const usuariosSpec: CrudSpec = {
  table: "usuarios", orderBy: "id", read: "admin", create: "admin", update: "admin", delete: "admin",
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
    // Limpia centros asignados, tallas/entregas, códigos de acceso y la
    // auditoría que tenía como autor (FK a usuarios: sin esto el borrado viola la clave).
    await db.prepare("DELETE FROM movimientos WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM usuario_centros WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM tallas_operarios WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM ropa_entregas WHERE usuario_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM login_codes WHERE user_id = ?").bind(Number(row.id)).run();
    await db.prepare("DELETE FROM password_recovery_tokens WHERE user_id = ?").bind(Number(row.id)).run();
    return null;
  },
};
// ---- EPIs (equipos de protección individual) ----
export const episSpec: CrudSpec = {
  table: "epis", orderBy: "id", refCentro: true,
  extraJoins: [" LEFT JOIN tipos_equipo te ON te.id = t.tipo_equipo_id"],
  extraSelect: ["te.nombre AS tipo_equipo_nombre"],
  extraSearchCols: ["te.nombre"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true, unique: true, maxLength: 40 },
    { name: "tipo_equipo_id", label: "Tipo de equipo", type: "integer", required: false, min: 1 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "talla", label: "Talla (opcional)", type: "text", required: false, maxLength: 20 },
    { name: "descripcion", label: "Descripción", type: "textarea", required: false, maxLength: 2000 },
    { name: "color", label: "Color", type: "enum", required: false, enumValues: COLORES },
    { name: "stock", label: "Stock", type: "integer", required: true, min: 0 },
    stockMinimo, precio("Precio por unidad (€)"),
    { name: "fecha_revision", label: "Próxima revisión", type: "date", required: false },
    centro,
  ],
  beforeWrite: async (db, data) => {
    if (data.tipo_equipo_id !== undefined && data.tipo_equipo_id !== null) {
      const t = await db.prepare("SELECT id FROM tipos_equipo WHERE id = ?").bind(Number(data.tipo_equipo_id)).first();
      if (!t) throw new ValidationError("El tipo de equipo seleccionado no existe");
    }
    return data;
  },
};
// ---- Ropa de trabajo de los centros ----
// Catálogo de prendas del almacén: código, marca, fabricante, modelo, talla,
// A/V, manga larga, color y stock (alerta por stock mínimo).
export const ropaSpec: CrudSpec = {
  table: "ropa_trabajo", orderBy: "id", refCentro: true,
  extraJoins: [" LEFT JOIN tipos_equipo te ON te.id = t.tipo_equipo_id"],
  extraSelect: ["te.nombre AS tipo_equipo_nombre"],
  extraSearchCols: ["te.nombre"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true, unique: true, maxLength: 40 },
    { name: "prenda", label: "Prenda", type: "text", required: true, maxLength: 120 },
    { name: "tipo_equipo_id", label: "Tipo de equipo", type: "integer", required: false, min: 1 },
    { name: "marca", label: "Marca", type: "text", required: false, maxLength: 80 },
    { name: "fabricante", label: "Fabricante", type: "text", required: false, maxLength: 80 },
    { name: "modelo", label: "Modelo", type: "text", required: false, maxLength: 80 },
    { name: "talla", label: "Talla", type: "text", required: false, maxLength: 20 },
    { name: "alta_visibilidad", label: "Alta visibilidad", type: "boolean", required: true },
    { name: "manga_larga", label: "Manga larga", type: "boolean", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea", required: false, maxLength: 2000 },
    { name: "color", label: "Color", type: "enum", required: false, enumValues: COLORES },
    { name: "stock", label: "Stock", type: "integer", required: true, min: 0 },
    stockMinimo, precio("Precio por unidad (€)"), centro,
  ],
  beforeWrite: async (db, data) => {
    if (data.tipo_equipo_id !== undefined && data.tipo_equipo_id !== null) {
      const t = await db.prepare("SELECT id FROM tipos_equipo WHERE id = ?").bind(Number(data.tipo_equipo_id)).first();
      if (!t) throw new ValidationError("El tipo de equipo seleccionado no existe");
    }
    return data;
  },
};
export const centrosSpecForDelete: CrudSpec = {
  ...centrosSpec,
  beforeDelete: async (db, _user, row) => {
    const q = await db.prepare("SELECT (SELECT COUNT(*) FROM quimicos WHERE centro_id = ?) + (SELECT COUNT(*) FROM material_limpieza WHERE centro_id = ?) + (SELECT COUNT(*) FROM maquinaria WHERE centro_id = ?) + (SELECT COUNT(*) FROM epis WHERE centro_id = ?) + (SELECT COUNT(*) FROM ropa_trabajo WHERE centro_id = ?) + (SELECT COUNT(*) FROM estaciones WHERE centro_id = ?) + (SELECT COUNT(*) FROM ropa_entregas WHERE centro_id = ?) AS n").bind(Number(row.id), Number(row.id), Number(row.id), Number(row.id), Number(row.id), Number(row.id), Number(row.id)).first();
    if (q && Number(q.n) > 0) return `No se puede eliminar: ${q.n} registros de material, estaciones o entregas siguen asignados a este centro`;
    const u = await db.prepare("SELECT COUNT(*) AS n FROM usuario_centros WHERE centro_id = ?").bind(Number(row.id)).first();
    if (u && Number(u.n) > 0) return `No se puede eliminar: ${u.n} usuarios están asignados a este centro`;
    return null;
  },
};
export const quimicos = createCrud(quimicosSpec);
export const material = createCrud(materialSpec);
export const maquinaria = createCrud(maquinariaSpec);
export const situaciones = createCrud(situacionesSpec);
export const centros = createCrud(centrosSpecForDelete);
export const usuarios = createCrud(usuariosSpec);
export const epis = createCrud(episSpec);
export const ropa = createCrud(ropaSpec);
// 'tallas' (historial por operario) ahora vive en su propio módulo /
// sección del frontend; no se expone desde aquí.
// ---- Tipos de maquinaria (CRUD gestionado) ----
export const tiposSpec: CrudSpec = {
  // La lista de tipos de maquinaria se muestra ordenada por nombre.
  table: "tipos_maquinaria", orderBy: "nombre", read: "all", create: "admin", update: "admin", delete: "admin",
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
// ---- Soportes (dónde se instala una estación de consumo) ----
export const soportesSpec: CrudSpec = {
  table: "soportes", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del soporte", type: "text", required: true, unique: true, maxLength: 80 },
  ],
};
// ---- Tipos de consumible (qué artículo consume cada estación) ----
export const consumiblesTiposSpec: CrudSpec = {
  table: "consumibles_tipos", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true, unique: true, maxLength: 80 },
    { name: "articulo_tipo", label: "Tipo de artículo", type: "enum", required: true, enumValues: ["quimicos", "material_limpieza", "maquinaria"] },
  ],
};
// ---- Tipos de equipo (abrigo, camiseta, tapones de oídos…) de ropa y EPIs ----
export const tiposEquipoSpec: CrudSpec = {
  table: "tipos_equipo", orderBy: "id", read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true, unique: true, maxLength: 80 },
  ],
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT (SELECT COUNT(*) FROM ropa_trabajo WHERE tipo_equipo_id = ?) + (SELECT COUNT(*) FROM epis WHERE tipo_equipo_id = ?) AS n")
      .bind(Number(row.id), Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} prendas o EPIs usan este tipo`;
    return null;
  },
};
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
  beforeDelete: async (db, _user, row) => {
    const n = await db.prepare("SELECT (SELECT COUNT(*) FROM subzonas WHERE zona_id = ?) + (SELECT COUNT(*) FROM estaciones WHERE zona_id = ?) AS n").bind(Number(row.id), Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} subzonas o estaciones usan esta zona`;
    return null;
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
    const n = await db.prepare("SELECT COUNT(*) AS n FROM estaciones WHERE subzona_id = ?").bind(Number(row.id)).first();
    if (n && Number(n.n) > 0) return `No se puede eliminar: ${n.n} estaciones usan esta subzona`;
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
// RGPD: exportación de los datos personales de un usuario (perfil, centros,
// tallas y entregas). Solo administradores.
usuarios.get("/:id/datos", requireAuth, async (c) => {
  if (c.get("user").rol !== "admin") return c.json({ error: "Requiere permisos de administrador" }, 403);
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id < 1) return c.json({ error: "Usuario no válido" }, 400);
  const db = c.env.DB;
  const usuario = await db.prepare(
    "SELECT id, username, nombre, email, rol, activo, created_at FROM usuarios WHERE id = ?",
  ).bind(id).first();
  if (!usuario) return c.json({ error: "Usuario no encontrado" }, 404);
  const [centros, tallas, entregas] = await Promise.all([
    db.prepare("SELECT c.id, c.nombre FROM usuario_centros uc JOIN centros c ON c.id = uc.centro_id WHERE uc.usuario_id = ? ORDER BY c.nombre").bind(id).all(),
    db.prepare("SELECT prenda, talla, fecha, notas, created_at FROM tallas_operarios WHERE usuario_id = ? ORDER BY fecha DESC, id DESC").bind(id).all(),
    db.prepare("SELECT fecha, prenda, articulo_tipo, cantidad, talla, color, centro_id, created_at FROM ropa_entregas WHERE usuario_id = ? ORDER BY fecha DESC, id DESC").bind(id).all(),
  ]);
  return c.json({
    exportado: new Date().toISOString(),
    aviso: "Exportación de datos personales (RGPD) generada desde Inventarios.",
    usuario, centros: centros.results, tallas: tallas.results, entregas: entregas.results,
  });
});
export const tipos = createCrud(tiposSpec);
export const tiposEquipo = createCrud(tiposEquipoSpec);
// ---- Soportes y tipos de consumible (listas gestionadas de estaciones) ----
export const soportes = createCrud(soportesSpec);
export const consumiblesTipos = createCrud(consumiblesTiposSpec);
