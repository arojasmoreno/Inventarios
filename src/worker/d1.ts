// Tipos mínimos de D1 (SQLite en Cloudflare Workers) para no depender de
// paquetes de tipos que chocan con los tipos de DOM.

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: Record<string, unknown>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run(): Promise<D1Result>;
}

export interface D1Database {
  prepare(sql: string): D1Statement;
  exec(sql: string): Promise<unknown>;
}

export interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface Env {
  DB: D1Database;
  ASSETS: AssetsBinding;
  // Twilio SendGrid. En local las lee wrangler dev desde .env (o .dev.vars);
  // en producción se inyectan como secretos del Worker.
  SENDGRID_API_KEY?: string;
  SENDGRID_FROM_EMAIL?: string;
}
