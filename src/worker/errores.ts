import { Hono } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";

// Histórico de errores de la aplicación. Se alimenta de:
//  · los fallos no controlados del Worker (origen «servidor»),
//  · las peticiones fallidas que reporta el frontend (origen «api»/«cliente»),
//  · los problemas detectados al importar un CSV (origen «importar»).
// Solo los administradores consultan y vacían el histórico.

export type ErrorNivel = "error" | "aviso";

export interface ErrorEntrada {
  nivel?: ErrorNivel;
  origen?: string;
  metodo?: string | null;
  ruta?: string | null;
  mensaje: string;
  detalle?: string | null;
  usuario_id?: number | null;
  usuario?: string | null;
}

const texto = (v: string | null | undefined, max: number): string | null => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** Guarda un error en el histórico sin interrumpir la petición que lo originó. */
export async function registrarError(db: D1Database, e: ErrorEntrada): Promise<void> {
  const mensaje = texto(e.mensaje, 1000);
  if (!mensaje) return;
  try {
    await db.prepare(
      `INSERT INTO errores (nivel, origen, metodo, ruta, mensaje, detalle, usuario_id, usuario)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      e.nivel === "aviso" ? "aviso" : "error",
      texto(e.origen, 40) ?? "servidor",
      texto(e.metodo, 10),
      texto(e.ruta, 300),
      mensaje,
      texto(e.detalle, 4000),
      e.usuario_id ?? null,
      texto(e.usuario, 120),
    ).run();
  } catch (err) {
    // Si falla el registro del error no se puede hacer nada más: solo queda
    // dejarlo en el log del Worker.
    console.error("No se pudo registrar el error en el histórico:", err);
  }
}

export const erroresRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  // Listado del histórico con filtros por nivel, origen, texto y rango de fechas.
  .get("/", async (c) => {
    if (c.get("user").rol !== "admin") return c.json({ error: "Requiere permisos de administrador" }, 403);
    const where: string[] = [], params: unknown[] = [];
    const nivel = (c.req.query("nivel") ?? "").trim();
    if (nivel === "error" || nivel === "aviso") { where.push("nivel = ?"); params.push(nivel); }
    const origen = (c.req.query("origen") ?? "").trim();
    if (origen && origen !== "all") { where.push("origen = ?"); params.push(origen); }
    const desde = (c.req.query("desde") ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(desde)) { where.push("date(fecha) >= ?"); params.push(desde); }
    const hasta = (c.req.query("hasta") ?? "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(hasta)) { where.push("date(fecha) <= ?"); params.push(hasta); }
    const q = (c.req.query("q") ?? "").trim();
    if (q) {
      where.push("(mensaje LIKE ? OR detalle LIKE ? OR ruta LIKE ? OR usuario LIKE ?)");
      for (let i = 0; i < 4; i++) params.push(`%${q}%`);
    }
    const limiteRaw = Number(c.req.query("limite"));
    const limite = Number.isInteger(limiteRaw) && limiteRaw > 0 ? Math.min(limiteRaw, 1000) : 200;
    const sql = `SELECT id, fecha, nivel, origen, metodo, ruta, mensaje, detalle, usuario
      FROM errores${where.length ? " WHERE " + where.join(" AND ") : ""}
      ORDER BY fecha DESC, id DESC LIMIT ${limite}`;
    const items = (await c.env.DB.prepare(sql).bind(...params).all()).results;
    const total = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM errores${where.length ? " WHERE " + where.join(" AND ") : ""}`,
    ).bind(...params).first();
    // Errores repetidos: se agrupan por mensaje y origen para detectar los que
    // más se repiten (avisos del panel y pestaña Errores).
    const grupos = await c.env.DB.prepare(
      `SELECT mensaje, origen, nivel, COUNT(*) AS veces, MAX(fecha) AS ultimo
       FROM errores${where.length ? " WHERE " + where.join(" AND ") : ""}
       GROUP BY mensaje, origen, nivel HAVING COUNT(*) > 1
       ORDER BY veces DESC, ultimo DESC LIMIT 8`,
    ).bind(...params).all();
    return c.json({ items, total: Number(total?.n ?? items.length), grupos: grupos.results });
  })
  // Registro de un error visto por el frontend (petición fallida, importación…).
  .post("/registrar", async (c) => {
    const user = c.get("user");
    let body: Record<string, unknown>;
    try { body = (await c.req.json()) as Record<string, unknown>; } catch { return c.json({ error: "Petición inválida" }, 400); }
    const mensaje = typeof body.mensaje === "string" ? body.mensaje : "";
    if (!mensaje.trim()) return c.json({ error: "Falta el mensaje del error" }, 400);
    await registrarError(c.env.DB, {
      nivel: body.nivel === "aviso" ? "aviso" : "error",
      origen: typeof body.origen === "string" ? body.origen : "cliente",
      metodo: typeof body.metodo === "string" ? body.metodo : null,
      ruta: typeof body.ruta === "string" ? body.ruta : null,
      mensaje,
      detalle: typeof body.detalle === "string" ? body.detalle : null,
      usuario_id: user.id,
      usuario: `${user.nombre ?? user.username ?? ""} (${user.username ?? ""})`.trim(),
    });
    return c.json({ ok: true }, 201);
  })
  // Vaciar el histórico completo (solo administradores).
  .delete("/", async (c) => {
    if (c.get("user").rol !== "admin") return c.json({ error: "Requiere permisos de administrador" }, 403);
    await c.env.DB.prepare("DELETE FROM errores").run();
    return c.json({ ok: true });
  })
  // Borrar una entrada concreta.
  .delete("/:id", async (c) => {
    if (c.get("user").rol !== "admin") return c.json({ error: "Requiere permisos de administrador" }, 403);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id < 1) return c.json({ error: "Error no válido" }, 400);
    await c.env.DB.prepare("DELETE FROM errores WHERE id = ?").bind(id).run();
    return c.json({ ok: true });
  });
