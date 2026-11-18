import type { Env } from "./d1";
import type { SessionUser } from "./auth";

// Alcance por centro: el administrador ve toda la instalación; el resto de
// roles (administrador de centros y usuario) solo los centros que tiene
// asignados en `usuario_centros`.
export async function centrosDeUsuario(db: Env["DB"], userId: number): Promise<number[]> {
  const res = await db.prepare("SELECT centro_id FROM usuario_centros WHERE usuario_id = ? ORDER BY centro_id")
    .bind(userId).all<{ centro_id: number }>();
  return res.results.map((r) => Number(r.centro_id));
}

/** Centros que puede consultar el usuario. `null` = sin restricción (admin). */
export async function centrosPermitidos(db: Env["DB"], user: SessionUser): Promise<number[] | null> {
  if (user.rol === "admin") return null;
  return centrosDeUsuario(db, user.id);
}

/** Marcadores de una lista IN (?, ?, ?). */
export function marcas(n: number): string {
  return new Array(n).fill("?").join(",");
}
