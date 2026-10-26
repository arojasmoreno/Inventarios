import { Hono } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth } from "./auth";
import { sendResumen } from "./email";

type Row = Record<string, unknown>;

// Alertas operativas: stock bajo, químicos caducando, revisiones de EPI
// próximas/vencidas y máquinas que no están operativas. Se usan en el panel,
// en el resumen diario por correo (cron) y en el envío manual.
export async function calcularAlertas(db: D1Database): Promise<{
  stock_bajo: Row[]; caducidades: Row[]; revisiones: Row[]; maquinas: Row[];
}> {
  const [stock, caducidades, revisiones, maquinas] = await Promise.all([
    db.prepare(
      `SELECT * FROM (
        SELECT MAX(nombre) AS nombre, SUM(litros_por_garrafa * num_garrafas) AS stock,
               COALESCE(MAX(CASE WHEN TRIM(COALESCE(numero_lote, '')) = '' THEN stock_minimo END), MAX(stock_minimo)) AS minimo,
               MAX(codigo) AS codigo, 'Químicos' AS categoria, 'quimicos' AS seccion
        FROM quimicos GROUP BY LOWER(TRIM(nombre)), LOWER(TRIM(COALESCE(marca, '')))
      ) WHERE minimo > 0 AND stock <= minimo
       UNION ALL SELECT nombre, cantidad, stock_minimo, codigo, 'Material de limpieza', 'material' FROM material_limpieza WHERE stock_minimo > 0 AND cantidad <= stock_minimo
       UNION ALL SELECT COALESCE(NULLIF(descripcion, ''), codigo), stock, stock_minimo, codigo, 'EPIs', 'epis' FROM epis WHERE stock_minimo > 0 AND stock <= stock_minimo
       UNION ALL SELECT prenda, stock, stock_minimo, codigo, 'Ropa de trabajo', 'ropa' FROM ropa_trabajo WHERE stock_minimo > 0 AND stock <= stock_minimo
       ORDER BY minimo, stock LIMIT 50`,
    ).all<Row>(),
    db.prepare(
      `SELECT q.nombre, q.numero_lote, q.fecha_caducidad, q.centro_id, c.nombre AS centro_nombre,
              CAST(julianday(q.fecha_caducidad) - julianday('now') AS INTEGER) AS dias
       FROM quimicos q LEFT JOIN centros c ON c.id = q.centro_id
       WHERE q.fecha_caducidad <= date('now', '+30 day') ORDER BY q.fecha_caducidad LIMIT 50`,
    ).all<Row>(),
    db.prepare(
      `SELECT COALESCE(NULLIF(e.descripcion, ''), e.codigo) AS nombre, e.codigo, e.fecha_revision, e.centro_id, c.nombre AS centro_nombre,
              CAST(julianday(e.fecha_revision) - julianday('now') AS INTEGER) AS dias
       FROM epis e LEFT JOIN centros c ON c.id = e.centro_id
       WHERE e.fecha_revision IS NOT NULL AND e.fecha_revision <= date('now', '+30 day')
       ORDER BY e.fecha_revision LIMIT 50`,
    ).all<Row>(),
    db.prepare(
      `SELECT m.id, m.nombre, m.tipo, m.estado, m.numero_serie, m.centro_id, c.nombre AS centro_nombre
       FROM maquinaria m LEFT JOIN centros c ON c.id = m.centro_id
       WHERE m.estado NOT IN ('Operativo', 'Operativa', 'Baja') ORDER BY m.estado, m.nombre LIMIT 50`,
    ).all<Row>(),
  ]);
  return { stock_bajo: stock.results, caducidades: caducidades.results, revisiones: revisiones.results, maquinas: maquinas.results };
}

