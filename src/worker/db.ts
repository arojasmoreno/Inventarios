import type { D1Database } from "./d1";
import { hashPassword, toHex } from "./auth";

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS centros (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT, ciudad TEXT, responsable TEXT, telefono TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'usuario', activo INTEGER NOT NULL DEFAULT 1, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quimicos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT NOT NULL, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS material_limpieza (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, color TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 1, numero_serie TEXT, estado TEXT NOT NULL DEFAULT 'Operativa', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS password_recovery_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS epis (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, marca TEXT, modelo TEXT, talla TEXT, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, fecha_revision TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ropa_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, prenda TEXT NOT NULL, fabricante TEXT, modelo TEXT, talla TEXT, alta_visibilidad INTEGER NOT NULL DEFAULT 0, manga_larga INTEGER NOT NULL DEFAULT 0, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tallas_operarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, ropa_id INTEGER NOT NULL REFERENCES ropa_trabajo(id), cantidad INTEGER NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, entregado_por INTEGER REFERENCES usuarios(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS empresa (id INTEGER PRIMARY KEY CHECK (id = 1), nombre TEXT, logo TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER, descripcion TEXT, cantidad INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
];

// Migraciones para tablas creadas antes de añadir estas columnas.
const ALTERS: Array<[string, string]> = [
  ["quimicos", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["quimicos", "foto TEXT"],
  ["material_limpieza", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["material_limpieza", "foto TEXT"],
  ["maquinaria", "foto TEXT"],
  ["epis", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["epis", "fecha_revision TEXT"],
  ["ropa_trabajo", "talla TEXT"], ["ropa_trabajo", "stock_minimo INTEGER NOT NULL DEFAULT 0"],
  ["tallas_operarios", "fecha TEXT NOT NULL DEFAULT (date('now'))"],
  ["movimientos", "updated_at TEXT"],
];

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
  ready = true;
}
