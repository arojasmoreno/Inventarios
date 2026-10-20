import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { bootstrap } from "./db";
import { authRoutes } from "./auth";
import { ValidationError } from "./crud";
import { quimicos, material, maquinaria, centros, usuarios, epis, ropa, tallas, entregas, movimientos, tipos, puntos, zonas, subzonas } from "./resources";
import { consumoRoutes } from "./consumo";
import { movimientosRoutes } from "./movimientos";
import { empresaRoutes } from "./empresa";
import { reportesRoutes } from "./reportes";

// Origenes externos de confianza: el frontend servido por Freebuff y el
// servidor de desarrollo de Vite. Las peticiones same-origin siempre pasan.
const TRUSTED_ORIGINS = new Set([
  "https://inventarios.freebuff.app",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]);

function isTrustedOrigin(origin: string | undefined, requestUrl: string): boolean {
  if (!origin) return true;
  try {
    if (origin === new URL(requestUrl).origin) return true;
  } catch {
    return false;
  }
  return TRUSTED_ORIGINS.has(origin);
}

const app = new Hono<{ Bindings: Env; Variables: Variables }>();
// CORS para que inventarios.freebuff.app (otro origen) pueda llamar a la API
// con cookies incluidas; responde también a los preflight OPTIONS.
app.use("*", cors({
  origin: (origin, c) => (isTrustedOrigin(origin, c.req.url) ? origin : ""),
  credentials: true,
  allowHeaders: ["Content-Type"],
  maxAge: 86400,
}));
app.use("*", async (c, next) => {
  await bootstrap(c.env.DB);
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && !isTrustedOrigin(c.req.header("Origin"), c.req.url)) {
    return c.json({ error: "Origen no permitido" }, 403);
  }
  await next();
});
app.route("/api/auth", authRoutes);
app.route("/api/quimicos", quimicos);
app.route("/api/material-limpieza", material);
app.route("/api/maquinaria", maquinaria);
app.route("/api/centros", centros);
app.route("/api/usuarios", usuarios);
app.route("/api/epis", epis);
app.route("/api/ropa-trabajo", ropa);
app.route("/api/tallas", tallas);
app.route("/api/entregas", entregas);
app.route("/api/movimientos", movimientos);
app.route("/api/movimientos", movimientosRoutes);
app.route("/api/zonas", zonas);
app.route("/api/subzonas", subzonas);
app.route("/api/tipos-maquinaria", tipos);
app.route("/api/puntos-consumo", puntos);
app.route("/api/empresa", empresaRoutes);
app.route("/api/consumo", consumoRoutes);
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
