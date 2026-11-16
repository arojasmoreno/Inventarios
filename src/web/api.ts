export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
// URL base de la API. El Worker de Cloudflare sirve frontend y API desde el
// mismo origen (y en local wrangler dev igual), pero el alojamiento estático de
// Freebuff NO aplica el rewrite de vercel.json: ahí /api/* devuelve el
// index.html y el login falla. Por eso fuera de local se apunta siempre al
// Worker; VITE_API_BASE permite sobreescribirlo. Se quita la barra final para
// concatenar "/api/...".
const WORKER = "https://inventarios.arojasmoreno.workers.dev";
const MISMO_ORIGEN = ["localhost", "127.0.0.1"].includes(window.location.hostname);
const API_BASE = (import.meta.env.VITE_API_BASE ?? (MISMO_ORIGEN ? "" : WORKER)).replace(/\/+$/, "");
// Los errores que ve el usuario (peticiones fallidas, importaciones…) quedan en
// el histórico de errores que se consulta en Gestión de informes → Errores. El
// envío es «fire and forget»: si falla no debe interrumpir la acción actual.
// No se reportan los fallos del propio histórico ni los de sesión/permisos para
// no llenarlo de ruido ni provocar bucles.
const SIN_REPORTAR = (url: string, status: number): boolean =>
  url.startsWith("/api/errores") || status === 401 || status === 403;

export function reportarError(
  mensaje: string,
  extra: { nivel?: "error" | "aviso"; origen?: string; metodo?: string; ruta?: string; detalle?: string } = {},
): void {
  if (!mensaje.trim()) return;
  try {
    void fetch(`${API_BASE}/api/errores/registrar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        mensaje,
        nivel: extra.nivel ?? "error",
        origen: extra.origen ?? "cliente",
        metodo: extra.metodo ?? null,
        ruta: extra.ruta ?? null,
        detalle: extra.detalle ?? null,
      }),
    }).catch(() => undefined);
  } catch { /* sin conexión */ }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Error ${res.status}`;
    if (!SIN_REPORTAR(url, res.status)) reportarError(msg, { origen: "api", metodo: method, ruta: url, detalle: `HTTP ${res.status}` });
    throw new ApiError(res.status, msg);
  }
  return data as T;
}
export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body: unknown) => request<T>("POST", url, body),
  put: <T,>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T,>(url: string) => request<T>("DELETE", url),
};
