import { Hono } from "hono";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { bootstrap } from "./db";
import { authRoutes } from "./auth";
import { ValidationError } from "./crud";
import { quimicos, material, maquinaria, centros, usuarios } from "./resources";
import { reportesRoutes } from "./reportes";

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
app.use("*", async (c, next) => {
  await bootstrap(c.env.DB);
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const requestUrl = new URL(c.req.url);
        if (originUrl.origin !== requestUrl.origin) return c.json({ error: "Origen no permitido" }, 403);
      } catch {
        return c.json({ error: "Origen no permitido" }, 403);
      }
    }
  }
  await next();
});
app.route("/api/auth", authRoutes);
app.route("/api/quimicos", quimicos);
app.route("/api/material-limpieza", material);
app.route("/api/maquinaria", maquinaria);
app.route("/api/centros", centros);
app.route("/api/usuarios", usuarios);
app.route("/api/informes", reportesRoutes);
app.get("/api/salud", (c) => c.json({ ok: true, app: "Inventarios" }));
app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ error: "Ruta no encontrada" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});
app.onError((err, c) => {
  if (err instanceof ValidationError) return c.json({ error: err.message }, 400);
  console.error("Error no controlado:", err);
  return c.json({ error: "Error interno del servidor" }, 500);
});
export default app;
