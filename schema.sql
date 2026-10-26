-- Esquema de la base de datos Inventarios (Cloudflare D1).
-- Mantener en sincronía con el array SCHEMA de src/worker/db.ts (fuente de
-- verdad en tiempo de ejecución: el Worker crea estas tablas automáticamente
-- con CREATE TABLE IF NOT EXISTS y siembra los datos iniciales la primera vez
-- que la tabla `usuarios` está vacía).
--
-- Notas de la versión actual:
--   * `precio` (químicos, material, EPIs y ropa) es el precio unitario
--     **opcional** para calcular el valor del inventario: si un producto no
--     tiene precio conocido queda NULL y no contabiliza.
--   * `quimicos.origen` y `material_limpieza.origen` marcan si el consumible es
--     de fábrica («fabrica») o de la empresa gestora («empresa»); el worker añade
--     la columna con `ALTER TABLE … DEFAULT 'fabrica'` en las bases existentes.
--   * `ropa_entregas` se recreó como registro por prenda (talla, A/V, auxiliar
--     de servicios, manga larga, color) sin costes ni ligazón con el stock.
--   * Los antiguos `puntos_consumo` se migran a `estaciones` en el arranque.
--   * Los usuarios ya no tienen centro único: la asignación es multi-centro
--     mediante `usuario_centros` (el worker migra la columna antigua al arrancar).
--   * Cada fila de `quimicos` es un LOTE de producto: `fecha_entrada` (recepción)
--     y `estado` (activo / agotado / descartado) permiten sumar el inventario por
--     producto, consumir por FEFO y retirar lotes. Los recuentos de inventario
--     se guardan en `inventarios` + `inventarios_lineas`.
--
-- Aplicar con:
--   npx wrangler d1 execute inventarios --local  --file=./schema.sql
--   npx wrangler d1 execute inventarios --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS centros (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, direccion TEXT, ciudad TEXT, responsable TEXT, telefono TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, nombre TEXT NOT NULL, email TEXT, password_hash TEXT NOT NULL, salt TEXT NOT NULL, rol TEXT NOT NULL DEFAULT 'usuario', activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS quimicos (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, numero_lote TEXT NOT NULL, litros_por_garrafa REAL NOT NULL DEFAULT 0, num_garrafas INTEGER NOT NULL DEFAULT 0, fecha_caducidad TEXT, fecha_produccion TEXT, fecha_entrada TEXT, estado TEXT NOT NULL DEFAULT 'activo', stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS material_limpieza (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT, marca TEXT, nombre TEXT NOT NULL, color TEXT NOT NULL, cantidad INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, origen TEXT NOT NULL DEFAULT 'fabrica', foto TEXT, centro_id INTEGER REFERENCES centros(id), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo TEXT NOT NULL, marca TEXT, modelo TEXT, cantidad INTEGER NOT NULL DEFAULT 1, numero_serie TEXT, estado TEXT NOT NULL DEFAULT 'Operativa', foto TEXT, centro_id INTEGER REFERENCES centros(id), zona_id INTEGER REFERENCES zonas(id) ON DELETE SET NULL, subzona_id INTEGER REFERENCES subzonas(id) ON DELETE SET NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS password_recovery_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

-- Códigos de acceso por correo (login sin contraseña).
CREATE TABLE IF NOT EXISTS login_codes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, token TEXT NOT NULL UNIQUE, code TEXT NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));

CREATE TABLE IF NOT EXISTS epis (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, tipo_equipo_id INTEGER REFERENCES tipos_equipo(id), marca TEXT, modelo TEXT, talla TEXT, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, fecha_revision TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS ropa_trabajo (id INTEGER PRIMARY KEY AUTOINCREMENT, codigo TEXT NOT NULL UNIQUE, prenda TEXT NOT NULL, tipo_equipo_id INTEGER REFERENCES tipos_equipo(id), marca TEXT, fabricante TEXT, modelo TEXT, talla TEXT, alta_visibilidad INTEGER NOT NULL DEFAULT 0, manga_larga INTEGER NOT NULL DEFAULT 0, descripcion TEXT, color TEXT, stock INTEGER NOT NULL DEFAULT 0, stock_minimo INTEGER NOT NULL DEFAULT 0, precio REAL, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS tallas_operarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, prenda TEXT, talla TEXT NOT NULL, fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS empresa (id INTEGER PRIMARY KEY CHECK (id = 1), nombre TEXT, logo TEXT, updated_at TEXT);

CREATE TABLE IF NOT EXISTS movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER, estacion_id INTEGER, descripcion TEXT, cantidad INTEGER, motivo TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS tipos_maquinaria (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

-- Tipos de equipo de la equipación (abrigo, camiseta, tapones de oídos…),
-- compartidos por ropa_trabajo y epis.
CREATE TABLE IF NOT EXISTS tipos_equipo (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

-- Situaciones de la maquinaria (operativo, en reparación…): catálogo con altas
-- propias; el estado actual de cada máquina es su último registro del histórico.
CREATE TABLE IF NOT EXISTS situaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

-- Histórico de máquinas: fecha + situación con la marca, modelo y centro del momento.
CREATE TABLE IF NOT EXISTS maquinaria_historial (id INTEGER PRIMARY KEY AUTOINCREMENT, maquina_id INTEGER NOT NULL REFERENCES maquinaria(id) ON DELETE CASCADE, fecha TEXT NOT NULL DEFAULT (date('now')), situacion_id INTEGER NOT NULL REFERENCES situaciones(id), marca TEXT, modelo TEXT, centro_id INTEGER REFERENCES centros(id), created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS zonas (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(centro_id, nombre));

CREATE TABLE IF NOT EXISTS subzonas (id INTEGER PRIMARY KEY AUTOINCREMENT, zona_id INTEGER NOT NULL REFERENCES zonas(id) ON DELETE CASCADE, nombre TEXT NOT NULL, notas TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT, UNIQUE(zona_id, nombre));

CREATE TABLE IF NOT EXISTS usuario_centros (usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (usuario_id, centro_id));

CREATE TABLE IF NOT EXISTS soportes (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS consumibles_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS estaciones (id INTEGER PRIMARY KEY AUTOINCREMENT, centro_id INTEGER NOT NULL REFERENCES centros(id), zona_id INTEGER NOT NULL REFERENCES zonas(id), subzona_id INTEGER REFERENCES subzonas(id), soporte_id INTEGER REFERENCES soportes(id), tipo_consumible_id INTEGER REFERENCES consumibles_tipos(id), articulo_tipo TEXT NOT NULL DEFAULT 'material_limpieza', articulo_id INTEGER NOT NULL, activo INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

-- Entrega de equipación: fila por artículo entregado (catálogo ropa_trabajo o
-- epis + cantidad); el stock se descuenta al entregar y se reintegra al borrar.
CREATE TABLE IF NOT EXISTS ropa_entregas (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE, centro_id INTEGER REFERENCES centros(id), fecha TEXT NOT NULL DEFAULT (date('now')), prenda TEXT NOT NULL, articulo_tipo TEXT, articulo_id INTEGER, cantidad INTEGER, talla TEXT, alta_visibilidad INTEGER, auxiliar_servicios INTEGER, manga_larga INTEGER, color TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

-- Documentación: tipos de ficha y fichas con URL y multi-centro.
CREATE TABLE IF NOT EXISTS documento_tipos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS documentos (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, tipo_id INTEGER NOT NULL REFERENCES documento_tipos(id), url TEXT NOT NULL, descripcion TEXT, fabricante TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS documento_centros (documento_id INTEGER NOT NULL REFERENCES documentos(id) ON DELETE CASCADE, centro_id INTEGER NOT NULL REFERENCES centros(id) ON DELETE CASCADE, PRIMARY KEY (documento_id, centro_id));

-- Recuentos de inventario de químicos: una fila por recuento validado y una por
-- cada lote de la hoja (litros del sistema frente a los litros reales contados).
CREATE TABLE IF NOT EXISTS inventarios (id INTEGER PRIMARY KEY AUTOINCREMENT, usuario_id INTEGER REFERENCES usuarios(id), fecha TEXT NOT NULL DEFAULT (date('now')), notas TEXT, lineas INTEGER NOT NULL DEFAULT 0, diferencia REAL, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT);

CREATE TABLE IF NOT EXISTS inventarios_lineas (id INTEGER PRIMARY KEY AUTOINCREMENT, inventario_id INTEGER NOT NULL REFERENCES inventarios(id) ON DELETE CASCADE, quimico_id INTEGER, nombre TEXT NOT NULL, marca TEXT, numero_lote TEXT, centro TEXT, litros_teoricos REAL NOT NULL DEFAULT 0, litros_reales REAL NOT NULL DEFAULT 0, diferencia REAL NOT NULL DEFAULT 0, estado TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
