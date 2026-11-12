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
