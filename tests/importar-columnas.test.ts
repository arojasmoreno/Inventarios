import { describe, expect, test } from "bun:test";
import { mapearColumnas } from "../src/web/csv";

// Cabeceras del catálogo de proveedor que sube el usuario.
const CABECERAS = ["Codigo proveedor", "Nombre proveedor", "Codigo producto", "Producto", "Precio"];

const PRODUCTOS = {
  columns: ["proveedor", "proveedor_alternativo", "codigo", "producto", "precio"],
  alias: {
    proveedor: ["codigo proveedor", "codigo de proveedor", "cod proveedor", "nombre proveedor", "id proveedor", "proveedor"],
    codigo: ["codigo producto", "codigo de producto", "cod producto", "referencia", "ref", "codigo"],
    producto: ["nombre producto", "descripcion", "articulo", "producto"],
    precio: ["precio unitario", "coste", "pvp", "importe", "precio"],
  },
};

const PROVEEDORES = {
  columns: ["id_proveedor", "nombre", "contacto", "email"],
  alias: {
    id_proveedor: ["codigo proveedor", "codigo de proveedor", "cod proveedor", "id proveedor", "codigo"],
    nombre: ["nombre proveedor", "nombre del proveedor", "proveedor", "razon social"],
  },
};

describe("mapeo automático de cabeceras", () => {
  test("reconoce las columnas del catálogo de productos del proveedor", () => {
    const mapa = mapearColumnas(PRODUCTOS, CABECERAS);
    expect(mapa.proveedor).toBe("0");   // Codigo proveedor
    expect(mapa.codigo).toBe("2");      // Codigo producto
    expect(mapa.producto).toBe("3");    // Producto
    expect(mapa.precio).toBe("4");      // Precio
    expect(mapa.proveedor_alternativo).toBe("");
  });

  test("la misma cabecera sirve para el catálogo de proveedores", () => {
    const mapa = mapearColumnas(PROVEEDORES, CABECERAS);
    expect(mapa.id_proveedor).toBe("0");
    expect(mapa.nombre).toBe("1");
  });

  test("una columna del archivo no se asigna a dos campos", () => {
    const mapa = mapearColumnas(
      { columns: ["proveedor", "proveedor_alternativo"], alias: { proveedor: ["codigo proveedor"], proveedor_alternativo: ["codigo proveedor"] } },
      CABECERAS,
    );
    expect(mapa.proveedor).toBe("0");
    expect(mapa.proveedor_alternativo).toBe("");
  });
});
