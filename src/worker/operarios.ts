import { Hono } from "hono";
import { requireAuth, centrosDeUsuario, type SessionUser } from "./auth";
import type { D1Database, Env } from "./d1";
import type { Variables } from "./types";

// Ficha unificada del operario: sus datos, los EPIs y la ropa entregados, sus
// formaciones/carnets con la fecha de realización y sus últimos movimientos.
// Los administradores (y los administradores de centros, en sus centros) ven
// todas las fichas; el perfil «Usuario» solo puede abrir la suya.
type Row = Record<string, unknown>;

function entero(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isInteger(valor) ? valor : null;
  if (typeof valor !== "string" || !valor.trim()) return null;
  const n = Number(valor);
  return Number.isInteger(n) ? n : null;
}

async function centrosVisibles(db: D1Database, user: SessionUser): Promise<Array<{ id: number; nombre: string }>> {
  if (user.rol === "admin") {
    const res = await db.prepare("SELECT id, nombre FROM centros ORDER BY nombre COLLATE NOCASE").all<{ id: number; nombre: string }>();
    return res.results.map((c) => ({ id: Number(c.id), nombre: String(c.nombre) }));
  }
  return centrosDeUsuario(db, user.id);
}

/** Centros del operario objetivo (para decidir quién puede ver su ficha). */
async function centrosDe(db: D1Database, usuarioId: number): Promise<number[]> {
  const res = await db.prepare("SELECT centro_id FROM usuario_centros WHERE usuario_id = ?")
    .bind(usuarioId).all<{ centro_id: number }>();
  return res.results.map((r) => Number(r.centro_id));
}

async function puedeVerFicha(db: D1Database, user: SessionUser, usuarioId: number): Promise<boolean> {
  if (user.rol === "admin") return true;
  if (user.id === usuarioId) return true;
  if (user.rol !== "admin_centros") return false;
  const [mios, suyos] = await Promise.all([centrosDe(db, user.id), centrosDe(db, usuarioId)]);
  return suyos.some((c) => mios.includes(c));
}

export const operariosRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();
operariosRoutes.use("*", requireAuth);

// Listado para el buscador de fichas. El perfil «Usuario» no tiene listado:
// solo puede abrir su propia ficha.
operariosRoutes.get("/", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  if (user.rol === "usuario") {
    return c.json({
      items: [{
        id: user.id, nombre: user.nombre, username: user.username,
        rol: user.rol, activo: 1, centros_nombre: null,
      }],
      solo_propia: true,
      puede_gestionar: false,
    });
  }
  const q = (c.req.query("q") ?? "").trim();
  const centroId = entero(c.req.query("centro_id"));
  const centros = await centrosVisibles(db, user);
  const ids = centros.map((x) => x.id);
  if (!ids.length) return c.json({ items: [], centros, puede_gestionar: false, solo_propia: false });

  // El administrador ve a todo el personal (aunque aún no tenga centro); el
  // administrador de centros, solo a quien comparte alguno de los suyos.
  const where: string[] = user.rol === "admin"
    ? ["1 = 1"]
    : [`u.id IN (SELECT usuario_id FROM usuario_centros WHERE centro_id IN (${ids.map(() => "?").join(", ")}))`];
  const params: unknown[] = user.rol === "admin" ? [] : [...ids];
  if (centroId && ids.includes(centroId)) {
    where.push("u.id IN (SELECT usuario_id FROM usuario_centros WHERE centro_id = ?)");
    params.push(centroId);
  }
  if (q) {
    where.push("(u.nombre LIKE ? OR u.username LIKE ? OR COALESCE(u.email, '') LIKE ? OR COALESCE(u.puesto, '') LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  const res = await db.prepare(
    `SELECT u.id, u.nombre, u.username, u.email, u.telefono, u.puesto, u.rol, u.activo,
            (SELECT GROUP_CONCAT(c.nombre, ' · ') FROM usuario_centros uc JOIN centros c ON c.id = uc.centro_id
              WHERE uc.usuario_id = u.id) AS centros_nombre,
            (SELECT COUNT(*) FROM operario_formaciones of
              WHERE of.usuario_id = u.id AND of.caducidad IS NOT NULL AND of.caducidad < date('now')
                AND NOT EXISTS (SELECT 1 FROM operario_formaciones o2
                  WHERE o2.usuario_id = of.usuario_id AND o2.formacion_id = of.formacion_id AND o2.fecha > of.fecha)
            ) AS formaciones_vencidas
     FROM usuarios u
     WHERE ${where.join(" AND ")}
     ORDER BY u.nombre COLLATE NOCASE`,
  ).bind(...params).all<Row>();
  return c.json({ items: res.results, centros, puede_gestionar: true, solo_propia: false });
});

