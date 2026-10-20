import type { D1Database } from "./d1";
import type { SessionUser } from "./auth";

// Registro de auditoría: quién consumió, ajustó, creó, editó o borró qué,
// cuándo y con qué cantidad. Sin costes: solo interesa la cantidad.
export async function logMovimiento(
  db: D1Database,
  user: SessionUser,
  accion: string,
  tabla: string | null,
  registroId: number | null,
  descripcion: string,
  cantidad: number | null,
  motivo: string | null = null,
  estacionId: number | null = null,
): Promise<void> {
  await db.prepare(
    "INSERT INTO movimientos (usuario_id, accion, tabla, registro_id, descripcion, cantidad, motivo, estacion_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(user.id, accion, tabla, registroId, descripcion, cantidad, motivo, estacionId).run();
}
