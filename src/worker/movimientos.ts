import type { CrudSpec } from "./crud";
import type { D1Database } from "./d1";
import type { SessionUser } from "./auth";

// Registro de auditoría: quién consumió o entregó qué y cuándo.
export async function logMovimiento(
  db: D1Database,
  user: SessionUser,
  accion: string,
  tabla: string | null,
  registroId: number | null,
  descripcion: string,
  cantidad: number | null,
): Promise<void> {
  await db.prepare(
    "INSERT INTO movimientos (usuario_id, accion, tabla, registro_id, descripcion, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(user.id, accion, tabla, registroId, descripcion, cantidad).run();
}

export const movimientosSpec: CrudSpec = {
  table: "movimientos", orderBy: "id", refUsuario: true,
  extraSelect: ["t.accion", "t.tabla", "t.registro_id", "t.descripcion", "t.cantidad"],
  extraSearchCols: ["t.accion", "t.descripcion"],
  read: "all", create: "admin", update: "admin", delete: "admin",
  fields: [],
};
