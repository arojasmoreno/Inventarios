export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
// URL base de la API. En producción (inventarios.freebuff.app o GitHub Pages)
// el frontend vive en otro origen que la API, así que hay que apuntar SIEMPRE
// al Worker de Cloudflare: si se respetara VITE_API_BASE —que en el build llega
// vacío— las peticiones a /api/* caerían en el alojamiento estático y
// devolverían el index.html (de ahí el fallo de autenticación). En local
// VITE_API_BASE mantiene el comportamiento actual: vacío = mismo origen, que es
// lo que sirve wrangler dev. Se elimina la barra final para concatenar "/api/...".
const EN_PRODUCCION = window.location.hostname === "inventarios.freebuff.app" || window.location.hostname.endsWith(".github.io");
const API_BASE = (EN_PRODUCCION ? "https://inventarios.arojasmoreno.workers.dev" : (import.meta.env.VITE_API_BASE ?? "")).replace(/\/+$/, "");
async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), credentials: "include" });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* respuesta sin cuerpo */ }
  if (!res.ok) {
    const msg = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : `Error ${res.status}`;
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