async function enviarResumenDiario(env: Env): Promise<{ destinatarios: number; enviados: number; conteos: Record<string, number> }> {
  const a = await calcularAlertas(env.DB);
  const conteos = { stock: a.stock_bajo.length, caducidades: a.caducidades.length, revisiones: a.revisiones.length, maquinas: a.maquinas.length };
  const destinatarios = await env.DB.prepare(
    "SELECT email, nombre FROM usuarios WHERE rol = 'admin' AND activo = 1 AND email IS NOT NULL AND email != ''",
  ).all<Row>();
  const total = Object.values(conteos).reduce((x, n) => x + n, 0);
  const secciones: string[] = [];
  const lineas: string[] = [];
  if (conteos.maquinas) {
    secciones.push(`<h3>Máquinas no operativas (${conteos.maquinas})</h3><ul>${a.maquinas.map(m => `<li><strong>${String(m.nombre)}</strong> — ${String(m.estado)}${m.centro_nombre ? ` · ${String(m.centro_nombre)}` : ""}</li>`).join("")}</ul>`);
    lineas.push(`Máquinas no operativas: ${a.maquinas.map(m => `${String(m.nombre)} (${String(m.estado)})`).join(", ")}`);
  }
  if (conteos.stock) {
    secciones.push(`<h3>Stock bajo el mínimo (${conteos.stock})</h3><ul>${a.stock_bajo.map(s => `<li>${String(s.categoria)}: <strong>${String(s.nombre)}</strong> — ${String(s.stock)} / mín. ${String(s.minimo)}</li>`).join("")}</ul>`);
    lineas.push(`Stock bajo: ${a.stock_bajo.map(s => String(s.nombre)).join(", ")}`);
  }
  if (conteos.caducidades) {
    secciones.push(`<h3>Químicos caducando en 30 días (${conteos.caducidades})</h3><ul>${a.caducidades.map(q => `<li><strong>${String(q.nombre)}</strong> — caduca ${String(q.fecha_caducidad)}${Number(q.dias) < 0 ? " (VENCIDA)" : ` (${String(q.dias)} d)`}</li>`).join("")}</ul>`);
    lineas.push(`Caducidades: ${a.caducidades.map(q => String(q.nombre)).join(", ")}`);
  }
  if (conteos.revisiones) {
    secciones.push(`<h3>Revisiones de EPI próximas/vencidas (${conteos.revisiones})</h3><ul>${a.revisiones.map(r => `<li><strong>${String(r.nombre)}</strong> — ${String(r.fecha_revision)}${Number(r.dias) < 0 ? " (VENCIDA)" : ` (${String(r.dias)} d)`}</li>`).join("")}</ul>`);
    lineas.push(`Revisiones EPI: ${a.revisiones.map(r => String(r.nombre)).join(", ")}`);
  }
  const fecha = new Date().toISOString().slice(0, 10);
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8" /><style>body{font-family:"Segoe UI",system-ui,sans-serif;color:#0f172a}h1{font-size:20px}h3{font-size:15px;margin:18px 0 6px}li{margin:3px 0}.footer{margin-top:20px;font-size:12px;color:#64748b}</style></head><body>
    <h1>Inventarios · Resumen de alertas del ${fecha}</h1>
    <p>${total === 0 ? "Sin alertas: todo en orden." : secciones.join("")}</p>
    <p class="footer">Mensaje automático diario. Gestiona los avisos en Panel de control → Alertas.</p></body></html>`;
  const text = [`Resumen de alertas del ${fecha}`, "", ...(lineas.length ? lineas : ["Sin alertas: todo en orden."])].join("\n");
  let enviados = 0;
  for (const d of destinatarios.results) {
    if (!total) break;
    try {
      await sendResumen(env, String(d.email), `Inventarios · Alertas del ${fecha} (${total})`, html, text);
      enviados++;
    } catch (err) {
      console.error("No se pudo enviar el resumen de alertas:", err);
    }
  }
  return { destinatarios: destinatarios.results.length, enviados, conteos };
}

export { enviarResumenDiario };

export const alertasRoutes: Hono<{ Bindings: Env; Variables: Variables }> = new Hono<{ Bindings: Env; Variables: Variables }>();
alertasRoutes.use("*", requireAuth);

// Alertas para el panel (cualquier usuario autenticado).
alertasRoutes.get("/", async (c) => {
  const a = await calcularAlertas(c.env.DB);
  return c.json({
    ...a,
    conteos: { stock: a.stock_bajo.length, caducidades: a.caducidades.length, revisiones: a.revisiones.length, maquinas: a.maquinas.length },
  });
});

// Envío manual del resumen por correo (solo administradores).
alertasRoutes.post("/enviar", async (c) => {
  if (c.get("user").rol !== "admin") return c.json({ error: "Solo los administradores pueden enviar el resumen" }, 403);
  const r = await enviarResumenDiario(c.env);
  const total = Object.values(r.conteos).reduce((x, n) => x + n, 0);
  if (!total) return c.json({ ok: true, enviado: false, conteos: r.conteos, message: "Sin alertas: no hay nada que enviar." });
  if (!r.destinatarios) return c.json({ error: "Ningún administrador tiene correo configurado en su usuario." }, 400);
  return c.json({ ok: true, enviado: r.enviados > 0, destinatarios: r.destinatarios, enviados: r.enviados, conteos: r.conteos });
});
