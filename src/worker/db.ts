import type { D1Database } from "./d1";
import { hashPassword, toHex } from "./auth";

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS centros (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT, ciudad TEXT, responsable TEXT, telefono TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'usuario', activo INTEGER NOT NULL DEFAULT 1, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expires_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS quimicos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT NOT NULL, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS material_limpieza (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, color TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo TEXT NOT NULL, marca TEXT, modelo TEXT, cantidad INTEGER NOT NULL DEFAULT 1, numero_serie TEXT, estado TEXT NOT NULL DEFAULT 'Operativa', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS password_recovery_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  // Códigos de acceso por correo (login sin contraseña).
  `CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')))`,
  `CREATE TABLE IF NOT EXISTS epis (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, marca TEXT, modelo TEXT, talla TEXT, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, fecha_revision TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS ropa_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, prenda TEXT NOT NULL, marca TEXT, fabricante TEXT, modelo TEXT, talla TEXT, alta_visibilidad INTEGER NOT NULL DEFAULT 0, manga_larga INTEGER NOT NULL DEFAULT 0, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tallas_operarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, prenda TEXT, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS empresa (id INTEGER PRIMARY KEY CHECK (id = 1), nombre TEXT, logo TEXT, updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER, estacion_id INTEGER, descripcion TEXT, cantidad INTEGER, motivo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS tipos_maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS zonas (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(centro_id, nombre))`,
  `CREATE TABLE IF NOT EXISTS subzonas (id INTEGER PRIMARY KEY AUTOINCREMENT, zona_id INTEGER NOT NULL REFERENCES zonas(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(zona_id, nombre))`,
  `CREATE TABLE IF NOT EXISTS usuario_centros (usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (usuario_id, centro_id))`,
  `CREATE TABLE IF NOT EXISTS soportes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS consumibles_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Estaciones de consumo (antes «puntos de consumo»): zona/subzona, soporte,
  // tipo de consumible y artículo del almacén que se descuenta al escanear.
  `CREATE TABLE IF NOT EXISTS estaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id), zona_id INTEGER NOT NULL REFERENCES zonas(id), subzona_id INTEGER REFERENCES subzonas(id), soporte_id INTEGER REFERENCES soportes(id), tipo_consumible_id INTEGER REFERENCES consumibles_tipos(id), articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', articulo_id INTEGER NOT NULL, activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Entrega de ropa por operario: una fila por prenda con talla, alta
  // visibilidad, auxiliar de servicios, manga larga y color (sin costes).
  `CREATE TABLE IF NOT EXISTS ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER REFERENCES centros(id), fecha TEXT NOT NULL DEFAULT (date('now')), prenda TEXT NOT NULL, talla TEXT, alta_visibilidad INTEGER, auxiliar_servicios INTEGER, manga_larga INTEGER, color TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  // Documentación: tipos de ficha (ficha de seguridad, técnica, manual de
  // maquinaria, instrucción de trabajo…) y fichas con URL y multi-centro.
  `CREATE TABLE IF NOT EXISTS documento_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo_id INTEGER NOT NULL REFERENCES documento_tipos(id), url TEXT NOT NULL, descripcion TEXT, fabricante TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT)`,
  `CREATE TABLE IF NOT EXISTS documento_centros (documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (documento_id, centro_id))`,
];

// Migraciones para tablas creadas antes de añadir estas columnas.
const ALTERS: Array<[string, string]> = [
  ["quimicos", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["quimicos", "foto TEXT"],
  ["material_limpieza", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["material_limpieza", "foto TEXT"],
  ["maquinaria", "foto TEXT"],
  ["epis", "stock_minimo INTEGER NOT NULL DEFAULT 0"], ["epis", "fecha_revision TEXT"],
  ["ropa_trabajo", "talla TEXT"], ["ropa_trabajo", "stock_minimo INTEGER NOT NULL DEFAULT 0"],
  ["tallas_operarios", "fecha TEXT NOT NULL DEFAULT (date('now'))"],
  ["tallas_operarios", "prenda TEXT"],
  ["movimientos", "updated_at TEXT"],
  ["quimicos", "codigo TEXT"], ["quimicos", "marca TEXT"],
  ["material_limpieza", "codigo TEXT"], ["material_limpieza", "marca TEXT"],
  ["maquinaria", "marca TEXT"], ["maquinaria", "modelo TEXT"],
  ["ropa_trabajo", "marca TEXT"],
  ["movimientos", "motivo TEXT"],
  ["movimientos", "estacion_id INTEGER"],
  ["consumibles_tipos", "articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza'"],
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
  // Se elimina el coste de los consumibles: solo interesa la cantidad consumida.
  for (const [table, column] of [
    ["quimicos", "coste_unitario"], ["material_limpieza", "coste_unitario"],
    ["epis", "coste_unitario"], ["ropa_trabajo", "coste_unitario"],
    ["movimientos", "coste"],
  ] as Array<[string, string]>) await dropColumnIfPresent(db, table, column);
  // Entregas de ropa v2: la tabla antigua (ligada a ropa_trabajo con cantidad)
  // se sustituye por el registro por prenda del formulario; los datos previos se
  // descartan a petición del usuario.
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
}

async function seed(db: D1Database): Promise<void> {
  const adminSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const userSalt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const adminHash = await hashPassword("admin123", adminSalt);
  const userHash = await hashPassword("operario123", userSalt);
  await db.prepare("INSERT INTO centros (nombre, direccion, ciudad, responsable, telefono) VALUES (?, ?, ?, ?, ?)").bind("Planta Norte", "Polígono Industrial La Vega, nave 12", "Madrid", "Ana Serrano", "910 000 111").run();
  await db.prepare("INSERT INTO centros (nombre, direccion, ciudad, responsable, telefono) VALUES (?, ?, ?, ?, ?)").bind("Planta Sur", "Ctra. de Andújar km 4", "Sevilla", "Luis Cabrera", "954 000 222").run();
  await db.prepare("INSERT INTO usuarios (username, nombre, email, password_hash, salt, rol, activo) VALUES (?, ?, ?, ?, ?, ?, 1)").bind("admin", "Administrador", "admin@inventarios.local", adminHash, adminSalt, "admin").run();
  await db.prepare("INSERT INTO usuarios (username, nombre, email, password_hash, salt, rol, activo, centro_id) VALUES (?, ?, ?, ?, ?, ?, 1, 1)").bind("operario", "Operario Demo", "operario@inventarios.local", userHash, userSalt, "usuario").run();
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
  const ctn = await db.prepare("SELECT COUNT(*) AS n FROM consumibles_tipos").first();
  if (!ctn || Number(ctn.n) === 0) {
    const ins = db.prepare("INSERT INTO consumibles_tipos (nombre, articulo_tipo) VALUES (?, ?)");
    for (const [nombre, tipo] of [["Químicos", "quimicos"], ["Material de limpieza", "material_limpieza"], ["EPIs", "epis"], ["Ropa de trabajo", "ropa_trabajo"], ["Maquinaria", "maquinaria"]] as Array<[string, string]>) await ins.bind(nombre, tipo).run();
  }
  // Tipos de ficha de la sección Documentación (también en bases existentes).
  const dtn = await db.prepare("SELECT COUNT(*) AS n FROM documento_tipos").first();
  if (!dtn || Number(dtn.n) === 0) {
    const ins = db.prepare("INSERT OR IGNORE INTO documento_tipos (nombre) VALUES (?)");
    for (const t of ["Ficha de seguridad", "Ficha técnica", "Manual de maquinaria", "Instrucción de trabajo"]) await ins.bind(t).run();
  }
  // Estaciones migradas desde los antiguos puntos pueden quedar sin tipo.
  await db.prepare("UPDATE estaciones SET tipo_consumible_id = (SELECT ct.id FROM consumibles_tipos ct WHERE ct.articulo_tipo = estaciones.articulo_tipo ORDER BY ct.id LIMIT 1) WHERE tipo_consumible_id IS NULL").run();
  // Zonas y subzonas de ejemplo (jerarquía centro → zona → subzona) y dos
  // zonas de consumo, solo si la base de datos todavía no tiene ninguna.
  const zc = await db.prepare("SELECT COUNT(*) AS n FROM zonas").first();
  if (!zc || Number(zc.n) === 0) {
    const cs = (await db.prepare("SELECT id FROM centros ORDER BY id").all()).results as Array<{ id: number }>;
    const norte = cs[0] ? Number(cs[0].id) : 0;
    const sur = cs[1] ? Number(cs[1].id) : norte;
    const lastId = (r: { meta: unknown }): number => Number((r.meta as { last_row_id?: number }).last_row_id);
    const mkZona = async (centroId: number, nombre: string, notas: string | null): Promise<number> =>
      lastId(await db.prepare("INSERT INTO zonas (centro_id, nombre, notas) VALUES (?, ?, ?)").bind(centroId, nombre, notas).run());
    const mkSub = async (zonaId: number, nombre: string): Promise<number> =>
      lastId(await db.prepare("INSERT INTO subzonas (zona_id, nombre) VALUES (?, ?)").bind(zonaId, nombre).run());
    if (norte) {
      const oficina = await mkZona(norte, "Oficina", "Zona administrativa");
      const almacen = await mkZona(norte, "Almacén", "Productos, químicos y EPIs");
      const subRecepcion = await mkSub(oficina, "Recepción");
      const subVestuarios = await mkSub(oficina, "Vestuarios");
      const subEstA = await mkSub(almacen, "Estantería A");
      await mkSub(almacen, "Estantería B");
      if (sur && sur !== norte) {
        const almacenSur = await mkZona(sur, "Almacén", null);
        await mkSub(almacenSur, "Estantería A");
      }
      const pc = await db.prepare("SELECT COUNT(*) AS n FROM estaciones").first();
      if (!pc || Number(pc.n) === 0) {
        const mat = await db.prepare("SELECT id FROM material_limpieza ORDER BY id LIMIT 1").first();
        const qui = await db.prepare("SELECT id FROM quimicos ORDER BY id LIMIT 1").first();
        const soporte = await db.prepare("SELECT id FROM soportes ORDER BY id LIMIT 1").first();
        const tipoMat = await db.prepare("SELECT id FROM consumibles_tipos WHERE articulo_tipo = 'material_limpieza' ORDER BY id LIMIT 1").first();
        const tipoQui = await db.prepare("SELECT id FROM consumibles_tipos WHERE articulo_tipo = 'quimicos' ORDER BY id LIMIT 1").first();
        const ins = db.prepare("INSERT INTO estaciones (centro_id, zona_id, subzona_id, soporte_id, tipo_consumible_id, articulo_tipo, articulo_id, activo) VALUES (?, ?, ?, ?, ?, ?, ?, 1)");
        if (mat) await ins.bind(norte, oficina, subVestuarios, soporte ? Number(soporte.id) : null, tipoMat ? Number(tipoMat.id) : null, "material_limpieza", Number(mat.id)).run();
        if (qui) await ins.bind(norte, almacen, subEstA, soporte ? Number(soporte.id) : null, tipoQui ? Number(tipoQui.id) : null, "quimicos", Number(qui.id)).run();
        if (mat && subRecepcion) await ins.bind(norte, oficina, subRecepcion, soporte ? Number(soporte.id) : null, tipoMat ? Number(tipoMat.id) : null, "material_limpieza", Number(mat.id)).run();
      }
    }
  }
  // Centros asignados: traslado del antiguo centro_id único a la tabla multiasignación.
  const uc = await db.prepare("SELECT COUNT(*) AS n FROM usuario_centros").first();
  if (!uc || Number(uc.n) === 0) {
    await db.prepare("INSERT INTO usuario_centros (usuario_id, centro_id) SELECT id, centro_id FROM usuarios WHERE centro_id IS NOT NULL").run();
  }
  ready = true;
}
