import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, reportarError } from "./api";
import { downloadCsv, formatNum, Toast } from "./ui";
import { leerTextoArchivo, mapearColumnas, normalizarClave } from "./csv";

type Row = Record<string, unknown>;

// Filas por archivo y por petición: la API admite 500 por envío, así que el
// resto se manda por lotes (un catálogo de productos pasa de 14.000 filas).
// El lote va por debajo de 500 porque el Worker valida cada fila con una
// consulta y D1 limita las consultas por invocación.
const MAX_ROWS = 50000;
const LOTE = 200;

type Catalogo = "centros" | "proveedores" | "zonas" | "subzonas" | "usuarios" | "documento_tipos" | "maquinaria";

interface Recurso {
  key: string;
  endpoint: string;
  label: string;
  grupo: string;
  columns: string[];
  obligatorios: string[];
  ejemplo: string[];
  needs?: Catalogo[];
  // Nombres alternativos de cada columna en los archivos de proveedor
  // («Codigo proveedor», «Codigo producto»…): sirven para el mapeo automático.
  alias?: Record<string, string[]>;
}

// Todas las tablas que se pueden rellenar por CSV desde Gestión de informes →
// Importar CSV, con su plantilla y su fila de ejemplo.
export const RECURSOS: Recurso[] = [
  {
    key: "centros", endpoint: "/api/centros", label: "Centros", grupo: "Centros y zonas",
    columns: ["nombre", "direccion", "ciudad", "responsable", "telefono"],
    obligatorios: ["nombre"], ejemplo: ["Planta Este", "Calle Mayor 1", "Valencia", "Marta Ruiz", "960 000 333"],
  },
  {
    key: "zonas", endpoint: "/api/zonas", label: "Zonas", grupo: "Centros y zonas",
    columns: ["centro", "nombre", "notas"], obligatorios: ["centro", "nombre"],
    ejemplo: ["Planta Norte", "Lavado", ""], needs: ["centros"],
  },
  {
    key: "subzonas", endpoint: "/api/subzonas", label: "Subzonas", grupo: "Centros y zonas",
    columns: ["centro", "zona", "nombre", "notas"], obligatorios: ["zona", "nombre"],
    ejemplo: ["Planta Norte", "Lavado", "Paletización", ""], needs: ["centros", "zonas"],
  },
  {
    key: "proveedores", endpoint: "/api/proveedores", label: "Proveedores", grupo: "Proveedores y compras",
    columns: ["id_proveedor", "nombre", "contacto", "email", "telefono", "direccion", "notas", "activo"],
    obligatorios: ["id_proveedor", "nombre"],
    ejemplo: ["PROV-001", "Suministros García", "Ana López", "ana@suministros.test", "910 111 222", "Calle Industria 4", "", "1"],
    alias: {
      id_proveedor: ["codigo proveedor", "codigo de proveedor", "cod proveedor", "id proveedor", "codigo", "proveedor"],
      nombre: ["nombre proveedor", "nombre del proveedor", "proveedor", "razon social"],
    },
  },
  {
    key: "productos_disponibles", endpoint: "/api/productos-disponibles", label: "Productos disponibles", grupo: "Proveedores y compras",
    columns: ["proveedor", "proveedor_alternativo", "codigo", "producto", "precio"], obligatorios: ["proveedor", "codigo", "producto"],
    ejemplo: ["PROV-001", "PROV-002", "M-001", "Mopa de microfibra", "4,50"], needs: ["proveedores"],
    alias: {
      proveedor: ["codigo proveedor", "codigo de proveedor", "cod proveedor", "nombre proveedor", "nombre del proveedor", "id proveedor", "proveedor"],
      codigo: ["codigo producto", "codigo de producto", "cod producto", "codigo articulo", "referencia", "ref", "codigo"],
      producto: ["nombre producto", "nombre del producto", "descripcion", "denominacion", "articulo", "producto"],
      precio: ["precio unitario", "precio de compra", "precio sin iva", "coste", "pvp", "importe", "precio"],
    },
  },
  {
    key: "pedidos", endpoint: "/api/pedidos", label: "Pedidos (cabecera + líneas)", grupo: "Proveedores y compras",
    columns: ["pedido", "centro", "proveedor", "codigo", "producto", "cantidad", "precio", "origen", "notas"],
    obligatorios: ["pedido", "centro", "proveedor", "codigo", "producto", "cantidad"],
    ejemplo: ["PED-001", "Planta Norte", "PROV-001", "M-001", "Mopa de microfibra", "10", "4,50", "empresa", "Reposición mensual"],
    needs: ["centros", "proveedores"],
  },
  {
    key: "trabajos", endpoint: "/api/trabajos", label: "Trabajos", grupo: "Trabajos",
    columns: ["centro", "zona", "subzona", "titulo", "descripcion", "tipo", "prioridad", "estado", "operario", "fecha_prevista", "horas", "material", "notas"],
    obligatorios: ["centro", "titulo"],
    ejemplo: ["Planta Norte", "Lavado", "Paletización", "Limpieza de la zona de carga", "Incluye paredes y suelo", "limpieza", "alta", "abierto", "operario", "2026-12-01", "2,5", "2 garrafas de desengrasante", ""],
    needs: ["centros", "zonas", "subzonas", "usuarios"],
  },
  {
    key: "quimicos", endpoint: "/api/quimicos", label: "Productos químicos", grupo: "Consumibles",
    columns: ["codigo", "marca", "nombre", "numero_lote", "litros_por_garrafa", "num_garrafas", "fecha_produccion", "fecha_caducidad", "stock_minimo", "origen", "centro", "notas"],
    obligatorios: ["codigo", "nombre", "numero_lote"],
    ejemplo: ["Q-001", "Proquima", "Desengrasante alcalino", "L-2026-001", "5", "12", "2026-01-01", "2027-06-30", "3", "fabrica", "Planta Norte", ""],
    needs: ["centros"],
  },
  {
    key: "material_limpieza", endpoint: "/api/material-limpieza", label: "Material de limpieza", grupo: "Consumibles",
    columns: ["codigo", "marca", "nombre", "color", "cantidad", "stock_minimo", "origen", "centro", "notas"],
    obligatorios: ["codigo", "nombre", "color"],
    ejemplo: ["M-001", "3M", "Mopa de microfibra", "Rojo", "40", "5", "fabrica", "Planta Norte", ""],
    needs: ["centros"],
  },
  {
    key: "maquinaria", endpoint: "/api/maquinaria", label: "Maquinaria", grupo: "Maquinaria",
    columns: ["nombre", "tipo", "marca", "modelo", "numero_serie", "centro", "zona", "subzona", "notas"],
    obligatorios: ["nombre", "tipo", "zona"],
    ejemplo: ["Fregadora Aquamatic", "Fregadora", "Nilfisk", "BA-500", "F80-0012", "Planta Norte", "Lavado", "Paletización", ""],
    needs: ["centros", "zonas", "subzonas"],
  },
  {
    key: "tipos_maquinaria", endpoint: "/api/tipos-maquinaria", label: "Tipos de maquinaria", grupo: "Maquinaria",
    columns: ["nombre", "notas"], obligatorios: ["nombre"], ejemplo: ["Fregadora", ""],
  },
  {
    key: "situaciones", endpoint: "/api/situaciones", label: "Situaciones de maquinaria", grupo: "Maquinaria",
    columns: ["nombre"], obligatorios: ["nombre"], ejemplo: ["Operativo"],
  },
  {
    key: "maquinaria_checklist", endpoint: "/api/maquinaria-usos", label: "Cuestionario de máquinas", grupo: "Maquinaria",
    columns: ["maquina", "texto", "tipo", "orden"], obligatorios: ["maquina", "texto"],
    ejemplo: ["Fregadora Aquamatic", "Batería o combustible suficiente", "booleano", "1"],
    needs: ["maquinaria"],
  },
  {
    key: "ropa_trabajo", endpoint: "/api/ropa-trabajo", label: "Ropa de trabajo", grupo: "Equipación",
    columns: ["codigo", "prenda", "marca", "fabricante", "modelo", "talla", "alta_visibilidad", "manga_larga", "descripcion", "color", "stock", "stock_minimo", "centro"],
    obligatorios: ["codigo", "prenda"],
    ejemplo: ["RT-010", "Chaqueta alta visibilidad", "Lindström", "Lindström", "HV-300", "L", "1", "1", "Clase 2", "Amarillo", "30", "5", "Planta Norte"],
    needs: ["centros"],
  },
  {
    key: "epis", endpoint: "/api/epis", label: "EPIs", grupo: "Equipación",
    columns: ["codigo", "marca", "modelo", "talla", "descripcion", "color", "stock", "stock_minimo", "fecha_revision", "centro"],
    obligatorios: ["codigo"],
    ejemplo: ["EPI-010", "Delta Plus", "Ventec Pro", "L", "Guantes anticorte", "Azul", "40", "10", "2027-01-31", "Planta Norte"],
    needs: ["centros"],
  },
  {
    key: "tallas_operarios", endpoint: "/api/tallas", label: "Tallas de operarios", grupo: "Equipación",
    columns: ["operario", "prenda", "talla", "notas"], obligatorios: ["operario", "prenda", "talla"],
    ejemplo: ["operario", "Chaqueta", "L", "Prefiere talla M"], needs: ["usuarios"],
  },
  {
    key: "tipos_equipo", endpoint: "/api/tipos-equipo", label: "Tipos de equipo", grupo: "Equipación",
    columns: ["nombre"], obligatorios: ["nombre"], ejemplo: ["Abrigo"],
  },
  {
    key: "formaciones", endpoint: "/api/catalogo-formaciones", label: "Formaciones y carnets", grupo: "Formación y documentos",
    columns: ["nombre", "tipo", "meses_validez", "notas"], obligatorios: ["nombre"],
    ejemplo: ["Carretilla elevadora", "carnet", "36", ""],
  },
  {
    key: "documento_tipos", endpoint: "/api/documentos-tipos", label: "Tipos de documento", grupo: "Formación y documentos",
    columns: ["nombre"], obligatorios: ["nombre"], ejemplo: ["Ficha de seguridad"],
  },
  {
    key: "soportes", endpoint: "/api/soportes", label: "Soportes de estación", grupo: "Estaciones",
    columns: ["nombre"], obligatorios: ["nombre"], ejemplo: ["Pared"],
  },
  {
    key: "consumibles_tipos", endpoint: "/api/consumibles-tipos", label: "Tipos de consumible", grupo: "Estaciones",
    columns: ["nombre", "articulo_tipo"], obligatorios: ["nombre", "articulo_tipo"],
    ejemplo: ["Químicos", "quimicos"],
  },
];

