import type { D1Database } from "./d1";
import { hashPassword, toHex } from "./auth";

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS centros (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT, ciudad TEXT, responsable TEXT, telefono TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'usuario', activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
  // Cada fila de `quimicos` es un LOTE de producto: el mismo producto puede
  // llegar con varios lotes (distinto nº de lote y fechas) y el inventario los
  // suma por producto. `fecha_entrada` es la recepción del lote y `estado`
  // indica si sigue en uso (activo), si se gastó (agotado) o si se descartó en
  // un recuento (descartado).
  `CREATE TABLE IF NOT EXISTS quimicos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT, fecha_produccion TEXT, fecha_entrada TEXT, estado TEXT NOT NULL DEFAULT 'activo', stock_minimo INTEGER NOT NULL DEFAULT 0, stock_maximo INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS material_limpieza (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, color TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', foto TEXT, centro_id INTEGER REFERENCES centros(id), tipo_consumible_id INTEGER REFERENCES consumibles_tipos(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo TEXT NOT NULL, marca TEXT, modelo TEXT, numero_serie TEXT, estado TEXT NOT NULL DEFAULT 'Operativa', cantidad INTEGER NOT NULL DEFAULT 1, foto TEXT, centro_id INTEGER REFERENCES centros(id) ON DELETE SET NULL, zona_id INTEGER REFERENCES zonas(id) ON DELETE SET NULL, subzona_id INTEGER REFERENCES subzonas(id) ON DELETE SET NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS password_recovery_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  // Códigos de acceso por correo (login sin contraseña).
  `CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  // Control de intentos fallidos de login/códigos (anti fuerza bruta).
  `CREATE TABLE IF NOT EXISTS login_fallos (clave TEXT PRIMARY KEY, intentos INTEGER NOT NULL DEFAULT 0, primer_intento TEXT NOT NULL DEFAULT (datetime('now')), bloqueado_hasta TEXT)`,
  `CREATE TABLE IF NOT EXISTS epis (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, marca TEXT, modelo TEXT, talla TEXT, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, fecha_revision TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ropa_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, prenda TEXT NOT NULL, marca TEXT, fabricante TEXT, modelo TEXT, talla TEXT, alta_visibilidad INTEGER NOT NULL DEFAULT 0, manga_larga INTEGER NOT NULL DEFAULT 0, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tallas_operarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, prenda TEXT, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS empresa (id INTEGER PRIMARY KEY CHECK (id = 1), nombre TEXT, logo TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER, estacion_id INTEGER, descripcion TEXT, cantidad INTEGER, motivo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tipos_maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Tipos de equipo de la equipación (abrigo, camiseta, tapones de oídos…),
  // compartidos por ropa_trabajo y epis.
  `CREATE TABLE IF NOT EXISTS tipos_equipo (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Situaciones de la maquinaria (operativo, en reparación…): catálogo con
  // altas propias; el estado actual de cada máquina es su último registro del
  // histórico (se sincroniza en la columna `estado`).
  `CREATE TABLE IF NOT EXISTS situaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Histórico de máquinas: fecha + situación (estado) con la marca, modelo,
  // centro y notas del momento de registrarla.
  `CREATE TABLE IF NOT EXISTS maquinaria_historial (id INTEGER PRIMARY KEY AUTOINCREMENT, maquina_id INTEGER NOT NULL REFERENCES maquinaria(id) ON DELETE CASCADE, fecha TEXT NOT NULL DEFAULT (date('now')), situacion_id INTEGER NOT NULL REFERENCES situaciones(id), marca TEXT, modelo TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS zonas (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(centro_id, nombre))`,
  `CREATE TABLE IF NOT EXISTS subzonas (id INTEGER PRIMARY KEY AUTOINCREMENT, zona_id INTEGER NOT NULL REFERENCES zonas(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(zona_id, nombre))`,
  `CREATE TABLE IF NOT EXISTS usuario_centros (usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (usuario_id, centro_id))`,
  `CREATE TABLE IF NOT EXISTS soportes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS consumibles_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Estaciones de consumo (antes «puntos de consumo»): zona/subzona, soporte,
  // tipo de consumible y artículo del almacén que se descuenta al escanear.
  `CREATE TABLE IF NOT EXISTS estaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id), zona_id INTEGER NOT NULL REFERENCES zonas(id), subzona_id INTEGER REFERENCES subzonas(id), soporte_id INTEGER REFERENCES soportes(id), tipo_consumible_id INTEGER REFERENCES consumibles_tipos(id), articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', articulo_id INTEGER NOT NULL, activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Entrega de equipación: una fila por artículo entregado (referencia al
  // catálogo ropa_trabajo o epis + cantidad) con su operario y fecha. El
  // stock del artículo se descuenta al entregar y se reintegra al borrar.
  `CREATE TABLE IF NOT EXISTS ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER REFERENCES centros(id), fecha TEXT NOT NULL DEFAULT (date('now')), prenda TEXT NOT NULL, articulo_tipo TEXT, articulo_id INTEGER, cantidad INTEGER, talla TEXT, alta_visibilidad INTEGER, auxiliar_servicios INTEGER, manga_larga INTEGER, color TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Documentación: tipos de ficha (ficha de seguridad, técnica, manual de
  // maquinaria, instrucción de trabajo…) y fichas con URL y multi-centro.
  `CREATE TABLE IF NOT EXISTS documento_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo_id INTEGER NOT NULL REFERENCES documento_tipos(id), url TEXT NOT NULL, descripcion TEXT, fabricante TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documento_centros (documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (documento_id, centro_id))`,
  // Catálogo de productos que se pueden pedir (código, producto y precio).
  // Su código lo relaciona con `material_limpieza` (unidades en almacén) y
  // alimenta la pestaña «Pedido material».
  `CREATE TABLE IF NOT EXISTS productos_disponibles (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, producto TEXT NOT NULL, precio REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Líneas del pedido de material: código, producto, cantidad, precio y origen.
  // Al aplicar el pedido, las cantidades pendientes se suman en `material_limpieza`.
  `CREATE TABLE IF NOT EXISTS pedidos_material (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL, producto TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', aplicado INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Recuentos de inventario de químicos: una fila por recuento validado y una
  // por cada lote del listado (litros del sistema frente a los litros reales
  // contados). Es la «hoja de inventario» que deja por escrito qué lotes se
  // retiran y cuánta diferencia ha habido.
  `CREATE TABLE IF NOT EXISTS inventarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, lineas INTEGER NOT NULL DEFAULT 0, diferencia REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS inventarios_lineas (id INTEGER PRIMARY KEY AUTOINCREMENT, inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE, quimico_id INTEGER, nombre TEXT NOT NULL, marca TEXT, numero_lote TEXT, centro TEXT, litros_teoricos REAL NOT NULL DEFAULT 0, litros_reales REAL NOT NULL DEFAULT 0, diferencia REAL NOT NULL DEFAULT 0, estado TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
];

// Migraciones para tablas creadas antes de añadir estas columnas.
const ALTERS: Array<[string, string]> = [
  ["quimicos", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["quimicos", "foto TEXT"],
  // Valor del inventario: precio unitario opcional (NULL si no se conoce).
  ["quimicos", "precio REAL"], ["material_limpieza", "precio REAL"],
  ["epis", "precio REAL"], ["ropa_trabajo", "precio REAL"],
  ["material_limpieza", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["material_limpieza", "foto TEXT"],
  // Origen del consumible: si es de fábrica («fabrica») o de la empresa gestora («empresa»).
  ["quimicos", "origen TEXT NOT NULL DEFAULT 'fabrica'"],
  ["material_limpieza", "origen TEXT NOT NULL DEFAULT 'fabrica'"],
  ["maquinaria", "foto TEXT"],
  ["epis", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["epis", "fecha_revision TEXT"],
  ["ropa_trabajo", "talla TEXT"], ["ropa_trabajo", "stock_minimo INTEGER NOT NULL DEFAULT 0"],
  ["maquinaria", "cantidad INTEGER NOT NULL DEFAULT 1"],
  ["maquinaria", "zona_id INTEGER REFERENCES zonas(id) ON DELETE SET NULL"],
  ["maquinaria", "subzona_id INTEGER REFERENCES subzonas(id) ON DELETE SET NULL"],
  ["ropa_entregas", "articulo_tipo TEXT"], ["ropa_entregas", "articulo_id INTEGER"], ["ropa_entregas", "cantidad INTEGER"],
  ["ropa_trabajo", "tipo_equipo_id INTEGER"], ["epis", "tipo_equipo_id INTEGER"],
  ["tallas_operarios", "fecha TEXT NOT NULL DEFAULT (date('now'))"],
  ["tallas_operarios", "prenda TEXT"],
  ["movimientos", "updated_at TEXT"],
  ["quimicos", "codigo TEXT"], ["quimicos", "marca TEXT"],
  ["material_limpieza", "codigo TEXT"], ["material_limpieza", "marca TEXT"],
  // Tipo de consumible del producto: clasifica el material para poder
  // filtrarlo al buscar un consumible en «Puntos de consumo».
  ["material_limpieza", "tipo_consumible_id INTEGER REFERENCES consumibles_tipos(id)"],
  ["maquinaria", "marca TEXT"], ["maquinaria", "modelo TEXT"], ["maquinaria", "numero_serie TEXT"],
  ["ropa_trabajo", "marca TEXT"],
  ["movimientos", "motivo TEXT"],
  ["movimientos", "estacion_id INTEGER"],
  ["consumibles_tipos", "articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza'"],
  // Control de lotes: fecha de recepción y estado del lote (en uso, agotado,
  // descartado en un recuento).
  ["quimicos", "fecha_entrada TEXT"],
  ["quimicos", "estado TEXT NOT NULL DEFAULT 'activo'"],
  // Stock máximo del producto (en litros): 0 significa «sin máximo».
  ["quimicos", "stock_maximo INTEGER NOT NULL DEFAULT 0"],
  // Notas de cada registro del histórico de maquinaria.
  ["maquinaria_historial", "notas TEXT"],
];

async function dropColumnIfPresent(db: D1Database, table: string, column: string): Promise<void> {
  const info = await db.prepare(`PRAGMA table_info(${table})`).all();
  if (info.results.some((r) => r.name === column)) await db.prepare(`ALTER TABLE ${table} DROP COLUMN ${column}`).run();
}
async function tableExists(db: D1Database, table: string): Promise<boolean> {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first();
  return Boolean(row);
}

async function migrate(db: D1Database): Promise<void> {
  // tallas_operarios pasó a guardar histórico: se elimina la unicidad por operario.
  // SQLite no deja soltar un UNIQUE con DROP INDEX; hay que reconstruir la tabla.
  const idx = await db.prepare("PRAGMA index_list(tallas_operarios)").all();
  if (idx.results.some((r) => Number(r.unique) === 1)) {
    await db.prepare("CREATE TABLE tallas_operarios_new (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)").run();
    await db.prepare("INSERT INTO tallas_operarios_new (id, usuario_id, talla, notas, created_at, updated_at) SELECT id, usuario_id, talla, notas, created_at, updated_at FROM tallas_operarios").run();
    await db.prepare("DROP TABLE tallas_operarios").run();
    await db.prepare("ALTER TABLE tallas_operarios_new RENAME TO tallas_operarios").run();
  }
  for (const [table, ddl] of ALTERS) {
    const col = ddl.split(" ")[0];
    const info = await db.prepare(`PRAGMA table_info(${table})`).all();
    if (!info.results.some((r) => r.name === col)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${ddl}`).run();
  }
  // En los químicos la fecha de caducidad pasa a ser opcional y se añade la
  // fecha de producción (solo informativa). SQLite no permite quitarle NOT NULL
  // a una columna: se reconstruye la tabla conservando todos sus datos.
  const qInfo = await db.prepare("PRAGMA table_info(quimicos)").all();
  const qCols = qInfo.results.map((r) => String(r.name));
  const caducidadObligatoria = qInfo.results.some((r) => r.name === "fecha_caducidad" && Number(r.notnull) === 1);
  if (qCols.length > 0 && (caducidadObligatoria || !qCols.includes("fecha_produccion"))) {
    // Limpia los restos de un intento anterior por si el proceso se hubiera interrumpido.
    await db.prepare("DROP TABLE IF EXISTS quimicos_new").run();
    const destino = ["codigo", "marca", "nombre", "numero_lote", "litros_por_garrafa", "num_garrafas", "fecha_caducidad", "fecha_produccion", "fecha_entrada", "estado", "stock_minimo", "stock_maximo", "precio", "origen", "foto", "centro_id", "notas", "created_at", "updated_at"];
    // Se conservan el id (lo referencian estaciones y movimientos) y todas las
    // columnas conocidas que ya existan en la tabla antigua.
    const comunes = ["id", ...qCols.filter((c) => c !== "id" && destino.includes(c))];
    await db.prepare(`CREATE TABLE quimicos_new (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT, fecha_produccion TEXT, fecha_entrada TEXT, estado TEXT NOT NULL DEFAULT 'activo', stock_minimo INTEGER NOT NULL DEFAULT 0, stock_maximo INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`).run();
    await db.prepare(`INSERT INTO quimicos_new (${comunes.join(", ")}) SELECT ${comunes.join(", ")} FROM quimicos`).run();
    await db.prepare("DROP TABLE quimicos").run();
    await db.prepare("ALTER TABLE quimicos_new RENAME TO quimicos").run();
  }
  // Se elimina el coste de los consumibles: solo interesa la cantidad consumida.
  for (const [table, column] of [
    ["quimicos", "coste_unitario"], ["material_limpieza", "coste_unitario"],
    ["epis", "coste_unitario"], ["ropa_trabajo", "coste_unitario"],
    ["movimientos", "coste"],
  ] as Array<[string, string]>) await dropColumnIfPresent(db, table, column);
  // Entregas de ropa: la tabla guarda una fila por prenda entregada; las
  // tablas de la sección Ropa de trabajo (marca, modelo, tipo) se encargan de
  // conservar el catálogo de prendas, por lo que se eliminan las antiguas.
  if (await tableExists(db, "ropa_entregas")) {
    const info = await db.prepare("PRAGMA table_info(ropa_entregas)").all();
    if (info.results.some((r) => r.name === "ropa_id")) {
      await db.prepare("DROP TABLE ropa_entregas").run();
      await db.prepare(`CREATE TABLE ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER REFERENCES centros(id), fecha TEXT NOT NULL DEFAULT (date('now')), prenda TEXT NOT NULL, talla TEXT, alta_visibilidad INTEGER, auxiliar_servicios INTEGER, manga_larga INTEGER, color TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`).run();
    }
  }
  // Los antiguos «puntos de consumo» pasan a estaciones; se conservan sus datos.
  if (await tableExists(db, "puntos_consumo")) {
    const est = await db.prepare("SELECT COUNT(*) AS n FROM estaciones").first();
    if (!est || Number(est.n) === 0) {
      await db.prepare(`INSERT INTO estaciones (centro_id, zona_id, subzona_id, articulo_tipo, articulo_id, activo)
        SELECT p.centro_id, (SELECT s.zona_id FROM subzonas s WHERE s.id = p.subzona_id), p.subzona_id,
               p.producto_tipo, p.producto_id, 1
        FROM puntos_consumo p
        WHERE p.centro_id IS NOT NULL AND p.subzona_id IS NOT NULL
          AND EXISTS (SELECT 1 FROM subzonas s2 WHERE s2.id = p.subzona_id)`).run();
    }
    await db.prepare("DROP TABLE puntos_consumo").run();
  }
  // Maquinaria: las columnas zona/subzona nunca llegaron a usarse; el
  // emplazamiento de una máquina es su centro. Entregas: marca/modelo/tipo se
  // quedaron en el catálogo ropa_trabajo y no en la fila de entrega.
  for (const [table, column] of [
    ["ropa_entregas", "marca"], ["ropa_entregas", "modelo"], ["ropa_entregas", "tipo"],
  ] as Array<[string, string]>) await dropColumnIfPresent(db, table, column);
  // Ropa y EPIs no son consumibles: sus estaciones se desactivan (con el tipo
  // apuntado a NULL) y sus tipos de consumible se eliminan. Su stock pasa a
  // moverse solo con entregas, ediciones e importaciones.
  if (await tableExists(db, "estaciones")) {
    await db.prepare("UPDATE estaciones SET tipo_consumible_id = NULL WHERE articulo_tipo IN ('epis', 'ropa_trabajo')").run();
    await db.prepare("DELETE FROM consumibles_tipos WHERE articulo_tipo IN ('epis', 'ropa_trabajo')").run();
    await db.prepare("UPDATE estaciones SET activo = 0 WHERE articulo_tipo IN ('epis', 'ropa_trabajo')").run();
  }
  // Usuarios: el centro único pasa a la asignación multi usuario_centros.
  // Se copia el valor antiguo (si aún queda alguno) y se elimina la columna.
  const ucInfo = await db.prepare("PRAGMA table_info(usuarios)").all();
  if (ucInfo.results.some((r) => r.name === "centro_id")) {
    const ucCount = await db.prepare("SELECT COUNT(*) AS n FROM usuario_centros").first();
    if (!ucCount || Number(ucCount.n) === 0) {
      await db.prepare("INSERT INTO usuario_centros (usuario_id, centro_id) SELECT id, centro_id FROM usuarios WHERE centro_id IS NOT NULL").run();
    }
    await dropColumnIfPresent(db, "usuarios", "centro_id");
  }
}

async function seed(db: D1Database): Promise<void> {
  const adminSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const userSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const adminHash = await hashPassword("admin123", adminSalt);
  const userHash = await hashPassword("operario123", userSalt);
  await db.prepare("INSERT INTO centros (nombre, direccion, ciudad, responsable, telefono) VALUES (?, ?, ?, ?, ?)").bind("Planta Norte", "Polígono Industrial La Vega, nave 12", "Madrid", "Ana Serrano", "910 000 111").run();
  await db.prepare("INSERT INTO centros (nombre, direccion, ciudad, responsable, telefono) VALUES (?, ?, ?, ?, ?)").bind("Planta Sur", "Ctra. de Andújar km 4", "Sevilla", "Luis Cabrera", "954 000 222").run();
  await db.prepare("INSERT INTO usuarios (username, nombre, email, password_hash, salt, rol, activo) VALUES (?, ?, ?, ?, ?, ?, 1)").bind("admin", "Administrador", "admin@inventarios.local", adminHash, adminSalt, "admin").run();
  await db.prepare("INSERT INTO usuarios (username, nombre, email, password_hash, salt, rol, activo) VALUES (?, ?, ?, ?, ?, ?, 1)").bind("operario", "Operario Demo", "operario@inventarios.local", userHash, userSalt, "usuario").run();
  // El operario de ejemplo queda vinculado a Planta Norte (asignación multi).
  await db.prepare("INSERT INTO usuario_centros (usuario_id, centro_id) SELECT u.id, c.id FROM usuarios u, centros c WHERE u.username = 'operario' AND c.nombre = 'Planta Norte'").run();
  const q = db.prepare("INSERT INTO quimicos (nombre, numero_lote, litros_por_garrafa, num_garrafas, fecha_caducidad, centro_id, notas) VALUES (?, ?, ?, ?, ?, ?, ?)");
  await q.bind("Detergente alcalino Q-200", "L-2024-001", 5, 12, "2027-06-30", 1, "Zona de lavado de palés").run();
  await q.bind("Desinfectante clorado CL-10", "L-2025-014", 2, 20, "2026-11-05", 1, "Caduca pronto: revisar rotación").run();
  await q.bind("Desengrasante DG-5", "L-2025-032", 10, 6, "2026-04-15", 2, null).run();
  const m = db.prepare("INSERT INTO material_limpieza (nombre, color, cantidad, centro_id, notas) VALUES (?, ?, ?, ?, ?)");
  await m.bind("Mopa de microfibra", "Rojo", 40, 1, "Uso exclusivo en zona roja").run();
  await m.bind("Paño de microfibra", "Azul", 120, 1, null).run();
  await m.bind("Bolsa de basura 100 L", "Negro", 300, 2, null).run();
  await m.bind("Guantes de nitrilo", "Blanco", 150, 2, "Talla L").run();
  const ma = db.prepare("INSERT INTO maquinaria (nombre, tipo, cantidad, numero_serie, estado, centro_id, notas) VALUES (?, ?, ?, ?, ?, ?, ?)");
  await ma.bind("Fregadora autoelevable F-80", "Fregadora", 2, "F80-0012", "Operativa", 1, null).run();
  await ma.bind("Aspiradora húmeda AH-3", "Aspiradora", 1, "AH3-0044", "En reparación", 1, "Pendiente de recambio").run();
  await ma.bind("Monobrocha MB-50", "Monobrocha", 1, "MB50-0007", "Operativa", 2, null).run();
  const ep = db.prepare("INSERT INTO epis (codigo, marca, modelo, talla, descripcion, color, stock, centro_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  await ep.bind("EPI-001", "Delta Plus", "Ventec Pro", "L", "Guantes de nitrilo anticorte", "Azul", 40, 1).run();
  await ep.bind("EPI-002", "Uvex", "Phynomic XG", "M", "Gafas de seguridad antiempañantes", "Blanco", 25, 1).run();
  const rt = db.prepare("INSERT INTO ropa_trabajo (codigo, prenda, fabricante, modelo, talla, alta_visibilidad, manga_larga, descripcion, color, stock, centro_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  await rt.bind("RT-001", "Chaqueta alta visibilidad", "Lindström", "HV-300", "L", 1, 1, "Clase 2, con cintas reflectantes", "Amarillo", 30, 1).run();
  await rt.bind("RT-002", "Pantalón de trabajo", "Snickers Workwear", "AllroundWork", "42", 0, 0, "Ripstop con refuerzos", "Azul", 45, 2).run();
}

let ready = false;
export async function bootstrap(db: D1Database): Promise<void> {
  if (ready) return;
  for (const sql of SCHEMA) await db.prepare(sql).run();
  await migrate(db);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM usuarios").first();
  if (!count || Number(count.n) === 0) await seed(db);
  // Normaliza el control de lotes (se ejecuta tras el seed y en cada arranque,
  // solo toca las filas que no cumplan las reglas):
  //  · los lotes sin fecha de entrada (altas antiguas o datos de ejemplo) toman
  //    la de su alta, para que el consumo FEFO tenga orden;
  //  · el estado sigue al stock: con garrafas → «activo»; sin garrafas →
  //    «agotado», salvo que el recuento lo diera por descartado.
  await db.prepare("UPDATE quimicos SET fecha_entrada = date(created_at) WHERE fecha_entrada IS NULL").run();
  await db.prepare(
    `UPDATE quimicos SET estado = CASE WHEN num_garrafas > 0 THEN 'activo' ELSE 'agotado' END
     WHERE (num_garrafas > 0 AND estado <> 'activo') OR (num_garrafas <= 0 AND estado = 'activo')`,
  ).run();
  // Tipos de maquinaria por defecto (también en bases de datos ya existentes).
  const tipos = await db.prepare("SELECT COUNT(*) AS n FROM tipos_maquinaria").first();
  if (!tipos || Number(tipos.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO tipos_maquinaria (nombre) VALUES (?)");
    for (const t of ["Fregadora", "Aspiradora", "Monobrocha", "Hidrolavadora", "Barredora", "Robot", "Carro de limpieza", "Otro"]) await ins.bind(t).run();
  }
  // Soportes y tipos de consumible por defecto (también en bases existentes).
  const spn = await db.prepare("SELECT COUNT(*) AS n FROM soportes").first();
  if (!spn || Number(spn.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO soportes (nombre) VALUES (?)");
    for (const s of ["Pared", "Mesa", "Carro", "Estantería"]) await ins.bind(s).run();
  }
  // Tipos de equipo por defecto para ropa y EPIs (también en bases existentes).
  const teq = await db.prepare("SELECT COUNT(*) AS n FROM tipos_equipo").first();
  if (!teq || Number(teq.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO tipos_equipo (nombre) VALUES (?)");
    for (const t of ["Abrigo", "Camiseta", "Tapones de oídos", "Gafas de seguridad"]) await ins.bind(t).run();
  }
  // Situaciones de maquinaria por defecto (también en bases existentes).
  const sit = await db.prepare("SELECT COUNT(*) AS n FROM situaciones").first();
  if (!sit || Number(sit.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO situaciones (nombre) VALUES (?)");
    for (const s of ["Operativo", "En reparación", "Mantenimiento preventivo", "Averiado", "Baja"]) await ins.bind(s).run();
  }
  // Histórico inicial: cada máquina sin registros guarda su estado actual como
  // primer registro (equivalencias de los estados antiguos: Operativa→Operativo…).
  const sinHist = await db.prepare(
    `SELECT m.id, m.estado, m.marca, m.modelo, m.centro_id FROM maquinaria m
     WHERE NOT EXISTS (SELECT 1 FROM maquinaria_historial h WHERE h.maquina_id = m.id)`,
  ).all();
  for (const m of sinHist.results) {
    const estado = String(m.estado ?? "Operativo");
    const equiv = estado === "Operativa" ? "Operativo" : estado === "Averiada" ? "Averiado" : estado;
    let s = await db.prepare("SELECT id FROM situaciones WHERE nombre = ?").bind(equiv).first();
    if (!s) s = await db.prepare("SELECT id FROM situaciones WHERE nombre = ?").bind("Operativo").first();
    if (s) {
      await db.prepare("INSERT INTO maquinaria_historial (maquina_id, fecha, situacion_id, marca, modelo, centro_id) VALUES (?, date('now'), ?, ?, ?, ?)")
        .bind(Number(m.id), Number(s.id), m.marca ?? null, m.modelo ?? null, m.centro_id ?? null).run();
    }
  }
  // La columna `estado` queda sincronizada con el último registro del histórico.
  await db.prepare(
    `UPDATE maquinaria SET estado = (
       SELECT st.nombre FROM maquinaria_historial h JOIN situaciones st ON st.id = h.situacion_id
       WHERE h.maquina_id = maquinaria.id ORDER BY h.fecha DESC, h.id DESC LIMIT 1)
     WHERE EXISTS (SELECT 1 FROM maquinaria_historial h2 WHERE h2.maquina_id = maquinaria.id)`,
  ).run();
  const ctn = await db.prepare("SELECT COUNT(*) AS n FROM consumibles_tipos").first();
  if (!ctn || Number(ctn.n) === 0) {
    const ins = db.prepare("INSERT INTO consumibles_tipos (nombre, articulo_tipo) VALUES (?, ?)");
    for (const [nombre, tipo] of [["Químicos", "quimicos"], ["Material de limpieza", "material_limpieza"], ["Maquinaria", "maquinaria"]] as Array<[string, string]>) await ins.bind(nombre, tipo).run();
  }
  // Tipos de ficha de la sección Documentación (también en bases existentes).
  const dtn = await db.prepare("SELECT COUNT(*) AS n FROM documento_tipos").first();
  if (!dtn || Number(dtn.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO documento_tipos (nombre) VALUES (?)");
    for (const t of ["Ficha de seguridad", "Ficha técnica", "Manual de maquinaria", "Instrucción de trabajo"]) await ins.bind(t).run();
  }
  // Estaciones migradas desde los antiguos puntos pueden quedar sin tipo.
  await db.prepare("UPDATE estaciones SET tipo_consumible_id = (SELECT ct.id FROM consumibles_tipos ct WHERE ct.articulo_tipo = estaciones.articulo_tipo ORDER BY ct.id LIMIT 1) WHERE tipo_consumible_id IS NULL").run();
  // Índices para las consultas calientes (auditoría, panel, entregas, histórico).
  for (const idx of [
    "CREATE INDEX IF NOT EXISTS idx_mov_created ON movimientos(created_at)",
    "CREATE INDEX IF NOT EXISTS idx_mov_estacion ON movimientos(estacion_id)",
    "CREATE INDEX IF NOT EXISTS idx_mov_usuario ON movimientos(usuario_id)",
    "CREATE INDEX IF NOT EXISTS idx_entregas_usuario ON ropa_entregas(usuario_id, fecha)",
    "CREATE INDEX IF NOT EXISTS idx_entregas_centro ON ropa_entregas(centro_id)",
    "CREATE INDEX IF NOT EXISTS idx_hist_maquina ON maquinaria_historial(maquina_id, fecha)",
    "CREATE INDEX IF NOT EXISTS idx_hist_situacion ON maquinaria_historial(situacion_id)",
    "CREATE INDEX IF NOT EXISTS idx_quim_caducidad ON quimicos(fecha_caducidad)",
    "CREATE INDEX IF NOT EXISTS idx_epis_revision ON epis(fecha_revision)",
    "CREATE INDEX IF NOT EXISTS idx_tallas_usuario ON tallas_operarios(usuario_id)",
    "CREATE INDEX IF NOT EXISTS idx_sessions_usuario ON sessions(user_id)",
    // Pedido de material: aplicar el pedido solo toca las líneas pendientes y
    // busca en material_limpieza por su código.
    "CREATE INDEX IF NOT EXISTS idx_pedidos_aplicado ON pedidos_material(aplicado)",
    "CREATE INDEX IF NOT EXISTS idx_mat_codigo ON material_limpieza(codigo)",
  ] as const) await db.prepare(idx).run();
  ready = true;
}
