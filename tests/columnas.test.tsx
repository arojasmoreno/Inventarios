import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SelectorColumnas, useColumnas, type Columna } from "../src/web/columnas";

const COLUMNAS: Columna[] = [
  { key: "zona", label: "Zona" },
  { key: "subzona", label: "Subzona" },
  { key: "elemento", label: "Elemento" },
];

function Prueba() {
  const { elegidas, visibles } = useColumnas(COLUMNAS, "prueba:columnas", ["zona", "elemento"]);
  return <span>{`${elegidas.join("|")} → ${visibles.map((c) => c.label).join("|")}`}</span>;
}

describe("selector de columnas", () => {
  test("sin nada guardado enseña las columnas por defecto, en el orden de la tabla", () => {
    expect(renderToStaticMarkup(<Prueba />)).toBe("<span>zona|elemento → Zona|Elemento</span>");
  });

  test("pinta una casilla por columna, marcadas solo las elegidas", () => {
    const html = renderToStaticMarkup(
      <SelectorColumnas
        todas={COLUMNAS}
        elegidas={["zona", "elemento"]}
        porDefecto={["zona"]}
        onChange={() => {}}
        ariaLabel="Columnas a mostrar"
        etiqueta="Columnas de tareas"
      />,
    );
    expect(html).toContain("Columnas de tareas (2/3)");
    expect(html.match(/type="checkbox"/g)?.length).toBe(3);
    expect(html.match(/checked=""/g)?.length).toBe(2);
    expect(html).toContain("Zona");
    expect(html).toContain("Subzona");
  });
});
