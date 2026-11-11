import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { etiquetaPeriodo, leerPeriodo } from '../src/worker/periodo';
import { construirCsv } from '../src/web/csv';
import { makeD1 } from './d1-shim';

describe('filtro de periodo de los informes', () => {
  test('sin fechas no añade ninguna condición', () => {
    const r = leerPeriodo(null, null);
    expect(r).toEqual({ desde: null, hasta: null, sql: '', binds: [] });
  });

  test('desde y hasta se traducen a un rango parametrizado', () => {
    const r = leerPeriodo('2026-01-01', '2026-01-31');
    if ('error' in r) throw new Error('no debería fallar');
    expect(r.desde).toBe('2026-01-01');
    expect(r.hasta).toBe('2026-01-31');
    expect(r.binds).toEqual(['2026-01-01', '2026-01-31']);
    expect(r.sql).toContain(">= datetime(?, '00:00:00')");
    expect(r.sql).toContain("<= datetime(?, '23:59:59')");
  });

  test('admite solo una de las dos fechas', () => {
    const soloDesde = leerPeriodo('2026-03-01', '');
    if ('error' in soloDesde) throw new Error('no debería fallar');
    expect(soloDesde.hasta).toBeNull();
    expect(soloDesde.binds).toEqual(['2026-03-01']);
    const soloHasta = leerPeriodo(undefined, '2026-03-31');
    if ('error' in soloHasta) throw new Error('no debería fallar');
    expect(soloHasta.desde).toBeNull();
    expect(soloHasta.binds).toEqual(['2026-03-31']);
  });

  test('rechaza formatos inválidos y rangos invertidos', () => {
    expect(leerPeriodo('01/01/2026', null)).toEqual({ error: "Formato de 'desde' incorrecto (AAAA-MM-DD)" });
    expect(leerPeriodo('2026-02-30', null)).toEqual({ error: "Formato de 'desde' incorrecto (AAAA-MM-DD)" });
    expect(leerPeriodo(null, '2026-13-01')).toEqual({ error: "Formato de 'hasta' incorrecto (AAAA-MM-DD)" });
    expect(leerPeriodo('2026-05-02', '2026-05-01')).toEqual({ error: "'desde' no puede ser posterior a 'hasta'" });
  });

  test('la etiqueta del periodo es legible para cabeceras y CSV', () => {
    expect(etiquetaPeriodo('2026-01-01', '2026-01-31')).toBe('2026-01-01 a 2026-01-31');
    expect(etiquetaPeriodo('2026-01-01', null)).toBe('desde 2026-01-01');
    expect(etiquetaPeriodo(null, '2026-01-31')).toBe('hasta 2026-01-31');
    expect(etiquetaPeriodo(null, null)).toBe('todo el histórico');
  });
});

describe('filtro de periodo sobre SQLite real (shim D1)', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE estaciones (id INTEGER PRIMARY KEY, centro_id INTEGER);
    CREATE TABLE movimientos (id INTEGER PRIMARY KEY AUTOINCREMENT, accion TEXT, tabla TEXT, registro_id INTEGER,
      estacion_id INTEGER, cantidad INTEGER, created_at TEXT);
    INSERT INTO estaciones (id, centro_id) VALUES (1, 1), (2, 2);
    INSERT INTO movimientos (accion, tabla, registro_id, estacion_id, cantidad, created_at) VALUES
      ('consumo', 'quimicos', 7, 1, 3, '2026-01-05 10:00:00'),
      ('entrada', 'quimicos', 7, 1, 8, '2026-01-06 08:00:00'),
      ('consumo', 'quimicos', 7, 1, 2, '2026-02-10 09:30:00'),
      ('consumo', 'quimicos', 7, 2, 5, '2026-03-01 12:00:00');
  `);
  const db = makeD1(sqlite);

  const consumos = async (desde: string | null, hasta: string | null) => {
    const p = leerPeriodo(desde, hasta);
    if ('error' in p) throw new Error(p.error);
    const r = await db
      .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(m.cantidad), 0) AS uds FROM movimientos m WHERE m.accion = 'consumo'${p.sql}`)
      .bind(...p.binds)
      .first<{ n: number; uds: number }>();
    return { n: Number(r?.n ?? 0), uds: Number(r?.uds ?? 0) };
  };

  test('sin periodo cuenta todo el histórico', async () => {
    expect(await consumos(null, null)).toEqual({ n: 3, uds: 10 });
  });

  test('acota por desde, por hasta y por ambos extremos (inclusive)', async () => {
    expect(await consumos('2026-02-01', null)).toEqual({ n: 2, uds: 7 });
    expect(await consumos(null, '2026-01-31')).toEqual({ n: 1, uds: 3 });
    expect(await consumos('2026-01-01', '2026-02-28')).toEqual({ n: 2, uds: 5 });
    expect(await consumos('2026-03-01', '2026-03-01')).toEqual({ n: 1, uds: 5 });
  });

  test('el historial por artículo filtra por tabla y registro, y respeta el periodo', async () => {
    const p = leerPeriodo('2026-01-01', '2026-01-31');
    if ('error' in p) throw new Error(p.error);
    const res = await db
      .prepare(`SELECT m.id, m.accion, m.cantidad FROM movimientos m
        WHERE m.tabla = ? AND m.registro_id = ?${p.sql}
        ORDER BY m.created_at DESC, m.id DESC LIMIT 100`)
      .bind('quimicos', 7, ...p.binds)
      .all<{ accion: string; cantidad: number }>();
    expect(res.results.map((r) => r.accion)).toEqual(['entrada', 'consumo']);
    expect(res.results.map((r) => Number(r.cantidad))).toEqual([8, 3]);
  });
});

describe('exportación CSV', () => {
  test('usa punto y coma, BOM y escapa comillas y separadores', () => {
    const csv = construirCsv(['Centro', 'Notas'], [['Planta Norte', 'Mopa; "roja"'], ['Sur', null]]);
    const lineas = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(lineas[0]).toBe('Centro;Notas');
    expect(lineas[1]).toBe('Planta Norte;"Mopa; ""roja"""');
    expect(lineas[2]).toBe('Sur;');
  });
});
