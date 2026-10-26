import { Hono } from "hono";
import type { Env, D1Database } from "./d1";
import type { Variables } from "./types";
import { requireAuth, requireAdmin } from "./auth";
import { logMovimiento } from "./audit";
import { ValidationError, validate, checkUnique, hoyISO } from "./crud";
import { quimicosSpec } from "./resources";

// Control de lotes de los productos químicos.
//
// Cada fila de `quimicos` es un LOTE: el mismo producto puede llegar con varios
// lotes (distinto nº de lote, fechas y precios). Estas rutas trabajan a nivel
// de producto sumando sus lotes:
//   · entrada  → alta de un lote nuevo o suma de garrafas a un lote existente.
//   · salida   → descuenta del lote que antes caduca (FEFO) y retira los lotes
//                que se quedan sin stock.
//   · recuento → hoja de inventario: los litros reales contados ajustan cada
//                lote y retiran (descartan) los que quedan a cero.

type Row = Record<string, unknown>;

interface Lote {
  id: number; nombre: string; marca: string | null; numero_lote: string;
  litros_por_garrafa: number; num_garrafas: number;
  fecha_caducidad: string | null; fecha_entrada: string | null; fecha_alta: string | null;
  centro_nombre: string | null; estado: string;
}

// Redondeo a 4 decimales: evita los residuos binarios de las divisiones de
// litros entre litros por garrafa al recalcular las garrafas de un lote.
const redondea = (n: number): number => Math.round(n * 10000) / 10000;

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

async function cargarLotes(db: D1Database, ids: number[]): Promise<Lote[]> {
  if (!ids.length) return [];
  const res = await db.prepare(
    `SELECT t.id, t.nombre, t.marca, t.numero_lote, t.litros_por_garrafa, t.num_garrafas,
            t.fecha_caducidad, t.fecha_entrada, date(t.created_at) AS fecha_alta, t.estado,
            c.nombre AS centro_nombre
     FROM quimicos t LEFT JOIN centros c ON c.id = t.centro_id
     WHERE t.id IN (${placeholders(ids.length)})`,
  ).bind(...ids).all();
  return res.results as unknown as Lote[];
}

// Orden de consumo FEFO (First Expired, First Out): primero el lote que antes
// caduca; sin fecha de caducidad, el que antes entró en almacén.
function ordenFefo(lotes: Lote[]): Lote[] {
  const fin = (v: string | null) => (typeof v === "string" && v ? v : "9999-99-99");
  return [...lotes].sort((a, b) =>
    fin(a.fecha_caducidad).localeCompare(fin(b.fecha_caducidad)) ||
    fin(a.fecha_entrada ?? a.fecha_alta).localeCompare(fin(b.fecha_entrada ?? b.fecha_alta)) ||
    a.id - b.id);
}

/** Cantidad a descontar de cada lote (FEFO) y las garrafas que quedan en él.
 *  Devuelve `pendiente` (> 0 si no había stock suficiente). */
function simularSalida(lotes: Lote[], cantidad: number, unidad: "litros" | "garrafas") {
  const detalle: Array<{ lote: Lote; tomado: number; restantes: number }> = [];
  let pendiente = cantidad;
  for (const l of ordenFefo(lotes)) {
    if (pendiente <= 1e-9) break;
    const garrafas = Math.max(0, Number(l.num_garrafas) || 0);
    if (garrafas <= 0) continue;
    if (unidad === "litros") {
      const lpg = Number(l.litros_por_garrafa) || 0;
      if (lpg <= 0) continue;
      const disponibles = garrafas * lpg;
      const toma = Math.min(disponibles, pendiente);
      pendiente -= toma;
      detalle.push({ lote: l, tomado: redondea(toma), restantes: redondea((disponibles - toma) / lpg) });
    } else {
      const toma = Math.min(garrafas, pendiente);
      pendiente -= toma;
      detalle.push({ lote: l, tomado: redondea(toma), restantes: redondea(garrafas - toma) });
    }
  }
  return { detalle, pendiente: redondea(pendiente) };
}

/** Litros disponibles en un conjunto de lotes (para los mensajes de error). */
function disponibles(lotes: Lote[], unidad: "litros" | "garrafas"): number {
  return redondea(lotes.reduce((s, l) => s + (unidad === "litros"
    ? Math.max(0, Number(l.num_garrafas) || 0) * (Number(l.litros_por_garrafa) || 0)
    : Math.max(0, Number(l.num_garrafas) || 0)), 0));
}

