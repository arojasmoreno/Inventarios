export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
// URL base de la API. Vacía en local (same-origin con wrangler dev sirve
// frontend y API); en producción (inventarios.freebuff.app) las peticiones van
// al Worker desplegado en Cloudflare. VITE_API_BASE, si está definida en el
// build, tiene prioridad. Se elimina la barra final para concatenar "/api/...".
const API_BASE = (import.meta.env.VITE_API_BASE ?? (window.location.hostname === "inventarios.freebuff.app" ? "https://inventarios.arojasmoreno.workers.dev" : "")).replace(/\/+$/, "");
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