// Ficha completa de un operario.
operariosRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  const db = c.env.DB;
  const id = entero(c.req.param("id"));
  if (!id) return c.json({ error: "Operario no válido" }, 400);
  if (!(await puedeVerFicha(db, user, id))) {
    return c.json({ error: "Solo puedes ver tu propia ficha" }, 403);
  }
  const usuario = await db.prepare(
    `SELECT id, username, nombre, email, telefono, puesto, rol, activo, created_at FROM usuarios WHERE id = ?`,
  ).bind(id).first<Row>();
  if (!usuario) return c.json({ error: "Operario no encontrado" }, 404);

  const [centros, tallas, entregas, formaciones, movimientos] = await Promise.all([
    db.prepare(
      `SELECT c.id, c.nombre FROM usuario_centros uc JOIN centros c ON c.id = uc.centro_id
       WHERE uc.usuario_id = ? ORDER BY c.nombre COLLATE NOCASE`,
    ).bind(id).all<Row>(),
    db.prepare(
      "SELECT id, prenda, talla, fecha, notas FROM tallas_operarios WHERE usuario_id = ? ORDER BY fecha DESC, id DESC",
    ).bind(id).all<Row>(),
    db.prepare(
      `SELECT e.id, e.fecha, e.prenda, e.articulo_tipo, e.cantidad, e.talla, e.color,
              e.alta_visibilidad, e.auxiliar_servicios, e.manga_larga, c.nombre AS centro_nombre
       FROM ropa_entregas e LEFT JOIN centros c ON c.id = e.centro_id
       WHERE e.usuario_id = ? ORDER BY e.fecha DESC, e.id DESC`,
    ).bind(id).all<Row>(),
    db.prepare(
      `SELECT of.id, of.fecha, of.caducidad, of.notas, of.centro_id,
              f.nombre, f.tipo, f.meses_validez, c.nombre AS centro_nombre,
              CAST(julianday(of.caducidad) - julianday('now') AS INTEGER) AS dias
       FROM operario_formaciones of
       JOIN formaciones f ON f.id = of.formacion_id
       LEFT JOIN centros c ON c.id = of.centro_id
       WHERE of.usuario_id = ?
       ORDER BY f.nombre COLLATE NOCASE, of.fecha DESC`,
    ).bind(id).all<Row>(),
    db.prepare(
      `SELECT m.id, m.created_at, m.accion, m.tabla, m.descripcion, m.cantidad, m.motivo, m.registro_id
       FROM movimientos m WHERE m.usuario_id = ? ORDER BY m.created_at DESC, m.id DESC LIMIT 10`,
    ).bind(id).all<Row>(),
  ]);

  // Solo la titulación más reciente de cada formación.
  const ultimas = new Map<string, Row>();
  for (const fila of formaciones.results) {
    if (!ultimas.has(String(fila.nombre))) ultimas.set(String(fila.nombre), fila);
  }
  const formacionesVigentes = [...ultimas.values()];

  const epis = entregas.results.filter((e) => String(e.articulo_tipo ?? "") === "epis");
  const ropa = entregas.results.filter((e) => String(e.articulo_tipo ?? "") !== "epis");
  const resumen = {
    centros: centros.results.length,
    epis: epis.reduce((n, e) => n + Number(e.cantidad ?? 0), 0),
    ropa: ropa.reduce((n, e) => n + Number(e.cantidad ?? 0), 0),
    formaciones: formacionesVigentes.length,
    vencidas: formacionesVigentes.filter((f) => f.caducidad && Number(f.dias) < 0).length,
    proximas: formacionesVigentes.filter((f) => f.caducidad && Number(f.dias) >= 0 && Number(f.dias) <= 30).length,
  };

  const mios = await centrosDe(db, user.id);
  return c.json({
    usuario,
    centros: centros.results,
    tallas: tallas.results,
    epis,
    ropa,
    formaciones: formacionesVigentes,
    movimientos: movimientos.results,
    resumen,
    propio: user.id === id,
    puede_editar: user.rol === "admin" || (user.rol === "admin_centros" && mios.length > 0),
  });
});
