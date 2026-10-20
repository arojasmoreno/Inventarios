-- Esquema de la base de datos Inventarios (Cloudflare D1).
-- Mantener en sincronía con el array SCHEMA de src/worker/db.ts (fuente de
-- verdad en tiempo de ejecución: el Worker crea estas tablas automáticamente
-- con CREATE TABLE IF NOT EXISTS y siembra los datos iniciales la primera vez
-- que la tabla `usuarios` está vacía).
--
-- Aplicar con:
--   npx wrangler d1 execute inventarios --local  --file=./schema.sql
--   npx wrangler d1 execute inventarios --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS centros (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT, ciudad TEXT, responsable TEXT, telefono TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'usuario', activo INTEGER NOT NULL DEFAULT 1, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS quimicos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT NOT NULL, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS material_limpieza (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, color TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 1, numero_serie TEXT, estado TEXT NOT NULL DEFAULT 'Operativa', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS password_recovery_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS epis (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, marca TEXT, modelo TEXT, talla TEXT, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, fecha_revision TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS ropa_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, prenda TEXT NOT NULL, fabricante TEXT, modelo TEXT, talla TEXT, alta_visibilidad INTEGER NOT NULL DEFAULT 0, manga_larga INTEGER NOT NULL DEFAULT 0, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS tallas_operarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, ropa_id INTEGER NOT NULL REFERENCES ropa_trabajo(id), cantidad INTEGER NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, entregado_por INTEGER REFERENCES usuarios(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS empresa (id INTEGER PRIMARY KEY CHECK (id = 1), nombre TEXT, logo TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER, descripcion TEXT, cantidad INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);