const GRUPOS = [...new Set(RECURSOS.map((r) => r.grupo))];

export interface Catalogos { centros: Row[]; proveedores: Row[]; zonas: Row[]; subzonas: Row[]; usuarios: Row[]; documento_tipos: Row[]; maquinaria: Row[]; }

// El cuestionario de cada máquina: la primera fila de una máquina sustituye su
// cuestionario anterior y el resto añade preguntas.
// Cotejo de textos: sin acentos, sin ñ, sin puntuación y sin mayúsculas, para
// que «García, S.L.» y «GARCIA SL» sean el mismo proveedor.
const norm = (v: string): string => normalizarClave(v);

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ""; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === "\"" && line[i + 1] === "\"") { cur += "\""; i++; }
      else if (ch === "\"") inQ = false;
      else cur += ch;
    } else if (ch === "," || ch === ";" || ch === "\t") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Números con formato español o inglés: «4,50», «3.75», «1.234,56» y
// «1,234.56» dan lo mismo. Un punto solo se toma como decimal salvo que sea
// separador de miles («1.234»).
function toNumber(v: string | undefined): number | null {
  if (v === undefined) return null;
  let t = String(v).trim().replace(/[€$\s]/g, "");
  if (!t) return null;
  if (t.includes(",") && t.includes(".")) {
    t = t.lastIndexOf(",") > t.lastIndexOf(".") ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (t.includes(",")) {
    t = t.replace(",", ".");
  } else if (/^\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, "");
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function toBool(v: string | undefined): number {
  const s = (v ?? "").toLowerCase().trim();
  return ["1", "true", "si", "sí", "s", "x", "verdadero"].includes(s) ? 1 : 0;
}

/** Resuelve un identificador por id, código o nombre (insensible a mayúsculas). */
// Índice de un catálogo por sus claves normalizadas. Se construye una vez por
// catálogo: con 14.000 filas y 300 proveedores, normalizar el catálogo entero
// en cada fila bloqueaba el navegador varios segundos.
const indices = new WeakMap<Row[], Map<string, Map<string, Row>>>();
function indiceDe(filas: Row[], claves: string[]): Map<string, Row> {
  let porClaves = indices.get(filas);
  if (!porClaves) { porClaves = new Map(); indices.set(filas, porClaves); }
  const firma = claves.join("|");
  let indice = porClaves.get(firma);
  if (!indice) {
    indice = new Map();
    for (const f of filas) {
      for (const k of claves) {
        const v = norm(String(f[k] ?? ""));
        if (v && !indice.has(v)) indice.set(v, f);
      }
    }
    porClaves.set(firma, indice);
  }
  return indice;
}
function resolver(valor: string, filas: Row[], claves: string[]): Row | undefined {
  return indiceDe(filas, claves).get(norm(valor));
}
const fallo = (fila: number, msg: string): string => `Fila ${fila}: ${msg}`;

/** Máquina por id, nº de serie o nombre. Si el nombre está repetido devuelve
 *  «ambigua» en vez de elegir una al azar: el cuestionario no puede acabar en
 *  la máquina equivocada. */
function maquinaPor(valor: string, maquinas: Row[]): Row | "ambigua" | undefined {
  const v = norm(valor);
  const porId = maquinas.filter((m) => String(m.id) === valor.trim());
  if (porId.length === 1) return porId[0];
  const porSerie = maquinas.filter((m) => norm(String(m.numero_serie ?? "")) === v);
  if (porSerie.length === 1) return porSerie[0];
  const porNombre = maquinas.filter((m) => norm(String(m.nombre ?? "")) === v);
  if (porNombre.length === 1) return porNombre[0];
  return porNombre.length > 1 ? "ambigua" : undefined;
}

/** Traduce una fila del CSV al JSON que espera la API (resolviendo centros,
 *  proveedores, operarios, prendas y zonas por su nombre o su ID). */
export function parseRow(key: string, raw: Record<string, string>, fila: number, cat: Catalogos): Record<string, unknown> | string {
  const g = (k: string): string | undefined => { const v = raw[k]?.trim(); return v === "" ? undefined : v; };
  const id = (k: string): number | null => toNumber(g(k));
  const centro = (): number | null => {
    const c = g("centro") ?? g("centro_id"); if (c === undefined) return null;
    const found = resolver(c, cat.centros, ["nombre", "id"]);
    return found ? Number(found.id) : -1;
  };
  const operario = (): number | null => {
    const o = g("operario") ?? g("operario_id"); if (o === undefined) return null;
    const found = resolver(o, cat.usuarios, ["username", "nombre", "id"]);
    return found ? Number(found.id) : -1;
  };
  switch (key) {
    case "centros": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      return { nombre, direccion: g("direccion") ?? null, ciudad: g("ciudad") ?? null, responsable: g("responsable") ?? null, telefono: g("telefono") ?? null };
    }
    case "zonas": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const centroId = centro();
      if (centroId === null) return fallo(fila, "falta la columna 'centro'");
      if (centroId === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return { centro_id: centroId, nombre, notas: g("notas") ?? null };
    }
    case "subzonas": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const zn = g("zona"); if (!zn) return fallo(fila, "falta la columna 'zona'");
      const centroId = centro();
      if (centroId === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      const zonas = centroId && centroId > 0 ? cat.zonas.filter((z) => Number(z.centro_id) === centroId) : cat.zonas;
      const z = resolver(zn, zonas, ["nombre", "id"]);
      if (!z) return fallo(fila, `la zona «${zn}» no existe${centroId ? " en ese centro" : ""}`);
      return { zona_id: Number(z.id), nombre, notas: g("notas") ?? null };
    }
    case "proveedores": {
      const idp = g("id_proveedor") ?? g("codigo") ?? g("id");
      const nombre = g("nombre");
      if (!idp) return fallo(fila, "falta la columna 'id_proveedor'");
      if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const activo = g("activo") === undefined ? 1 : toBool(g("activo"));
      return { id_proveedor: idp, nombre, contacto: g("contacto") ?? null, email: g("email") ?? null, telefono: g("telefono") ?? null, direccion: g("direccion") ?? null, notas: g("notas") ?? null, activo };
    }
    case "productos_disponibles": {
      const pv = g("proveedor") ?? g("id_proveedor") ?? g("proveedor_codigo");
      const codigo = g("codigo"); const producto = g("producto");
      if (!pv) return fallo(fila, "falta la columna 'proveedor'");
      if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      if (!producto) return fallo(fila, "falta la columna 'producto'");
      const found = resolver(pv, cat.proveedores, ["id_proveedor", "codigo", "nombre", "id"]);
      if (!found) return fallo(fila, `el proveedor «${pv}» no existe (revisa el nombre o pon su código de proveedor)`);
      const alt = g("proveedor_alternativo");
      let alternativoId: number | null = null;
      if (alt) {
        const altProv = resolver(alt, cat.proveedores, ["id_proveedor", "codigo", "nombre", "id"]);
        if (!altProv) return fallo(fila, `el proveedor alternativo «${alt}» no existe (revisa el nombre o pon su código)`);
        if (Number(altProv.id) === Number(found.id)) return fallo(fila, "el proveedor alternativo debe ser distinto del principal");
        alternativoId = Number(altProv.id);
      }
      return { proveedor_id: Number(found.id), proveedor_alternativo_id: alternativoId, codigo, producto, precio: id("precio") };
    }
    case "pedidos": {
      const ref = g("pedido");
      if (!ref) return fallo(fila, "falta la columna 'pedido'");
      const centroId = centro();
      if (centroId === null) return fallo(fila, "falta la columna 'centro'");
      if (centroId === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      const pv = g("proveedor") ?? g("id_proveedor") ?? g("proveedor_codigo");
      if (!pv) return fallo(fila, "falta la columna 'proveedor'");
      const prov = resolver(pv, cat.proveedores, ["id_proveedor", "codigo", "nombre", "id"]);
      if (!prov) return fallo(fila, `el proveedor «${pv}» no existe`);
      const codigo = g("codigo"); if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      const producto = g("producto"); if (!producto) return fallo(fila, "falta la columna 'producto'");
      const cantidad = id("cantidad");
      if (!cantidad || cantidad < 1) return fallo(fila, "la cantidad debe ser mayor que 0");
      const org = (g("origen") ?? "empresa").toLowerCase();
      return {
        pedido: ref, centro_id: centroId, proveedor_id: Number(prov.id), codigo, producto, cantidad,
        precio: id("precio"), origen: org.startsWith("fab") ? "fabrica" : "empresa",
        notas: g("notas") ?? null,
      };
    }
    case "trabajos": {
      const titulo = g("titulo"); if (!titulo) return fallo(fila, "falta la columna 'titulo'");
      const centroId = centro();
      if (centroId === null) return fallo(fila, "falta la columna 'centro'");
      if (centroId === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      let zonaId: number | null = null;
      let subzonaId: number | null = null;
      const zn = g("zona");
      if (zn) {
        const z = resolver(zn, cat.zonas.filter((x) => Number(x.centro_id) === centroId), ["nombre", "id"]);
        if (!z) return fallo(fila, `la zona «${zn}» no existe en ese centro`);
        zonaId = Number(z.id);
        const sn = g("subzona");
        if (sn) {
          const s = resolver(sn, cat.subzonas.filter((x) => Number(x.zona_id) === zonaId), ["nombre", "id"]);
          if (!s) return fallo(fila, `la subzona «${sn}» no existe en esa zona`);
          subzonaId = Number(s.id);
        }
      }
      const operarioId = operario();
      if (operarioId === -1) return fallo(fila, `el operario «${g("operario")}» no existe`);
      const t = norm(g("tipo") ?? "limpieza");
      const tipo = t.startsWith("mant") ? "mantenimiento" : t.startsWith("incid") ? "incidencia" : t.startsWith("limpi") ? "limpieza" : "otro";
      const p = norm(g("prioridad") ?? "normal");
      const prioridad = ["baja", "normal", "alta", "urgente"].includes(p) ? p : "normal";
      const e = norm(g("estado") ?? "abierto").replace(/ /g, "_");
      const estado = ["abierto", "en_curso", "pausado", "cerrado"].includes(e) ? e : "abierto";
      return {
        centro_id: centroId, zona_id: zonaId, subzona_id: subzonaId, titulo,
        descripcion: g("descripcion") ?? null, tipo, prioridad, estado,
        operario_id: operarioId, fecha_prevista: g("fecha_prevista") ?? null,
        horas: id("horas"), material: g("material") ?? null, notas: g("notas") ?? null,
      };
    }
    case "quimicos": case "material_limpieza": {
      const codigo = g("codigo") ?? g("id"); const nombre = g("nombre");
      if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const out: Record<string, unknown> = { codigo, nombre };
      if (key === "quimicos") {
        if (!g("numero_lote")) return fallo(fila, "falta la columna 'numero_lote'");
        out.numero_lote = g("numero_lote");
        out.fecha_produccion = g("fecha_produccion") ?? null;
        out.fecha_caducidad = g("fecha_caducidad") ?? null;
        out.litros_por_garrafa = id("litros_por_garrafa") ?? 0;
        out.num_garrafas = id("num_garrafas") ?? 0;
        out.estado = (g("estado") ?? "activo").trim().toLowerCase();
      } else {
        if (!g("color")) return fallo(fila, "falta la columna 'color'");
        out.color = g("color");
        out.cantidad = id("cantidad") ?? 0;
      }
      out.marca = g("marca") ?? null;
      out.stock_minimo = id("stock_minimo") ?? 0;
      const org = (g("origen") ?? "").toLowerCase();
      out.origen = org.startsWith("emp") ? "empresa" : org.startsWith("fab") ? "fabrica" : null;
      out.centro_id = centro();
      out.notas = g("notas") ?? null;
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return out;
    }
    case "maquinaria": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      if (!g("tipo")) return fallo(fila, "falta la columna 'tipo'");
      const out: Record<string, unknown> = { nombre, tipo: g("tipo") };
      out.marca = g("marca") ?? null; out.modelo = g("modelo") ?? null;
      out.numero_serie = g("numero_serie") ?? null;
      out.centro_id = centro(); out.notas = g("notas") ?? null;
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      const zn = g("zona");
      if (!zn) return fallo(fila, "falta la columna 'zona'");
      const zonas = cat.zonas.filter((z) => out.centro_id == null || Number(z.centro_id) === Number(out.centro_id));
      const z = resolver(zn, zonas, ["nombre", "id"]);
      if (!z) return fallo(fila, `la zona «${zn}» no existe en ese centro`);
      out.zona_id = Number(z.id);
      const sn = g("subzona");
      if (sn) {
        const s = resolver(sn, cat.subzonas.filter((x) => Number(x.zona_id) === Number(z.id)), ["nombre", "id"]);
        if (!s) return fallo(fila, `la subzona «${sn}» no existe en esa zona`);
        out.subzona_id = Number(s.id);
      } else out.subzona_id = null;
      return out;
    }
    case "ropa_trabajo": case "epis": {
      const codigo = g("codigo") ?? g("id"); if (!codigo) return fallo(fila, "falta la columna 'codigo'");
      const out: Record<string, unknown> = { codigo, stock: id("stock") ?? 0 };
      if (key === "ropa_trabajo") {
        const prenda = g("prenda"); if (!prenda) return fallo(fila, "falta la columna 'prenda'");
        out.prenda = prenda;
        out.alta_visibilidad = toBool(g("alta_visibilidad"));
        out.manga_larga = toBool(g("manga_larga"));
        out.descripcion = g("descripcion") ?? null;
        out.fabricante = g("fabricante") ?? null;
        out.notas = g("notas") ?? null;
      } else {
        out.descripcion = g("descripcion") ?? null;
        out.fecha_revision = g("fecha_revision") ?? null;
      }
      out.marca = g("marca") ?? null; out.modelo = g("modelo") ?? null;
      out.talla = g("talla") ?? null; out.color = g("color") ?? null;
      out.stock_minimo = id("stock_minimo") ?? 0;
      out.centro_id = centro();
      if (out.centro_id === -1) return fallo(fila, `el centro «${g("centro")}» no existe`);
      return out;
    }
    case "tallas_operarios": {
      const operarioId = operario(); if (operarioId === null) return fallo(fila, "falta la columna 'operario'");
      if (operarioId === -1) return fallo(fila, `el operario «${g("operario")}» no existe`);
      const prenda = g("prenda"); if (!prenda) return fallo(fila, "falta la columna 'prenda'");
      const talla = g("talla"); if (!talla) return fallo(fila, "falta la columna 'talla'");
      return { usuario_id: operarioId, prenda, talla, notas: g("notas") ?? null };
    }
    case "formaciones": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const t = norm(g("tipo") ?? "formacion");
      const tipo = t.startsWith("rev") ? "revision" : t.startsWith("carn") ? "carnet" : t.startsWith("form") ? "formacion" : "";
      if (!tipo) return fallo(fila, "el tipo debe ser formacion, revision o carnet");
      return { nombre, tipo, meses_validez: id("meses_validez") ?? 0, notas: g("notas") ?? null, activo: g("activo") === undefined ? 1 : toBool(g("activo")) };
    }
    case "consumibles_tipos": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      const t = norm(g("articulo_tipo") ?? "material_limpieza");
      const articulo = t.startsWith("quim") ? "quimicos" : t.startsWith("maquin") ? "maquinaria" : t.startsWith("material") || t.startsWith("limpieza") ? "material_limpieza" : "";
      if (!articulo) return fallo(fila, "el tipo de artículo debe ser quimicos, material_limpieza o maquinaria");
      return { nombre, articulo_tipo: articulo };
    }
    case "maquinaria_checklist": {
      const mq = g("maquina") ?? g("maquina_id") ?? g("numero_serie");
      const texto = g("texto") ?? g("pregunta");
      if (!mq) return fallo(fila, "falta la columna 'maquina'");
      if (!texto) return fallo(fila, "falta la columna 'texto'");
      const maquina = maquinaPor(mq, cat.maquinaria);
      if (maquina === "ambigua") return fallo(fila, `hay varias máquinas llamadas «${mq}»: pon su nº de serie`);
      if (!maquina) return fallo(fila, `la máquina «${mq}» no existe`);
      const t = (g("tipo") ?? "booleano").toLowerCase();
      const orden = toNumber(g("orden"));
      return {
        maquina_id: Number(maquina.id), texto,
        tipo: t.startsWith("esc") || t.startsWith("punt") || t === "1-5" ? "escala" : "booleano",
        orden: orden ?? 0,
      };
    }
    case "tipos_maquinaria": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      return { nombre, notas: g("notas") ?? null };
    }
    case "tipos_equipo": case "situaciones": case "soportes": case "documento_tipos": {
      const nombre = g("nombre"); if (!nombre) return fallo(fila, "falta la columna 'nombre'");
      return { nombre };
    }
    default: return "recurso no soportado";
  }
}

