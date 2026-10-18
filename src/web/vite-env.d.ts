/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** URL base del backend (Worker de Cloudflare). Vacía en local. */
  readonly VITE_API_BASE?: string;
}
