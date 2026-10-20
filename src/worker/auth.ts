import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "./d1";
import type { Variables } from "./types";
import { sendPasswordResetCode } from "./email";

export type App = Hono<{ Bindings: Env; Variables: Variables }>;

const SESSION_COOKIE = "inv_session";
const SESSION_DAYS = 7;
const PBKDF2_ITERATIONS = 100000;
const encoder = new TextEncoder();

export interface SessionUser {
  id: number;
  username: string;
  nombre: string;
  rol: "admin" | "admin_centros" | "usuario";
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashPassword(password: string, salt: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(new Uint8Array(bits));
}

export function publicUser(row: Record<string, unknown>): SessionUser & { email: string | null; activo: boolean; centro_id: number | null } {
  return {
    id: Number(row.id),
    username: String(row.username),
    nombre: String(row.nombre),
    email: (row.email as string | null) ?? null,
    rol: row.rol === "admin_centros" ? "admin_centros" : row.rol === "admin" ? "admin" : "usuario",
    activo: Number(row.activo) === 1,
    centro_id: (row.centro_id as number | null) ?? null,
  };
}

async function createSession(db: Env["DB"], userId: number): Promise<string> {
  const token = randomToken();
  await db.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, datetime('now', ?))").bind(token, userId, `+${SESSION_DAYS} days`).run();
  return token;
}

export async function getUserByToken(db: Env["DB"], token: string): Promise<SessionUser | null> {
  const row = await db.prepare(
    `SELECT u.id, u.username, u.nombre, u.rol FROM sessions s JOIN usuarios u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now') AND u.activo = 1`,
  ).bind(token).first();
  if (!row) return null;
  return { id: Number(row.id), username: String(row.username), nombre: String(row.nombre), rol: (row.rol as "admin" | "admin_centros" | "usuario") };
}

function sessionCookieOptions(c: Context<{ Bindings: Env; Variables: Variables }>): { path: string; secure: boolean; sameSite: "Strict" | "None" } {
  const secure = new URL(c.req.url).protocol === "https:";
  return { path: "/", secure, sameSite: secure ? "None" : "Strict" };
}

async function currentUser(c: Context<{ Bindings: Env; Variables: Variables }>): Promise<SessionUser | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token) return null;
  const user = await getUserByToken(c.env.DB, token);
  if (!user) deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(c));
  return user;
}

export const requireAuth = async (c: Context<{ Bindings: Env; Variables: Variables }>, next: () => Promise<void>): Promise<Response | void> => {
  const user = await currentUser(c);
  if (!user) return c.json({ error: "No autenticado" }, 401);
  c.set("user", user);
  await next();
};

export const requireAdmin = async (c: Context<{ Bindings: Env; Variables: Variables }>, next: () => Promise<void>): Promise<Response | void> => {
  const user = c.get("user");
  if (!user || user.rol !== "admin") return c.json({ error: "Requiere permisos de administrador" }, 403);
  await next();
};

// ---------------------------------------------------------------------------
// Recuperación de contraseña por correo.
// Flujo en tres pasos:
//   1) /request-password-reset  → crea un token + código (10 min) y lo envía
//      por correo con SendGrid. Respuesta uniforme exista o no el correo.
//   2) /verify-password-reset   → comprueba el código y marca el token como
//      verificado.
//   3) /finish-password-reset   → solo acepta tokens ya verificados y vigentes
//      y fija la contraseña nueva.
// ---------------------------------------------------------------------------

const RESET_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateResetCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let out = "";
  for (const b of bytes) out += RESET_CODE_CHARS[b % RESET_CODE_CHARS.length];
  return out;
}

async function findActiveReset(db: Env["DB"], token: string): Promise<{ userId: number; code: string } | null> {
  const row = await db.prepare(
    "SELECT user_id, code FROM password_recovery_tokens WHERE token = ? AND expires_at > datetime('now')",
  ).bind(token).first();
  if (!row) return null;
  return { userId: Number(row.user_id), code: String(row.code ?? "") };
}