export function ImportarPage() {
  const [recurso, setRecurso] = useState<string>(RECURSOS[0].key);
  const [cabeceras, setCabeceras] = useState<string[]>([]);
  const [lineas, setLineas] = useState<string[][]>([]);
  const [mapa, setMapa] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [erroresParse, setErroresParse] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progreso, setProgreso] = useState<{ hechos: number; total: number; lote: number; lotes: number } | null>(null);
  const [cat, setCat] = useState<Catalogos>({ centros: [], proveedores: [], zonas: [], subzonas: [], usuarios: [], documento_tipos: [], maquinaria: [] });
  const inputRef = useRef<HTMLInputElement>(null);
  const cfg = RECURSOS.find((r) => r.key === recurso) ?? RECURSOS[0];

  // Catálogos para resolver centro / proveedor / operario / zona por nombre en el CSV.
  const ensureCat = useCallback(async (): Promise<Catalogos> => {
    const need = new Set<Catalogo>(cfg.needs ?? []);
    const next: Catalogos = { ...cat };
    const cargar = async (k: Catalogo, endpoint: string): Promise<void> => {
      if (!need.has(k) || next[k].length) return;
      next[k] = (await api.get<{ items: Row[] }>(endpoint)).items;
    };
    await cargar("centros", "/api/centros");
    await cargar("proveedores", "/api/proveedores");
    await cargar("zonas", "/api/zonas");
    await cargar("subzonas", "/api/subzonas");
    await cargar("usuarios", "/api/usuarios");
    await cargar("documento_tipos", "/api/documentos-tipos");
    await cargar("maquinaria", "/api/maquinaria");
    setCat(next);
    return next;
  }, [cat, cfg.needs]);

  useEffect(() => {
    setRows([]); setErroresParse([]); setError(null); setDone(null);
    setCabeceras([]); setLineas([]); setMapa({});
    if (inputRef.current) inputRef.current.value = "";
  }, [recurso]);

  const faltan = useMemo(() => cfg.obligatorios.filter((f) => !mapa[f]), [cfg.obligatorios, mapa]);
  const mapeados = useMemo(() => cfg.columns.filter((f) => mapa[f]).length, [cfg.columns, mapa]);

  const onFile = async (f: File | null) => {
    setDone(null); setError(null); setRows([]); setErroresParse([]);
    setCabeceras([]); setLineas([]); setMapa({});
    if (!f) return;
    try {
      let heads: string[] = [];
      let cuerpo: string[][] = [];
      if (/\.(xlsx|xls)$/i.test(f.name)) {
        // Excel tal cual (sin convertirlo a CSV), que es como llegan los
        // catálogos de proveedor.
        const XLSX = await import("xlsx");
        const libro = XLSX.read(new Uint8Array(await f.arrayBuffer()), { type: "array" });
        const hoja = libro.Sheets[libro.SheetNames[0] ?? ""];
        if (!hoja) { setError("El archivo no tiene ninguna hoja con datos."); return; }
        const matriz = XLSX.utils.sheet_to_json<unknown[]>(hoja, { header: 1, raw: false, defval: "" });
        if (matriz.length < 2) { setError("El archivo necesita una fila de cabeceras y al menos un dato."); return; }
        heads = (matriz[0] ?? []).map((v) => String(v ?? "").trim());
        cuerpo = matriz.slice(1).map((fila) => (fila ?? []).map((v) => String(v ?? "")));
      } else {
        // Se respeta la codificación del archivo: Excel guarda el CSV en
        // Windows-1252 y decodificarlo como UTF-8 rompía acentos y ñ.
        const texto = await leerTextoArchivo(f);
        const todas = texto.split(/\r?\n/).filter((l) => l.trim() !== "");
        if (todas.length < 2) { setError("El archivo necesita una fila de cabeceras y al menos un dato."); return; }
        heads = splitCsvLine(todas[0]);
        cuerpo = todas.slice(1).map(splitCsvLine);
      }
      setCabeceras(heads);
      setLineas(cuerpo);
      setMapa(mapearColumnas(cfg, heads));
    } catch { setError("No se pudo leer el archivo. Si es un Excel, guárdalo como .xlsx o .csv."); }
  };

  const previsualizar = async () => {
    setError(null); setDone(null); setRows([]); setErroresParse([]);
    if (!lineas.length) { setError("Elige primero un archivo CSV."); return; }
    if (faltan.length) { setError(`Asigna una columna para: ${faltan.join(", ")}.`); return; }
    try {
      const catalogos = await ensureCat();
      const parsed: Record<string, unknown>[] = [];
      const problemas: string[] = [];
      const total = Math.min(lineas.length, MAX_ROWS);
      for (let i = 0; i < total; i++) {
        const cells = lineas[i];
        const raw: Record<string, string> = {};
        for (const campo of cfg.columns) {
          const idx = Number(mapa[campo]);
          if (mapa[campo] !== "" && Number.isInteger(idx)) raw[campo] = cells[idx] ?? "";
        }
        const out = parseRow(cfg.key, raw, i + 2, catalogos);
        if (typeof out === "string") problemas.push(out);
        else parsed.push(out);
      }
      if (lineas.length > MAX_ROWS) problemas.push(`(solo se procesan los primeros ${MAX_ROWS} registros)`);
      setRows(parsed);
      setErroresParse(problemas);
      if (!parsed.length) setError(problemas[0] ?? "No se encontraron filas válidas.");
      // Los problemas detectados quedan en el histórico de errores (como avisos)
      // para poder revisarlos después desde la pestaña «Errores».
      if (problemas.length) {
        reportarError(
          `${problemas.length} fila(s) con problemas al preparar la importación de ${cfg.label}`,
          { nivel: "aviso", origen: "importar", ruta: cfg.endpoint, detalle: problemas.slice(0, 10).join("\n") },
        );
      }
    } catch { setError("No se pudieron leer los catálogos (centros/proveedores/zonas). Inténtalo de nuevo."); }
  };

  // Plantilla con las cabeceras y una fila de ejemplo del recurso elegido.
  const descargarPlantilla = (r: Recurso) => downloadCsv(`${r.key}-plantilla.csv`, r.columns, [r.ejemplo]);

  const importar = async () => {
    if (!rows.length) return;
    setBusy(true); setError(null); setDone(null);
    let creados = 0, actualizados = 0;
    const errores: string[] = [];
    const lotes = Math.ceil(rows.length / LOTE);
    setProgreso({ hechos: 0, total: rows.length, lote: 0, lotes });
    // Un lote que falle no detiene el resto: se anota y se sigue, para que un
    // catálogo de 14.000 filas no se quede a medias por un error puntual.
    for (let n = 0; n < lotes; n++) {
      const desde = n * LOTE, hasta = Math.min(desde + LOTE, rows.length);
      try {
        const r = await api.post<{ creados?: number; actualizados?: number; errores?: string[] }>(`${cfg.endpoint}/import`, { rows: rows.slice(desde, hasta) });
        creados += Number(r.creados ?? 0);
        actualizados += Number(r.actualizados ?? 0);
        for (const e of r.errores ?? []) errores.push(e);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "error de conexión";
        errores.push(`Lote ${n + 1}/${lotes} (filas ${desde + 1}-${hasta}): ${msg}`);
      }
      setProgreso({ hechos: hasta, total: rows.length, lote: n + 1, lotes });
    }
    setProgreso(null);
    const partes = [`${formatNum(creados)} creados`, `${formatNum(actualizados)} actualizados`];
    const aviso = errores.length ? ` · ${formatNum(errores.length)} con error` : "";
    setDone(`Importados: ${partes.join(" · ")}${aviso}`);
    if (errores.length) {
      setError(errores.slice(0, 4).join(" · "));
      reportarError(
        `${errores.length} fila(s) o lote(s) no se pudieron importar en ${cfg.label}`,
        { nivel: "aviso", origen: "importar", ruta: cfg.endpoint, detalle: errores.slice(0, 10).join("\n") },
      );
    }
    setRows([]); setErroresParse([]); if (inputRef.current) inputRef.current.value = "";
    setBusy(false);
  };

  return <div className="card card-pad" style={{ maxWidth: 900 }}>
    <div className="section-head"><h3>Importar CSV</h3></div>
    <p style={{ color: "var(--muted)", marginTop: 0 }}>
      Sube el archivo y comprueba el <strong>mapeo de columnas</strong>: cada columna del CSV se asigna a un campo de{" "}
      <strong>{cfg.label}</strong>. Solo los campos obligatorios son necesarios. En las tablas con código o ID
      (productos, proveedores, químicos, ropa, EPIs…) ese valor es la clave: si el registro ya existe se actualiza y
      si no se crea. Acepta <strong>.csv y Excel (.xlsx/.xls)</strong>, separador coma, punto y coma o tabulador y hasta{" "}
      <strong>50.000 filas</strong>. Los CSV de Excel (Windows-1252) se leen bien: <strong>acentos y ñ</strong> se
      conservan, y al buscar un proveedor, centro o zona no importan tildes, mayúsculas ni puntuación. Las cabeceras
      habituales de proveedor (<code>Codigo proveedor</code>, <code>Nombre proveedor</code>, <code>Codigo producto</code>,
      <code>Producto</code>, <code>Precio</code>) se reconocen solas. En <strong>Proveedores</strong> el{" "}
      <code>id_proveedor</code> lo pones tú: no es autonumérico.
    </p>
    <div className="form-grid" style={{ marginBottom: 12 }}>
      <div><div className="field"><label htmlFor="imp-rec">Tabla / recurso</label>
        <select id="imp-rec" className="input" value={recurso} onChange={(e) => setRecurso(e.target.value)}>
          {GRUPOS.map((g) => <optgroup key={g} label={g}>
            {RECURSOS.filter((r) => r.grupo === g).map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </optgroup>)}
        </select></div></div>
      <div><div className="field"><label htmlFor="imp-file">Archivo CSV</label>
        <input id="imp-file" ref={inputRef} className="input" type="file"
          accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => void onFile(e.target.files?.[0] ?? null)} /></div></div>
    </div>

    {cabeceras.length > 0 && <div style={{ marginBottom: 12 }}>
      <div className="section-head" style={{ marginBottom: 6 }}>
        <h3 style={{ fontSize: 14 }}>Mapeo de columnas</h3>
        <span className="badge muted">{formatNum(mapeados)} de {formatNum(cfg.columns.length)} campos asignados</span>
      </div>
      <div className="table-scroll"><table>
        <thead><tr><th>Campo</th><th>Columna del CSV</th><th /></tr></thead>
        <tbody>{cfg.columns.map((campo) => {
          const obligatorio = cfg.obligatorios.includes(campo);
          const sinAsignar = obligatorio && !mapa[campo];
          return <tr key={campo}>
            <td><code>{campo}</code>{obligatorio && <span className="badge warn" style={{ marginLeft: 6 }}>obligatorio</span>}</td>
            <td><select className={"input" + (sinAsignar ? " error" : "")} aria-label={`Columna para ${campo}`} value={mapa[campo] ?? ""}
              onChange={(e) => setMapa((prev) => ({ ...prev, [campo]: e.target.value }))}>
              <option value="">— Sin asignar —</option>
              {cabeceras.map((h, i) => <option key={`${h}-${i}`} value={String(i)}>{h || `Columna ${i + 1}`}</option>)}
            </select></td>
            <td>{mapa[campo] ? <span className="badge ok">{cabeceras[Number(mapa[campo])]}</span> : <span className="badge muted">—</span>}</td>
          </tr>;
        })}</tbody></table></div>
    </div>}

    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
    {done && <div className="banner" style={{ marginBottom: 12, background: "#dcfce7", color: "#166534" }}>{done}</div>}

    {rows.length > 0 && <div className="banner" style={{ marginBottom: 12, background: "#dbeafe", color: "#1e40af" }}>
      ✅ <strong>{formatNum(rows.length)}</strong> filas válidas listas para importar en {cfg.label}.
      {erroresParse.length > 0 && <> ⚠️ {formatNum(erroresParse.length)} fila{erroresParse.length === 1 ? "" : "s"} con problemas no se importará{erroresParse.length === 1 ? "" : "n"}.</>}
    </div>}
    {erroresParse.length > 0 && <div className="form-error" style={{ marginBottom: 12 }}>
      {erroresParse.slice(0, 8).join(" · ")}{erroresParse.length > 8 ? ` · …y ${erroresParse.length - 8} más` : ""}
    </div>}

    <div className="modal-footer" style={{ justifyContent: "space-between" }}>
      <div className="chips" style={{ margin: 0 }}>
        <button className="btn secondary" onClick={() => descargarPlantilla(cfg)}>⬇️ Descargar plantilla</button>
        <button className="btn secondary" onClick={() => void previsualizar()} disabled={!lineas.length || faltan.length > 0}>🔍 Previsualizar</button>
      </div>
      <button className="btn" onClick={() => void importar()} disabled={busy || !rows.length}>{busy
        ? progreso ? `Importando ${formatNum(progreso.hechos)}/${formatNum(progreso.total)}…` : "Importando…"
        : `Importar ${rows.length ? formatNum(rows.length) : ""}`.trim()}</button>
    </div>

    {rows.length > 0 && <div className="table-scroll" style={{ marginTop: 12 }}>
      <table><thead><tr><th>#</th><th>Vista previa</th></tr></thead>
        <tbody>{rows.slice(0, 5).map((r, i) => <tr key={i}><td>{i + 1}</td><td style={{ fontSize: 12, fontFamily: "monospace" }}>{JSON.stringify(r).slice(0, 180)}</td></tr>)}</tbody></table>
    </div>}
    {rows.length > 5 && <p style={{ color: "var(--muted)", fontSize: 12 }}>…y {formatNum(rows.length - 5)} filas más.</p>}

    <details style={{ marginTop: 16, borderTop: "1px solid var(--border, #e5e7eb)", paddingTop: 12 }}>
      <summary style={{ cursor: "pointer", fontWeight: 600 }}>📄 Plantillas CSV de todas las tablas ({formatNum(RECURSOS.length)})</summary>
      <p style={{ color: "var(--muted)", fontSize: 13 }}>
        Descarga la plantilla de cualquier tabla, rellénala con tus datos y súbela aquí mismo. Cada plantilla incluye
        las cabeceras y una fila de ejemplo.
      </p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {RECURSOS.map((r) => <button key={r.key} className="btn secondary small" title={`Plantilla de ${r.label}`} onClick={() => descargarPlantilla(r)}>⬇️ {r.label}</button>)}
      </div>
    </details>
    {done && <Toast message={done} kind="ok" onClose={() => setDone(null)} />}
  </div>;
}
