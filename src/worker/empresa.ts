import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { requireAuth, requireAdmin } from "./auth";

// Datos de la empresa (singleton): nombre y logo para los informes.
export const empresaRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>()
  .use("*", requireAuth)
  .get("/", async (c) => {
    const row = await c.env.DB.prepare("SELECT nombre, logo FROM empresa WHERE id = 1").first();
    return c.json({ empresa: { nombre: row?.nombre ?? null, logo: row?.logo ?? null, tiene_logo: Boolean(row?.logo) } });
  })
  .get("/logo", async (c) => {
    const row = await c.env.DB.prepare("SELECT logo FROM empresa WHERE id = 1").first();
    if (!row?.logo || typeof row.logo !== "string") return c.json({ error: "Logo no disponible" }, 404);
    const m = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(row.logo);
    if (!m) return c.json({ error: "Logo no válido" }, 500);
    const bin = Uint8Array.from(atob(m[2]), (ch) => ch.charCodeAt(0));
    return new Response(bin, { headers: { "Content-Type": m[1], "Cache-Control": "private, max-age=300" } });
  })
  .put("/", requireAdmin, async (c) => {
    let body: { nombre?: unknown; logo?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const nombre = typeof body.nombre === "string" ? body.nombre.trim().slice(0, 120) : null;
    const logo = typeof body.logo === "string" ? body.logo : null;
    if (logo && !/^data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+$/.test(logo)) return c.json({ error: "El logo debe ser una imagen en base64" }, 400);
    if (logo && logo.length > 1500000) return c.json({ error: "El logo es demasiado grande (máx. aprox. 1 MB)" }, 400);
    const existing = await c.env.DB.prepare("SELECT nombre, logo FROM empresa WHERE id = 1").first();
    const finalNombre = nombre ?? existing?.nombre ?? null;
    const finalLogo = logo ?? existing?.logo ?? null;
    if (existing) {
      await c.env.DB.prepare("UPDATE empresa SET nombre = ?, logo = ?, updated_at = datetime('now') WHERE id = 1").bind(finalNombre, finalLogo).run();
    } else {
      await c.env.DB.prepare("INSERT INTO empresa (id, nombre, logo) VALUES (1, ?, ?)").bind(finalNombre, finalLogo).run();
    }
    return c.json({ ok: true, empresa: { nombre: finalNombre, tiene_logo: Boolean(finalLogo) } });
  });