export const authRoutes: App = new Hono<{ Bindings: Env; Variables: Variables }>()
  .post("/login", async (c) => {
    let body: { username?: unknown; password?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return c.json({ error: "Indica usuario y contraseña" }, 400);
    const row = await c.env.DB.prepare("SELECT * FROM usuarios WHERE username = ?").bind(username).first();
    if (!row) return c.json({ error: "Usuario o contraseña incorrectos" }, 401);
    const hash = await hashPassword(password, String(row.salt));
    if (hash !== String(row.password_hash)) return c.json({ error: "Usuario o contraseña incorrectos" }, 401);
    if (Number(row.activo) !== 1) return c.json({ error: "Usuario desactivado. Contacta con un administrador." }, 403);
    const token = await createSession(c.env.DB, Number(row.id));
    setCookie(c, SESSION_COOKIE, token, { httpOnly: true, ...sessionCookieOptions(c), maxAge: SESSION_DAYS * 24 * 3600 });
    return c.json({ user: publicUser(row) });
  })
  .post("/logout", async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    deleteCookie(c, SESSION_COOKIE, sessionCookieOptions(c));
    return c.json({ ok: true });
  })
  .get("/me", requireAuth, async (c) => {
    const token = getCookie(c, SESSION_COOKIE)!;
    const row = await c.env.DB.prepare(
      `SELECT u.id, u.username, u.nombre, u.email, u.rol, u.activo, u.centro_id FROM sessions s JOIN usuarios u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > datetime('now')`,
    ).bind(token).first();
    if (!row) return c.json({ error: "No autenticado" }, 401);
    return c.json({ user: publicUser(row) });
  })
  .post("/cambiar-password", requireAuth, async (c) => {
    const user = c.get("user");
    let body: { actual?: unknown; nueva?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const actual = typeof body.actual === "string" ? body.actual : "";
    const nueva = typeof body.nueva === "string" ? body.nueva : "";
    if (nueva.length < 6) return c.json({ error: "La nueva contraseña debe tener al menos 6 caracteres" }, 400);
    const row = await c.env.DB.prepare("SELECT salt, password_hash FROM usuarios WHERE id = ?").bind(user.id).first();
    if (!row) return c.json({ error: "Usuario no encontrado" }, 404);
    const hash = await hashPassword(actual, String(row.salt));
    if (hash !== String(row.password_hash)) return c.json({ error: "La contraseña actual no es correcta" }, 400);
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const nuevoHash = await hashPassword(nueva, salt);
    await c.env.DB.prepare("UPDATE usuarios SET password_hash = ?, salt = ? WHERE id = ?").bind(nuevoHash, salt, user.id).run();
    return c.json({ ok: true });
  })
  .post("/request-password-reset", async (c) => {
    let body: { email?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!email) return c.json({ error: "Indica un correo electrónico" }, 400);
    // Respuesta uniforme exista o no el correo, para no revelar cuentas.
    const token = randomToken();
    const row = await c.env.DB.prepare(
      "SELECT id, username, nombre, email FROM usuarios WHERE email = ? AND activo = 1",
    ).bind(email).first();
    if (row) {
      const code = generateResetCode();
      await c.env.DB.prepare("DELETE FROM password_recovery_tokens WHERE user_id = ?").bind(Number(row.id)).run();
      await c.env.DB.prepare(
        "INSERT INTO password_recovery_tokens (user_id, token, code, expires_at) VALUES (?, ?, ?, datetime('now', '+10 minutes'))",
      ).bind(Number(row.id), token, code).run();
      try {
        await sendPasswordResetCode(c.env, String(row.email), String(row.username), String(row.nombre), code);
      } catch (err) {
        console.error("No se pudo enviar el correo de recuperación:", err);
        await c.env.DB.prepare("DELETE FROM password_recovery_tokens WHERE token = ?").bind(token).run();
        return c.json({ error: "No se pudo enviar el correo de verificación. Inténtalo más tarde." }, 503);
      }
    }
    return c.json({ ok: true, token, message: "Si el correo existe en el sistema, recibirás un código de verificación." });
  })
  .post("/verify-password-reset", async (c) => {
    let body: { token?: unknown; code?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const token = typeof body.token === "string" ? body.token : "";
    const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
    if (!token || !code) return c.json({ error: "Indica el código de verificación" }, 400);
    const active = await findActiveReset(c.env.DB, token);
    if (!active) return c.json({ error: "El código no es válido o ha caducado" }, 400);
    if (active.code) {
      if (active.code !== code) return c.json({ error: "El código no es válido o ha caducado" }, 400);
      // Marca el token como verificado (código vacío) para el paso siguiente.
      await c.env.DB.prepare("UPDATE password_recovery_tokens SET code = '' WHERE token = ?").bind(token).run();
    }
    return c.json({ ok: true, message: "Código verificado. Ahora puedes crear una nueva contraseña." });
  })
  .post("/finish-password-reset", async (c) => {
    let body: { token?: unknown; password?: unknown };
    try { body = await c.req.json(); } catch { return c.json({ error: "Petición inválida" }, 400); }
    const token = typeof body.token === "string" ? body.token : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!token) return c.json({ error: "Petición inválida" }, 400);
    if (password.length < 6) return c.json({ error: "La contraseña debe tener al menos 6 caracteres" }, 400);
    // Solo tokens con el código ya verificados y aún vigentes. No se modifica
    // `activo`: una cuenta desactivada no puede recuperar el acceso por aquí.
    const row = await c.env.DB.prepare(
      "SELECT user_id FROM password_recovery_tokens WHERE token = ? AND code = '' AND expires_at > datetime('now')",
    ).bind(token).first();
    if (!row) return c.json({ error: "Verifica el código primero o el enlace ha caducado" }, 400);
    const userId = Number(row.user_id);
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await hashPassword(password, salt);
    await c.env.DB.prepare("UPDATE usuarios SET password_hash = ?, salt = ? WHERE id = ?").bind(hash, salt, userId).run();
    await c.env.DB.prepare("DELETE FROM password_recovery_tokens WHERE user_id = ?").bind(userId).run();
    return c.json({ ok: true, message: "La contraseña se ha restablecido correctamente." });
  });