// Cuerpo de las peticiones: texto y números ya saneados.
async function cuerpo(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try { return (await c.req.json()) as Record<string, unknown>; } catch { return {}; }
}
const texto = (v: unknown, max: number): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const numero = (v: unknown): number => {
  if (v === null || v === undefined || v === "") return NaN;
  return Number(String(v).replace(",", "."));
};
const esEnteroPositivo = (n: unknown): n is number => Number.isInteger(n) && Number(n) > 0;

export const inventarioRoutes: Hono<{ Bindings: Env; Variables: Variables }> =
  new Hono<{ Bindings: Env; Variables: Variables }>()
    .use("*", requireAuth)

    // ── Entrada: alta de un lote nuevo o suma de garrafas a un lote ─────────
    .post("/entrada", requireAdmin, async (c) => {
      const body = await cuerpo(c);
      const acumular = Number(body.quimico_id ?? 0);
      const esAcumulo = Number.isInteger(acumular) && acumular > 0;
      // En acumulación no se repiden los datos del lote: solo se suma cantidad.
      const data = validate(quimicosSpec, body, esAcumulo ? "update" : "insert");
      const recibidas = Number(data.num_garrafas ?? 0);
      if (!Number.isFinite(recibidas) || recibidas < 1) {
        throw new ValidationError("Nº de garrafas: debe recibir 1 o más");
      }
      const motivo = texto(body.motivo, 300);
      let id: number;
      let detalle: string;
      if (esAcumulo) {
        const previo = await c.env.DB.prepare(
          "SELECT id, nombre, numero_lote, num_garrafas FROM quimicos WHERE id = ?",
        ).bind(acumular).first();
        if (!previo) return c.json({ error: "El lote seleccionado ya no existe" }, 404);
        await c.env.DB.prepare(
          "UPDATE quimicos SET num_garrafas = num_garrafas + ?, estado = 'activo', updated_at = datetime('now') WHERE id = ?",
        ).bind(recibidas, acumular).run();
        id = acumular;
        detalle = `${String(previo.nombre)} · lote ${String(previo.numero_lote)}`;
      } else {
        if (data.fecha_entrada === undefined || data.fecha_entrada === null) data.fecha_entrada = hoyISO();
        data.estado = "activo";
        await checkUnique(c.env.DB, quimicosSpec, data, null);
        const keys = Object.keys(data);
        const res = await c.env.DB.prepare(
          `INSERT INTO quimicos (${keys.join(", ")}) VALUES (${placeholders(keys.length)})`,
        ).bind(...keys.map((k) => data[k])).run();
        id = Number((res.meta as { last_row_id?: number }).last_row_id ?? 0);
        detalle = `${String(data.nombre)} · lote ${String(data.numero_lote)}`;
      }
      const row = await c.env.DB.prepare(
        "SELECT id, num_garrafas, litros_por_garrafa, estado FROM quimicos WHERE id = ?",
      ).bind(id).first();
      await logMovimiento(c.env.DB, c.get("user"), "entrada", "quimicos", id,
        `Entrada: ${detalle} (+${recibidas} garrafas)`, recibidas, motivo);
      return c.json({
        ok: true,
        item: {
          id,
          num_garrafas: Number(row?.num_garrafas ?? 0),
          total_litros: redondea(Number(row?.num_garrafas ?? 0) * Number(row?.litros_por_garrafa ?? 0)),
          estado: String(row?.estado ?? "activo"),
        },
        mensaje: `Entrada registrada: ${detalle}. Quedan ${Number(row?.num_garrafas ?? 0)} garrafas.`,
      });
    })

    // ── Salida: descuento por producto repartido entre sus lotes (FEFO) ─────
    .post("/salida", requireAdmin, async (c) => {
      const body = await cuerpo(c);
      const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(esEnteroPositivo) : [];
      if (!ids.length || ids.length > 200) return c.json({ error: "Selecciona los lotes del producto" }, 400);
      const conLitros = body.litros !== undefined && body.litros !== null && body.litros !== "";
      const conGarrafas = body.garrafas !== undefined && body.garrafas !== null && body.garrafas !== "";
      if (conLitros === conGarrafas) return c.json({ error: "Indica la cantidad en litros o en garrafas" }, 400);
      const unidad: "litros" | "garrafas" = conLitros ? "litros" : "garrafas";
      const cantidad = numero(conLitros ? body.litros : body.garrafas);
      if (!Number.isFinite(cantidad) || cantidad <= 0) {
        return c.json({ error: `La cantidad en ${unidad} debe ser mayor que 0` }, 400);
      }
      const motivo = texto(body.motivo, 300);
      const lotes = await cargarLotes(c.env.DB, [...new Set(ids)]);
      if (!lotes.length) return c.json({ error: "Los lotes seleccionados ya no existen" }, 404);
      const { detalle, pendiente } = simularSalida(lotes, cantidad, unidad);
      if (pendiente > 0 || !detalle.length) {
        const hay = disponibles(lotes, unidad);
        return c.json({
          error: `Stock insuficiente: solo quedan ${hay} ${unidad === "litros" ? "litros" : "garrafas"} de «${lotes[0].nombre}»`,
          disponibles: hay,
        }, 400);
      }
      // Se aplica el descuento lote a lote y se retiran los que quedan a cero.
      for (const d of detalle) {
        await c.env.DB.prepare(
          "UPDATE quimicos SET num_garrafas = ?, estado = ?, updated_at = datetime('now') WHERE id = ?",
        ).bind(d.restantes, d.restantes <= 0.0001 ? "agotado" : "activo", d.lote.id).run();
      }
      const total = redondea(detalle.reduce((s, d) => s + d.tomado, 0));
      const partes = detalle.map((d) => `${d.lote.numero_lote} (−${d.tomado} ${unidad === "litros" ? "L" : "g"})`);
      const retirados = detalle.filter((d) => d.restantes <= 0.0001).length;
      await logMovimiento(c.env.DB, c.get("user"), "salida", "quimicos", detalle[0].lote.id,
        `Salida de «${lotes[0].nombre}»: ${partes.join(", ")}`, total, motivo);
      return c.json({
        ok: true,
        detalle: detalle.map((d) => ({
          id: d.lote.id, numero_lote: d.lote.numero_lote, tomado: d.tomado, restantes: d.restantes,
          retirado: d.restantes <= 0.0001,
        })),
        total,
        retirados,
        mensaje: `Salida de ${total} ${unidad === "litros" ? "litros" : "garrafas"} de «${lotes[0].nombre}»${retirados ? ` · ${retirados} lote${retirados === 1 ? "" : "s"} retirado${retirados === 1 ? "" : "s"}` : ""}.`,
      });
    })

    // ── Recuento: la hoja de inventario escrita en la aplicación ────────────
    .post("/recuento", requireAdmin, async (c) => {
      const body = await cuerpo(c);
      const lineas = Array.isArray(body.lineas) ? body.lineas : [];
      if (!lineas.length) return c.json({ error: "El recuento no tiene ninguna línea" }, 400);
      if (lineas.length > 500) return c.json({ error: "Recuento demasiado largo" }, 400);
      const parsed: Array<{ id: number; unidad: "litros" | "garrafas"; valor: number }> = [];
      for (const raw of lineas) {
        const l = (raw ?? {}) as Record<string, unknown>;
        const id = Number(l.quimico_id);
        if (!Number.isInteger(id) || id < 1) return c.json({ error: "Línea de recuento no válida" }, 400);
        if (parsed.some((p) => p.id === id)) return c.json({ error: "Un mismo lote aparece dos veces en el recuento" }, 400);
        const unidad: "litros" | "garrafas" = l.unidad === "garrafas" ? "garrafas" : "litros";
        const valor = numero(l.valor);
        if (!Number.isFinite(valor) || valor < 0) {
          return c.json({ error: `Valor no válido en la línea del lote ${id}` }, 400);
        }
        parsed.push({ id, unidad, valor });
      }
      const lotes = await cargarLotes(c.env.DB, parsed.map((p) => p.id));
      const porId = new Map(lotes.map((l) => [l.id, l]));
      for (const p of parsed) if (!porId.has(p.id)) return c.json({ error: "Un lote del recuento ya no existe" }, 404);
      for (const p of parsed) {
        const l = porId.get(p.id)!;
        if (p.unidad === "litros" && (Number(l.litros_por_garrafa) || 0) <= 0) {
          return c.json({ error: `«${l.nombre}» no tiene litros por garrafa: cuenta sus garrafas en su lugar` }, 400);
        }
      }
      const notas = texto(body.notas, 500);
      const ajustes = parsed.filter((p) => {
        const l = porId.get(p.id)!;
        const lpg = Number(l.litros_por_garrafa) || 0;
        const teorico = p.unidad === "litros" ? Math.max(0, Number(l.num_garrafas) || 0) * lpg : Math.max(0, Number(l.num_garrafas) || 0);
        return Math.abs(p.valor - teorico) > 0.001;
      }).length;

      const ins = await c.env.DB.prepare(
        "INSERT INTO inventarios (usuario_id, fecha, notas, lineas) VALUES (?, date('now'), ?, ?)",
      ).bind(c.get("user").id, notas, parsed.length).run();
      const inventarioId = Number((ins.meta as { last_row_id?: number }).last_row_id ?? 0);

      let diferenciaTotal = 0;
      let retirados = 0;
      const insLinea = await c.env.DB.prepare(
        `INSERT INTO inventarios_lineas (inventario_id, quimico_id, nombre, marca, numero_lote, centro,
           litros_teoricos, litros_reales, diferencia, estado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const updLote = await c.env.DB.prepare(
        "UPDATE quimicos SET num_garrafas = ?, estado = ?, updated_at = datetime('now') WHERE id = ?",
      );
      for (const p of parsed) {
        const l = porId.get(p.id)!;
        const lpg = Number(l.litros_por_garrafa) || 0;
        const garrafas = Math.max(0, Number(l.num_garrafas) || 0);
        const teorico = p.unidad === "litros" ? redondea(garrafas * lpg) : redondea(garrafas);
        const real = redondea(p.valor);
        const diferencia = redondea(real - teorico);
        const nuevas = p.unidad === "litros" ? redondea(real / lpg) : real;
        // Contado a cero con stock anterior: el lote se retira (descartado).
        // Si ya estaba a cero, se mantiene como agotado.
        const estado = nuevas <= 0.0001 ? (garrafas > 0 ? "descartado" : "agotado") : "activo";
        await updLote.bind(nuevas, estado, l.id).run();
        await insLinea.bind(inventarioId, l.id, l.nombre, l.marca, l.numero_lote, l.centro_nombre,
          teorico, real, diferencia, estado).run();
        if (p.unidad === "litros") diferenciaTotal += diferencia;
        // Retirado por este recuento: tenía stock y el conteo lo deja a cero.
        // Los lotes que ya estaban vacíos se cuentan como ajustes, no como retirados.
        if (nuevas <= 0.0001 && garrafas > 0) retirados++;
      }
      diferenciaTotal = redondea(diferenciaTotal);
      await c.env.DB.prepare("UPDATE inventarios SET diferencia = ? WHERE id = ?").bind(diferenciaTotal, inventarioId).run();
      await logMovimiento(c.env.DB, c.get("user"), "recuento", "inventarios", inventarioId,
        `Recuento de inventario: ${parsed.length} lotes · ${ajustes} ajustes · ${retirados} retirados · ${diferenciaTotal} L`,
        null, notas);
      return c.json({
        ok: true,
        inventario: { id: inventarioId, fecha: hoyISO(), lineas: parsed.length, diferencia: diferenciaTotal },
        ajustes,
        retirados,
        mensaje: `Recuento guardado: ${parsed.length} lotes, ${ajustes} ajustes y ${retirados} lote${retirados === 1 ? "" : "s"} retirado${retirados === 1 ? "" : "s"}.`,
      });
    })

    // ── Histórico de recuentos (la «inventario anterior») ───────────────────
    .get("/recuentos", async (c) => {
      const res = await c.env.DB.prepare(
        `SELECT i.id, i.fecha, i.notas, i.lineas, i.diferencia, i.created_at, u.nombre AS usuario_nombre
         FROM inventarios i LEFT JOIN usuarios u ON u.id = i.usuario_id
         ORDER BY i.id DESC LIMIT 20`,
      ).all();
      return c.json({ items: res.results as Row[] });
    });
