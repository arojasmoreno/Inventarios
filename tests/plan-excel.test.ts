import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { CABECERAS_PLANTILLA, leerPlanExcel } from "../src/web/plan-excel";

const CENTROS = [
  { id: 1, nombre: "Mondelez Granollers" },
  { id: 2, nombre: "Mondelez Montornes" },
  { id: 3, nombre: "Fnac Barcelona" },
];

/** Construye un libro de Excel en memoria a partir de una matriz de celdas. */
function libro(filas: unknown[][]): File {
  const hoja = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(hoja, XLSX.utils.aoa_to_sheet(filas), "Plan de higiene");
  const datos = XLSX.write(hoja, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([datos], "plan.xlsx");
}

const filaNueva = [
  "Mondelez", "Granollers", 1, "Limpieza general", "Producción", "Línea 2", "Suelo", "Zona de paso",
  "Diaria", "Diaria (todos los días)", 15, 1, 1.75, "Día", "Sí", "01/11/2026", "31/10/2026", "01/11/2026",
];

describe("plantilla del plan de higiene", () => {
  test("lleva las columnas del Excel de planta, con SUBZONA propia", () => {
    expect(CABECERAS_PLANTILLA).toEqual([
      "CLIENTE", "CENTRO", "ORDEN", "TIPO", "ZONA", "SUBZONA", "ELEMENTO", "TIPO_ZONA",
      "FRECUENCIA_CALCULO", "FRECUENCIA_INFORMATIVA", "TIEMPO", "FACTOR", "HORAS_SEM",
      "TURNO", "AUDITABLE", "FECHA_INICIO", "FECHA_ULTIMA", "PROXIMA_FECHA",
    ]);
  });

  test("importa las columnas nuevas de punta a punta", async () => {
    const r = await leerPlanExcel(libro([CABECERAS_PLANTILLA, filaNueva]), CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas.length).toBe(1);
    const t = r.filas[0];
    expect(t).toMatchObject({
      centro_id: 1, cliente: "Mondelez", orden: 1,
      tipo_limpieza: "Limpieza general", zona: "Producción", subzona: "Línea 2",
      elemento: "Suelo", tipo_zona: "Zona de paso",
      frecuencia_calculo: "Diaria", frecuencia_informativa: "Diaria (todos los días)",
      tiempo: 15, factor: 1, horas_semana: 1.75, turno: "dia", auditable: 1,
      fecha_inicio: "2026-11-01", ultima_realizacion: "2026-10-31", proxima_fecha: "2026-11-01",
    });
  });

  test("localiza el centro con CLIENTE + CENTRO aunque el archivo venga sin tildes o en mayúsculas", async () => {
    const fila = [...filaNueva];
    fila[0] = "MONDELEZ";
    fila[1] = "montornes";
    const r = await leerPlanExcel(libro([CABECERAS_PLANTILLA, fila]), CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas[0].centro_id).toBe(2);
  });

  test("acepta el CENTRO tal cual cuando ya es el nombre del centro de la app", async () => {
    const fila = [...filaNueva];
    fila[0] = "";
    fila[1] = "Fnac Barcelona";
    const r = await leerPlanExcel(libro([CABECERAS_PLANTILLA, fila]), CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas[0].centro_id).toBe(3);
  });

  test("avisa si CLIENTE + CENTRO no existen en la app", async () => {
    const fila = [...filaNueva];
    fila[0] = "Cliente Inventado";
    fila[1] = "Sede Fantasma";
    const r = await leerPlanExcel(libro([CABECERAS_PLANTILLA, fila]), CENTROS);
    expect(r.filas.length).toBe(0);
    expect(r.errores[0].mensaje).toContain("No se encuentra el centro");
    expect(r.errores[0].mensaje).toContain("Cliente Inventado");
  });

  test("respeta la columna ORDEN al importar", async () => {
    const a = [...filaNueva, ];
    a[2] = 3; a[4] = "Almacén";
    const b = [...filaNueva];
    b[2] = 1; b[4] = "Producción";
    const r = await leerPlanExcel(libro([CABECERAS_PLANTILLA, a, b]), CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas.map((f) => f.zona)).toEqual(["Producción", "Almacén"]);
  });

  test("sigue aceptando el formato antiguo (cliente = centro, centro = zona, zona = subzona)", async () => {
    const cabeceraVieja = [
      "cliente", "tipo de limpieza", "centro", "zona", "tipo de zona", "elemento",
      "frecuencia_calculo", "frecuencia_informativa", "tiempo", "factor", "horas semana",
      "turno", "auditable", "fecha inicio", "fecha última realización", "fecha proxima_fecha",
    ];
    const filaVieja = [
      "Mondelez Granollers", "Limpieza general", "Producción", "Línea 2", "Zona de paso", "Suelo",
      "Diaria", "Diaria", 15, 1, 1.75, "Día", "Sí", "01/11/2026", "31/10/2026", "01/11/2026",
    ];
    const r = await leerPlanExcel(libro([cabeceraVieja, filaVieja]), CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas[0]).toMatchObject({ centro_id: 1, zona: "Producción", subzona: "Línea 2" });
  });

  test("lee un CSV de Excel en Windows-1252 con acentos y ñ", async () => {
    const texto = [
      CABECERAS_PLANTILLA.join(";"),
      ["Mondelez", "Granollers", "1", "Limpieza general", "Producción", "Línea 2", "Lejía", "Zona de paso",
        "Diaria", "Diaria", "15", "1", "1,75", "Día", "Sí", "01/11/2026", "31/10/2026", "01/11/2026"].join(";"),
    ].join("\r\n");
    const archivo = new File([Buffer.from(texto, "latin1")], "plan.csv");
    const r = await leerPlanExcel(archivo, CENTROS);
    expect(r.errores).toEqual([]);
    expect(r.filas[0]).toMatchObject({ centro_id: 1, elemento: "Lejía", zona: "Producción", subzona: "Línea 2" });
  });
});
