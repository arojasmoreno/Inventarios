import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";

type Row = Record<string, unknown>;

// Búsqueda global de la barra superior: artículos, ubicaciones, estaciones y
// usuarios, devolviendo la ruta de la web a la que lleva cada resultado.
export const buscadorRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
buscadorRoutes.use("*", requireAuth);

// Escape de comodines LIKE (SQLite acepta ESCAPE '\' con el patrón escapado).
const esc = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

buscadorRoutes.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (q.length < 2) return c.json({ items: [], query: q });
  const like = `%${esc(q)}%`;
  const db = c.env.DB;
  // Cada consulta repite el patrón tantas veces como comodines contiene.
  const buscar = (sql: string, params: number) => db.prepare(sql).bind(...Array(params).fill(like)).all<Row>();
  const [quimicos, material, epis, ropa, maquinaria, centros, zonas, subzonas, soportes, estaciones, usuarios] = await Promise.all([
    buscar("SELECT id, nombre, codigo AS extra, 'quimicos' AS hash, 'Químicos' AS categoria FROM quimicos WHERE nombre LIKE ? ESCAPE '\\' OR codigo LIKE ? ESCAPE '\\' OR numero_lote LIKE ? ESCAPE '\\' LIMIT 5", 3),
    buscar("SELECT id, nombre, codigo AS extra, 'material' AS hash, 'Material de limpieza' AS categoria FROM material_limpieza WHERE nombre LIKE ? ESCAPE '\\' OR codigo LIKE ? ESCAPE '\\' LIMIT 5", 2),
    buscar("SELECT id, COALESCE(NULLIF(descripcion, ''), codigo) AS nombre, codigo AS extra, 'epis' AS hash, 'EPIs' AS categoria FROM epis WHERE descripcion LIKE ? ESCAPE '\\' OR codigo LIKE ? ESCAPE '\\' OR modelo LIKE ? ESCAPE '\\' LIMIT 5", 3),
    buscar("SELECT id, prenda AS nombre, codigo AS extra, 'ropa' AS hash, 'Ropa de trabajo' AS categoria FROM ropa_trabajo WHERE prenda LIKE ? ESCAPE '\\' OR codigo LIKE ? ESCAPE '\\' LIMIT 5", 2),
    buscar("SELECT id, nombre, modelo AS extra, 'maquinaria' AS hash, 'Maquinaria' AS categoria FROM maquinaria WHERE nombre LIKE ? ESCAPE '\\' OR modelo LIKE ? ESCAPE '\\' OR numero_serie LIKE ? ESCAPE '\\' LIMIT 5", 3),
    buscar("SELECT id, nombre, NULL AS extra, 'centros' AS hash, 'Centros' AS categoria FROM centros WHERE nombre LIKE ? ESCAPE '\\' LIMIT 4", 1),
    buscar("SELECT id, nombre, NULL AS extra, 'zonas' AS hash, 'Zonas' AS categoria FROM zonas WHERE nombre LIKE ? ESCAPE '\\' LIMIT 4", 1),
    buscar("SELECT id, nombre, NULL AS extra, 'zonas' AS hash, 'Subzonas' AS categoria FROM subzonas WHERE nombre LIKE ? ESCAPE '\\' LIMIT 4", 1),
    buscar("SELECT id, nombre, NULL AS extra, 'soportes' AS hash, 'Soportes' AS categoria FROM soportes WHERE nombre LIKE ? ESCAPE '\\' LIMIT 4", 1),
    buscar(`SELECT e.id,
        COALESCE(z.nombre, 'Estación') || COALESCE(' · ' || s.nombre, '') || COALESCE(' · ' || sp.nombre, '') AS nombre,
        COALESCE(ct.nombre, '') AS extra, 'estaciones' AS hash, 'Estaciones' AS categoria
      FROM estaciones e
      LEFT JOIN zonas z ON z.id = e.zona_id
      LEFT JOIN subzonas s ON s.id = e.subzona_id
      LEFT JOIN soportes sp ON sp.id = e.soporte_id
      LEFT JOIN consumibles_tipos ct ON ct.id = e.tipo_consumible_id
      WHERE z.nombre LIKE ? ESCAPE '\\' OR s.nombre LIKE ? ESCAPE '\\' OR sp.nombre LIKE ? ESCAPE '\\' LIMIT 5`, 3),
    c.get("user")?.rol === "admin"
      ? buscar("SELECT id, nombre, username AS extra, 'usuarios' AS hash, 'Usuarios' AS categoria FROM usuarios WHERE nombre LIKE ? ESCAPE '\\' OR username LIKE ? ESCAPE '\\' LIMIT 4", 2)
      : Promise.resolve({ results: [] as Row[] }),
  ]);
  const todos = [quimicos, material, epis, ropa, maquinaria, centros, zonas, subzonas, soportes, estaciones, usuarios]
    .flatMap((r) => r.results)
    .slice(0, 24)
    .map((r) => ({
      id: Number(r.id),
      nombre: String(r.nombre ?? `#${String(r.id)}`),
      extra: r.extra == null || r.extra === "" ? null : String(r.extra),
      hash: `#/${String(r.hash)}`,
      categoria: String(r.categoria ?? ""),
    }));
  return c.json({ items: todos, query: q });
});
