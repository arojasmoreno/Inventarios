import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { ColorSwatch, Field, Modal, Toast, camposConError, diasHasta, downloadCsv, formatFecha, formatNum, type FieldDef } from "./ui";
import { QrModal } from "./qr";

type Row = Record<string, unknown>;
type Permission = "all" | "admin" | "centros";
type Column = { key: string; label: string; align?: "right"; render?: (row: Row) => ReactNode; csv?: (row: Row) => string | number };
export interface ResourceConfig {
  title: string; subtitle: string; endpoint: string; csvName: string; searchKeys: string[]; centroFilter?: boolean;
  perms: { read: Permission; create: Permission; update: Permission; delete: Permission }; fields: FieldDef[]; columns: Column[];
  // Selects de otros recursos (operario, prenda…): endpoint + etiqueta por fila.
  links?: Record<string, {
    endpoint?: string; endpoints?: string[]; label: (r: Row) => string; value?: (r: Row) => string | number;
    // Select en cascada: `parent` es el campo del formulario cuyo valor (en
    // `parentField` de cada fila) filtra las opciones de este campo.
    parent?: string; parentField?: string;
  }>;
  // Muestra el botón de imprimir el QR del artículo (puesto de consumo).
  qrTipo?: string;
  // Página de solo consulta (sin altas, ediciones ni borrados).
  readOnlyPage?: boolean;
  // Selector de centros (uno o varios) dentro del formulario de alta/edición.
  formCentros?: boolean;
  // Filtro por «Tipo de equipo» en la barra de herramientas (Ropa y EPIs).
  tipoEquipoFilter?: boolean;
  // Filtro por «Origen» (Fábrica / Empresa) de los consumibles en la barra de herramientas.
  origenFilter?: boolean;
  // Acción extra por fila (p. ej. exportar los datos personales de un usuario).
  extraAction?: { icon: string; label: string; title?: string; run: (row: Row) => void | Promise<void> };
  // Fila de totales al pie de la tabla: suma de las columnas indicadas,
  // calculada sobre las filas visibles (con los filtros aplicados).
  totals?: Array<{ key: string; label: string }>;
}
const allow = (role: string, p: Permission) => p === "all" || role === "admin" || (p === "centros" && role === "admin_centros");
const center = { name: "centro_id", label: "Centro", type: "select" as const };
const notes = { name: "notas", label: "Notas", type: "textarea" as const };
const colors = ["Rojo", "Azul", "Verde", "Amarillo", "Blanco", "Negro", "Naranja", "Morado", "Gris", "Marrón", "Otro"];
// Origen del consumible: solo dos opciones (fábrica o empresa gestora).
const ORIGEN_OPTS = [{ value: "fabrica", label: "Fábrica" }, { value: "empresa", label: "Empresa" }];
const origenLabel = (v: unknown): string => { const s = String(v ?? ""); return s === "empresa" ? "Empresa" : s === "fabrica" ? "Fábrica" : "—"; };
const origenCol: Column = {
  key: "origen", label: "Origen",
  render: r => { const s = String(r.origen ?? ""); return s === "empresa" ? <span className="badge warn">🏢 Empresa</span>
    : s === "fabrica" ? <span className="badge info">🏭 Fábrica</span> : <span className="badge muted">—</span>; },
  csv: r => origenLabel(r.origen),
};
// Estado actual de una máquina: sale del último registro de su histórico.
const estadoBadge = (estado: unknown) => {
  const e = String(estado ?? "");
  const cls = e === "Operativo" ? "ok" : e === "En reparación" ? "warn" : e === "Averiado" ? "danger" : e === "Baja" ? "muted" : "info";
  return <span className={`badge ${cls}`}>{e || "—"}</span>;
};
const dateBadge = (r: Row) => { const n = diasHasta(r.fecha_caducidad), cls = n === null || n > 90 ? "" : n < 0 ? "danger" : n <= 30 ? "warn" : "info"; const text = n === null || n > 90 ? formatFecha(r.fecha_caducidad) : n < 0 ? `Vencida (${formatFecha(r.fecha_caducidad)})` : `${formatFecha(r.fecha_caducidad)} · ${n} d`; return cls ? <span className={`badge ${cls}`}>{text}</span> : text; };
const centerCol: Column = { key: "centro_nombre", label: "Centro", render: r => String(r.centro_nombre ?? "—"), csv: r => String(r.centro_nombre ?? "—") };
const stockMin = { name: "stock_minimo", label: "Stock mínimo (alerta)", type: "integer" as const };
// Precio unitario opcional (valor del inventario). Si no se conoce el precio
// del producto se deja en blanco: el campo no es obligatorio.
const precioField = (label: string) => ({ name: "precio", label, type: "number" as const, help: "Opcional: deja el campo en blanco si no conoces el precio." });
const precioCol: Column = {
  key: "precio", label: "Precio (€)", align: "right",
  render: r => r.precio == null || r.precio === "" ? "—" : formatNum(r.precio, 2),
  csv: r => r.precio == null || r.precio === "" ? "" : formatNum(r.precio, 2),
};
const fotoField = { name: "foto", label: "Foto", type: "image" as const, help: "Se recimensiona automáticamente antes de guardarla" };
// Celda de stock con aviso ⚠️ cuando llega al mínimo configurado.
const stockCell = (r: Row, key: string) => { const n = Number(r[key] ?? 0), min = Number(r.stock_minimo ?? 0); return <>{formatNum(n)}{min > 0 && n <= min ? <> <span className="badge danger">⚠️ mín. {min}</span></> : null}</>; };
const fotoCol = (endpoint: string): Column => ({ key: "foto", label: "Foto", render: r => Number(r.tiene_foto) === 1 ? <a href={`${endpoint}/${String(r.id)}/foto`} target="_blank" rel="noreferrer"><img className="thumb" src={`${endpoint}/${String(r.id)}/foto`} alt="Foto" loading="lazy" /></a> : "—" });
// Estado de un lote de químicos: sigue en uso mientras quede stock; cuando el
// recuento lo deja a cero pasa a «descartado» y cuando se consume, a «agotado».
const estadoTexto = (r: Row): string => Number(r.num_garrafas ?? 0) > 0 ? "En uso"
  : String(r.estado ?? "") === "descartado" ? "Descartado" : "Agotado";
const estadoLote = (r: Row): ReactNode => {
  const t = estadoTexto(r);
  return <span className={`badge ${t === "En uso" ? "ok" : t === "Descartado" ? "danger" : "muted"}`}>{t}</span>;
};
// Badge de próxima revisión de EPI (verde, ámbar a 30 días, rojo si caducada).
const revisionBadge = (r: Row) => { const f = r.fecha_revision; if (typeof f !== "string" || f.length < 10) return "—"; const n = diasHasta(f); const cls = n === null ? "" : n < 0 ? "danger" : n <= 30 ? "warn" : "ok"; const text = n !== null && n < 0 ? `Caducada (${formatFecha(f)})` : formatFecha(f); return cls ? <span className={`badge ${cls}`}>{text}</span> : text; };
export const QUIMICOS: ResourceConfig = {
  title: "Productos químicos", subtitle: "Cada registro es un lote: nº de lote, litros por garrafa, garrafas, fechas de entrada, producción y caducidad y origen", endpoint: "/api/quimicos", csvName: "quimicos", searchKeys: ["nombre", "numero_lote", "centro_nombre"], centroFilter: true, origenFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [{ name: "codigo", label: "Código", type: "text" }, { name: "marca", label: "Marca", type: "text" }, { name: "nombre", label: "Producto", type: "text", required: true }, { name: "numero_lote", label: "Nº de lote", type: "text", required: true }, { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true }, { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true }, { name: "fecha_produccion", label: "Fecha de producción", type: "date", help: "Opcional: solo informativa, no entra en ningún cálculo." }, { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", help: "Opcional: deja el campo en blanco si el producto no caduca." }, { name: "fecha_entrada", label: "Fecha de entrada", type: "date", help: "Recepción del lote en almacén: ordena el consumo por caducidad." }, { name: "origen", label: "Origen", type: "select", required: true, options: ORIGEN_OPTS, help: "¿De quién es el consumible?" }, precioField("Precio por garrafa (€)"), center, notes, stockMin, fotoField],
  columns: [{ key: "codigo", label: "Código", render: r => String(r.codigo ?? "—") }, { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") }, { key: "nombre", label: "Producto" }, { key: "numero_lote", label: "Lote" }, { key: "litros_por_garrafa", label: "L/garrafa", align: "right", render: r => formatNum(r.litros_por_garrafa, 2) }, { key: "num_garrafas", label: "Garrafas", align: "right", render: r => stockCell(r, "num_garrafas") }, { key: "total_litros", label: "Total litros", align: "right", render: r => <strong>{formatNum(r.total_litros, 2)}</strong> }, { key: "fecha_entrada", label: "Entrada", render: r => formatFecha(r.fecha_entrada) }, { key: "fecha_produccion", label: "Producción", render: r => formatFecha(r.fecha_produccion) }, { key: "fecha_caducidad", label: "Caducidad", render: dateBadge },
  // Estado del lote: en uso mientras queden garrafas; después, agotado o
  // descartado (los retira el recuento de inventario).
  { key: "estado", label: "Estado", render: r => estadoLote(r), csv: r => estadoTexto(r) }, precioCol, origenCol, centerCol, fotoCol("/api/quimicos")],
  // Totales de la tabla: litros de todo el almacén químico filtrado.
  totals: [{ key: "total_litros", label: "Total litros" }],
};
export const MATERIAL: ResourceConfig = {
  title: "Material de limpieza", subtitle: "Segregado por colores (código de zona de uso) y origen", endpoint: "/api/material-limpieza", csvName: "material-limpieza", searchKeys: ["nombre", "color", "centro_nombre"], centroFilter: true, origenFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [{ name: "codigo", label: "Código", type: "text" }, { name: "marca", label: "Marca", type: "text" }, { name: "nombre", label: "Material", type: "text", required: true }, { name: "color", label: "Color", type: "enum", required: true, enumValues: colors }, { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true }, { name: "origen", label: "Origen", type: "select", required: true, options: ORIGEN_OPTS, help: "¿De quién es el consumible?" }, precioField("Precio por unidad (€)"), center, notes, stockMin, fotoField],
  columns: [{ key: "codigo", label: "Código", render: r => String(r.codigo ?? "—") }, { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") }, { key: "nombre", label: "Material" }, { key: "color", label: "Color", render: r => <><ColorSwatch color={String(r.color ?? "")} />{String(r.color ?? "—")}</> }, { key: "cantidad", label: "Unidades", align: "right", render: r => stockCell(r, "cantidad") }, precioCol, origenCol, centerCol, { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") }, fotoCol("/api/material-limpieza")],
};
export const MAQUINARIA: ResourceConfig = {
  title: "Maquinaria", subtitle: "Marca, modelo, nº de serie, tipo y ubicación · el estado sale del histórico", endpoint: "/api/maquinaria", csvName: "maquinaria", searchKeys: ["nombre", "marca", "modelo", "tipo", "numero_serie", "zona_nombre", "subzona_nombre", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: {
    // `tipo` es texto en la base de datos: el select envía el nombre del tipo
    // (lo que valida el backend), no su id.
    tipo: { endpoint: "/api/tipos-maquinaria", label: r => String(r.nombre), value: r => String(r.nombre) },
    zona_id: { endpoint: "/api/zonas", label: r => String(r.nombre), parent: "centro_id", parentField: "centro_id" },
    subzona_id: { endpoint: "/api/subzonas", label: r => String(r.nombre), parent: "zona_id", parentField: "zona_id" },
  },
  fields: [
    { name: "tipo", label: "Tipo de máquina", type: "select", required: true },
    { name: "marca", label: "Marca", type: "text" },
    { name: "modelo", label: "Modelo", type: "text" },
    { name: "numero_serie", label: "Nº de serie", type: "text" },
    { name: "centro_id", label: "Centro", type: "select", required: true },
    { name: "zona_id", label: "Zona", type: "select", required: true },
    { name: "subzona_id", label: "Subzona", type: "select" },
    notes, fotoField,
  ],
  columns: [
    { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") },
    { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") },
    { key: "numero_serie", label: "Nº de serie", render: r => String(r.numero_serie ?? "—") },
    { key: "tipo", label: "Tipo" },
    centerCol,
    { key: "zona_nombre", label: "Zona", render: r => String(r.zona_nombre ?? "—") },
    { key: "subzona_nombre", label: "Subzona", render: r => String(r.subzona_nombre ?? "—") },
    { key: "estado", label: "Estado", render: estadoBadge },
    fotoCol("/api/maquinaria"),
  ],
};
export const CENTROS: ResourceConfig = {
  title: "Centros", subtitle: "Plantas o ubicaciones donde se guarda el material", endpoint: "/api/centros", csvName: "centros", searchKeys: ["nombre", "ciudad", "responsable", "direccion"], perms: { read: "all", create: "centros", update: "centros", delete: "centros" },
  fields: [{ name: "nombre", label: "Nombre del centro", type: "text", required: true }, { name: "direccion", label: "Dirección", type: "text" }, { name: "ciudad", label: "Ciudad", type: "text" }, { name: "responsable", label: "Responsable", type: "text" }, { name: "telefono", label: "Teléfono", type: "text" }],
  columns: [{ key: "nombre", label: "Centro" }, ...["direccion", "ciudad", "responsable", "telefono"].map(key => ({ key, label: key[0].toUpperCase() + key.slice(1), render: (r: Row) => String(r[key] ?? "—") }))],
};
export const USUARIOS: ResourceConfig = {
  title: "Usuarios", subtitle: "Administradores, usuarios y sus centros de trabajo", endpoint: "/api/usuarios", csvName: "usuarios", searchKeys: ["username", "nombre", "email", "centros_nombre"], perms: { read: "admin", create: "admin", update: "admin", delete: "admin" }, formCentros: true,
  // RGPD: descarga de todos los datos personales de un operario en JSON.
  extraAction: {
    icon: "📦", label: "Datos", title: "Descargar los datos personales del operario (RGPD)",
    run: async (row) => {
      const datos = await api.get<unknown>(`/api/usuarios/${String(row.id)}/datos`);
      const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `datos-${String(row.username ?? row.id)}-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  },
  fields: [{ name: "username", label: "Usuario (login)", type: "text", required: true }, { name: "nombre", label: "Nombre completo", type: "text", required: true }, { name: "email", label: "Email", type: "text" }, { name: "password", label: "Contraseña", type: "password", writeOnly: true, help: "Al crear es obligatoria (mínimo 6 caracteres); al editar, en blanco la conserva." }, { name: "rol", label: "Rol", type: "select", required: true, options: [{ value: "admin", label: "Administrador" }, { value: "admin_centros", label: "Administrador de centros" }, { value: "usuario", label: "Usuario" }] }, { name: "activo", label: "Activo", type: "boolean" }],
  columns: [{ key: "username", label: "Login" }, { key: "nombre", label: "Nombre" }, { key: "email", label: "Email", render: r => String(r.email ?? "—") }, { key: "rol", label: "Rol", render: r => <span className={`badge ${r.rol === "admin" ? "info" : r.rol === "admin_centros" ? "warn" : "muted"}`}>{r.rol === "admin" ? "Administrador" : r.rol === "admin_centros" ? "Adm. de centros" : "Usuario"}</span> }, { key: "activo", label: "Estado", render: r => Number(r.activo) === 1 ? <span className="badge ok">Activo</span> : <span className="badge muted">Desactivado</span> }, { key: "centros_nombre", label: "Centros asignados", render: r => String(r.centros_nombre ?? "—") }],
};

export const TALLAS: ResourceConfig = {
  title: "Tallas de operarios", subtitle: "Operario · prenda · talla · notas", endpoint: "/api/tallas", csvName: "tallas-operarios", searchKeys: ["usuario_nombre", "usuario_username", "prenda", "talla"], perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: { usuario_id: { endpoint: "/api/usuarios", label: r => `${String(r.nombre)} (${String(r.username)})` } },
  fields: [{ name: "usuario_id", label: "Operario", type: "select", required: true, options: [] },
    { name: "prenda", label: "Prenda", type: "text", required: true },
    { name: "talla", label: "Talla", type: "text", required: true },
    { name: "notas", label: "Notas", type: "textarea" },
  ],
  columns: [
    { key: "usuario_nombre", label: "Operario", render: r => String(r.usuario_nombre ?? "—") },
    { key: "prenda", label: "Prenda", render: r => String(r.prenda ?? "—") },
    { key: "talla", label: "Talla", render: r => <strong>{String(r.talla ?? "—")}</strong> },
    { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") },
    { key: "fecha", label: "Fecha", render: r => formatFecha(String(r.fecha ?? "")) },
  ],
};
export const EPIS: ResourceConfig = {
  title: "EPIs", subtitle: "Equipos de protección individual con stock por centro", endpoint: "/api/epis", csvName: "epis", searchKeys: ["codigo", "tipo_equipo_nombre", "marca", "modelo", "talla", "color", "centro_nombre"], centroFilter: true, tipoEquipoFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: { tipo_equipo_id: { endpoint: "/api/tipos-equipo", label: r => String(r.nombre) } },
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true },
    { name: "tipo_equipo_id", label: "Tipo de equipo", type: "select" },
    { name: "marca", label: "Marca", type: "text" },
    { name: "modelo", label: "Modelo", type: "text" },
    { name: "talla", label: "Talla (opcional)", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    { name: "color", label: "Color", type: "enum", enumValues: colors },
    { name: "stock", label: "Stock", type: "integer", required: true }, stockMin,
    { name: "fecha_revision", label: "Próxima revisión", type: "date" },
    precioField("Precio por unidad (€)"),
    center,
  ],
  columns: [
    { key: "codigo", label: "Código" },
    { key: "tipo_equipo_nombre", label: "Tipo", render: r => String(r.tipo_equipo_nombre ?? "—") },
    { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") },
    { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") },
    { key: "talla", label: "Talla", render: r => String(r.talla ?? "—") },
    { key: "color", label: "Color", render: r => r.color ? <><ColorSwatch color={String(r.color)} />{String(r.color)}</> : "—" },
    { key: "stock", label: "Stock", align: "right", render: r => stockCell(r, "stock") }, precioCol, centerCol,
    { key: "fecha_revision", label: "Próxima revisión", render: revisionBadge },
    { key: "descripcion", label: "Descripción", render: r => String(r.descripcion ?? "—") },
  ],
};
export const ROPA: ResourceConfig = {
  title: "Ropa de trabajo", subtitle: "Prendas de los centros: alta visibilidad y manga larga", endpoint: "/api/ropa-trabajo", csvName: "ropa-trabajo", searchKeys: ["codigo", "prenda", "tipo_equipo_nombre", "fabricante", "modelo", "color", "centro_nombre"], centroFilter: true, tipoEquipoFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: { tipo_equipo_id: { endpoint: "/api/tipos-equipo", label: r => String(r.nombre) } },
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true },
    { name: "prenda", label: "Prenda", type: "text", required: true },
    { name: "tipo_equipo_id", label: "Tipo de equipo", type: "select" },
    { name: "marca", label: "Marca", type: "text" },
    { name: "fabricante", label: "Fabricante", type: "text" },
    { name: "modelo", label: "Modelo", type: "text" },
    { name: "talla", label: "Talla", type: "text" },
    { name: "alta_visibilidad", label: "Alta visibilidad", type: "boolean", required: true },
    { name: "manga_larga", label: "Manga larga", type: "boolean", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    { name: "color", label: "Color", type: "enum", enumValues: colors },
    { name: "stock", label: "Stock", type: "integer", required: true }, stockMin,
    precioField("Precio por unidad (€)"),
    center,
  ],
  columns: [
    { key: "codigo", label: "Código" },
    { key: "prenda", label: "Prenda" },
    { key: "tipo_equipo_nombre", label: "Tipo", render: r => String(r.tipo_equipo_nombre ?? "—") },
    { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") },
    { key: "fabricante", label: "Fabricante", render: r => String(r.fabricante ?? "—") },
    { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") },
    { key: "talla", label: "Talla", render: r => String(r.talla ?? "—") },
    { key: "alta_visibilidad", label: "A. visibilidad", render: r => Number(r.alta_visibilidad) === 1 ? <span className="badge warn">Sí</span> : <span className="badge muted">No</span> },
    { key: "manga_larga", label: "Manga larga", render: r => Number(r.manga_larga) === 1 ? <span className="badge info">Sí</span> : <span className="badge muted">No</span> },
    { key: "color", label: "Color", render: r => r.color ? <><ColorSwatch color={String(r.color)} />{String(r.color)}</> : "—" },
    { key: "stock", label: "Stock", align: "right", render: r => stockCell(r, "stock") }, precioCol, centerCol,
  ],
};
export const TIPOS: ResourceConfig = {
  title: "Tipos de maquinaria", subtitle: "Lista gestionada de tipos disponibles en Maquinaria", endpoint: "/api/tipos-maquinaria", csvName: "tipos-maquinaria", searchKeys: ["nombre", "notas"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true },
    { name: "notas", label: "Notas", type: "textarea" },
  ],
  columns: [
    { key: "nombre", label: "Tipo" },
    { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") },
  ],
};
// Situaciones de la maquinaria: catálogo del histórico (pestaña de Control de maquinaria).
export const SITUACIONES: ResourceConfig = {
  title: "Situaciones de maquinaria", subtitle: "Operativo, en reparación, mantenimiento preventivo, averiado, baja… crea las tuyas", endpoint: "/api/situaciones", csvName: "situaciones", searchKeys: ["nombre"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "nombre", label: "Situación", type: "text", required: true },
  ],
  columns: [
    { key: "nombre", label: "Situación" },
    { key: "created_at", label: "Alta", render: r => formatFecha(String(r.created_at ?? "")) },
  ],
};
export const TIPOS_EQUIPO: ResourceConfig = {
  title: "Tipos de equipo", subtitle: "Abrigo, camiseta, tapones de oídos, gafas de seguridad… (comunes a Ropa y EPIs)", endpoint: "/api/tipos-equipo", csvName: "tipos-equipo", searchKeys: ["nombre"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true },
  ],
  columns: [
    { key: "nombre", label: "Tipo de equipo" },
    { key: "created_at", label: "Alta", render: r => formatFecha(String(r.created_at ?? "")) },
  ],
};
export const SOPORTES: ResourceConfig = {
  title: "Soportes", subtitle: "Dónde se instalan las estaciones de consumo", endpoint: "/api/soportes", csvName: "soportes", searchKeys: ["nombre"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [{ name: "nombre", label: "Nombre del soporte", type: "text", required: true }],
  columns: [{ key: "nombre", label: "Soporte" }, { key: "created_at", label: "Alta", render: r => formatFecha(String(r.created_at ?? "")) }],
};
export const TIPOS_CONSUMIBLES: ResourceConfig = {
  title: "Tipos de consumible", subtitle: "Qué tipo de artículo consume cada estación", endpoint: "/api/consumibles-tipos", csvName: "tipos-consumible", searchKeys: ["nombre", "articulo_tipo"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "nombre", label: "Nombre del tipo", type: "text", required: true },
    { name: "articulo_tipo", label: "Tipo de artículo", type: "enum", required: true, enumValues: ["quimicos", "material_limpieza", "epis", "ropa_trabajo", "maquinaria"] },
  ],
  columns: [
    { key: "nombre", label: "Tipo de consumible" },
    { key: "articulo_tipo", label: "Artículos que consume", render: r => <span className="badge info">{String(r.articulo_tipo ?? "—")}</span> },
  ],
};
export const MOVIMIENTOS: ResourceConfig = {
  title: "Auditoría de movimientos", subtitle: "Entradas, salidas, consumos, altas, ediciones y borrados con su motivo", endpoint: "/api/movimientos", csvName: "movimientos", searchKeys: ["usuario_nombre", "accion", "descripcion", "motivo"], readOnlyPage: true,
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [],
  columns: [
    { key: "created_at", label: "Fecha y hora", render: r => String(r.created_at ?? "—").replace("T", " ").slice(0, 16) },
    { key: "usuario_nombre", label: "Usuario", render: r => String(r.usuario_nombre ?? "—") },
    { key: "accion", label: "Tipo de movimiento", render: r => { const a = String(r.accion ?? ""); const cls = a === "alta" ? "ok" : a === "edicion" ? "info" : a === "borrado" ? "danger" : a === "salida" ? "warn" : a === "ajuste" ? "muted" : a.startsWith("deshacer") ? "warn" : "info"; return <span className={`badge ${cls}`}>{(a || "—").replaceAll("_", " ")}</span>; } },
    { key: "descripcion", label: "Detalle", render: r => String(r.descripcion ?? "—") },
    { key: "cantidad", label: "Cant.", align: "right", render: r => r.cantidad == null ? "—" : formatNum(r.cantidad) },
    { key: "motivo", label: "Motivo", render: r => String(r.motivo ?? "—") },
  ],
};
export function ResourcePage({ config, user }: { config: ResourceConfig; user: { rol: string } }) {
  const [items, setItems] = useState<Row[]>([]), [centros, setCentros] = useState<Row[]>([]), [users, setUsers] = useState<Row[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [q, setQ] = useState(""), [centroId, setCentroId] = useState("all"), [tipoEqId, setTipoEqId] = useState("all"), [origenId, setOrigenId] = useState("all"), [editing, setEditing] = useState<{ mode: "create" | "edit"; values: Row } | null>(null), [formError, setFormError] = useState<string | null>(null), [saving, setSaving] = useState(false), [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null), [linkRows, setLinkRows] = useState<Record<string, Row[]>>({}), [formCentrosSel, setFormCentrosSel] = useState<Set<number>>(() => new Set()), [qrRow, setQrRow] = useState<Row | null>(null);
  // Campos que han fallado al validar: se sombrean en rojo dentro del formulario.
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);
  // Filas renderizadas: se muestran de 50 en 50 para no bloquear la tabla.
  const [limite, setLimite] = useState(50);
  const canCreate = !config.readOnlyPage && allow(user.rol, config.perms.create), canUpdate = !config.readOnlyPage && allow(user.rol, config.perms.update), canDelete = !config.readOnlyPage && allow(user.rol, config.perms.delete);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setItems((await api.get<{ items: Row[] }>(config.endpoint)).items); } catch (e) { setError(e instanceof Error ? e.message : "Error cargando los datos"); } finally { setLoading(false); } }, [config.endpoint]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { setLimite(50); }, [q, centroId, tipoEqId, origenId]);
  useEffect(() => { if (config.centroFilter || config.formCentros || config.fields.some(f => f.name === "centro_id")) api.get<{ items: Row[] }>("/api/centros").then(r => setCentros(r.items)).catch(() => setCentros([])); }, [config]);
  useEffect(() => { if (config.fields.some(f => f.name === "usuario_id")) api.get<{ items: Row[] }>("/api/usuarios").then(r => setUsers(r.items)).catch(() => setUsers([])); }, [config]);
  useEffect(() => {
    if (!config.links) return;
    for (const [name, link] of Object.entries(config.links)) {
      if (link.endpoints) {
        const tipoDe = (ep: string) => ep.includes("quimicos") ? "quimicos" : "material_limpieza";
        Promise.all(link.endpoints.map(ep => api.get<{ items: Row[] }>(ep).then(r => r.items.map(item => ({ ...item, _tipo: tipoDe(ep) }))).catch(() => [])))
          .then(groups => setLinkRows(prev => ({ ...prev, [name]: groups.flat() })));
      } else if (link.endpoint) {
        api.get<{ items: Row[] }>(link.endpoint).then(r => setLinkRows(prev => ({ ...prev, [name]: r.items }))).catch(() => setLinkRows(prev => ({ ...prev, [name]: [] })));
      }
    }
  }, [config]);
  const filtered = useMemo(() => { const needle = q.trim().toLowerCase(); return items.filter(row => (centroId === "all" || String(row.centro_id ?? "") === centroId) && (tipoEqId === "all" || String(row.tipo_equipo_id ?? "") === tipoEqId) && (origenId === "all" || String(row.origen ?? "") === origenId) && (!needle || config.searchKeys.some(k => String(row[k] ?? "").toLowerCase().includes(needle)))); }, [items, q, centroId, tipoEqId, origenId, config]);
  // Totales al pie de la tabla (p. ej. los litros de los químicos filtrados).
  const totales = useMemo(() => {
    if (!config.totals?.length) return null;
    const suma: Record<string, number> = {};
    for (const t of config.totals) suma[t.key] = filtered.reduce((acc, row) => acc + Number(row[t.key] ?? 0), 0);
    return suma;
  }, [filtered, config.totals]);
  if (config.perms.read === "admin" && user.rol !== "admin") return <div className="card empty"><span className="icon">🔒</span><strong>Sección restringida</strong><p>Solo los administradores pueden gestionar los usuarios.</p></div>;
  const fields: FieldDef[] = config.fields.map(f => {
    if (f.name === "centro_id") return { ...f, options: centros.map(c => ({ value: Number(c.id), label: String(c.nombre) })) };
    const link = config.links?.[f.name];
    if (link) {
      // Select en cascada: si el campo tiene padre, solo se muestran las filas
      // cuyo parentField coincida con el valor elegido en el padre.
      const padre = link.parent ? String(editing?.values[link.parent] ?? "") : null;
      const key = link.parentField ?? link.parent ?? "";
      const rows = (linkRows[f.name] ?? []).filter(r => padre === null || String(r[key] ?? "") === padre);
      return { ...f, options: rows.map(r => ({ value: link.value ? link.value(r) : Number(r.id), label: link.label(r) })) };
    }
    if (f.name === "usuario_id") return { ...f, options: users.map(c => ({ value: Number(c.id), label: `${String(c.nombre)} (${String(c.username)})` })) };
    return f;
  });
  const openCreate = () => { const values: Row = {}; for (const f of config.fields) values[f.name] = f.type === "boolean" ? true : ""; setFormCentrosSel(new Set()); setFormError(null); setFieldErrors([]); setEditing({ mode: "create", values }); };
  const openEdit = (row: Row) => { const values: Row = { id: row.id, tiene_foto: row.tiene_foto }; for (const f of config.fields) { if (f.type === "image") continue; values[f.name] = f.name === "password" ? "" : row[f.name] ?? (f.type === "boolean" ? false : ""); } setFormCentrosSel(new Set(String(row.centros_ids ?? "").split(",").filter(Boolean).map(Number))); setFormError(null); setFieldErrors([]); setEditing({ mode: "edit", values }); };
  // Cambiar un campo padre limpia en cascada los dependientes (centro → zona → subzona).
  const setVal = (name: string, v: unknown) => {
    setFieldErrors(prev => (prev.includes(name) ? prev.filter(k => k !== name) : prev));
    setEditing(prev => {
      if (!prev) return prev;
      const values: Row = { ...prev.values, [name]: v };
      const limpiar = (padre: string) => {
        for (const [hijo, link] of Object.entries(config.links ?? {})) {
          if (link.parent === padre && hijo !== name) { values[hijo] = ""; limpiar(hijo); }
        }
      };
      limpiar(name);
      return { ...prev, values };
    });
  };
  // Etiquetas del formulario: sirven para localizar el campo de un error.
  const etiquetasForm = [...config.fields.map(f => ({ clave: f.name, etiqueta: f.label })), { clave: "__centros", etiqueta: "Centros de trabajo" }];

  const save = async () => { if (!editing) return; const esAdmin = editing.values.rol === "admin"; if (config.formCentros && !esAdmin && !formCentrosSel.size) { setFieldErrors(["__centros"]); setFormError("Asigna al menos un centro de trabajo al operario"); return; } const vacios = config.fields.filter(f => f.required && f.type !== "password" && (editing.values[f.name] === "" || editing.values[f.name] == null)).map(f => f.name); if (vacios.length) { setFieldErrors(vacios); setFormError("Revisa los campos marcados en rojo"); return; } setSaving(true); setFormError(null); setFieldErrors([]); const payload: Row = {}; for (const f of config.fields) { if (f.type === "image" && !(f.name in editing.values)) continue; let v = editing.values[f.name]; if (f.type === "number" || f.type === "integer") v = v === "" || v == null ? null : Number(String(v).replace(",", ".")); if (f.type === "boolean") v = v === true || v === 1 ? 1 : 0; payload[f.name] = v ?? null; } try { let userId = editing.mode === "edit" ? Number(editing.values.id) : 0; if (editing.mode === "create") { const r = await api.post<{ item?: Row }>(config.endpoint, payload); userId = Number(r?.item?.id ?? 0); } else await api.put(`${config.endpoint}/${String(editing.values.id)}`, payload); if (config.formCentros && userId > 0) await api.put(`${config.endpoint}/${userId}/centros`, { centros: esAdmin ? [] : [...formCentrosSel] }); setEditing(null); setToast({ message: "Cambios guardados", kind: "ok" }); await load(); } catch (e) { const msg = e instanceof Error ? e.message : "No se pudo guardar el registro"; setFormError(msg); setFieldErrors(camposConError(msg, etiquetasForm)); } finally { setSaving(false); } };
  const remove = async (row: Row) => { if (!window.confirm(`¿Eliminar "${String(row.nombre ?? row.username ?? row.id)}"? Esta acción no se puede deshacer.`)) return; try { await api.del(`${config.endpoint}/${String(row.id)}`); setToast({ message: "Registro eliminado", kind: "ok" }); await load(); } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); } };
  const exportCsv = () => { const stamp = new Date().toISOString().slice(0, 10); downloadCsv(`${config.csvName}-${stamp}.csv`, config.columns.map(c => c.label), filtered.map(row => config.columns.map(c => c.csv ? c.csv(row) : String(row[c.key] ?? "")))); };
  return <><div className="toolbar no-print"><input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar…" value={q} onChange={e => setQ(e.target.value)} />{(config.centroFilter || config.fields.some(f => f.name === "centro_id")) && <select className="input" style={{ maxWidth: 220 }} value={centroId} onChange={e => setCentroId(e.target.value)}><option value="all">Todos los centros</option>{centros.map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}</select>}{config.tipoEquipoFilter && <select className="input" style={{ maxWidth: 200 }} value={tipoEqId} onChange={e => setTipoEqId(e.target.value)} aria-label="Filtrar por tipo de equipo"><option value="all">Todos los tipos</option>{(linkRows["tipo_equipo_id"] ?? []).map(t => <option key={String(t.id)} value={String(t.id)}>{String(t.nombre)}</option>)}</select>}{config.origenFilter && <select className="input" style={{ maxWidth: 190 }} value={origenId} onChange={e => setOrigenId(e.target.value)} aria-label="Filtrar por origen"><option value="all">Todo el origen</option>{ORIGEN_OPTS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}<div className="spacer"/>{user.rol !== "usuario" && <button className="btn secondary" onClick={exportCsv} disabled={!filtered.length}>⬇️ CSV</button>}{canCreate && <button className="btn" onClick={openCreate}>＋ Nuevo registro</button>}</div>
  <div className="card">{loading?<div className="loading">Cargando…</div>:error?<div className="empty">⚠️ {error}</div>:!filtered.length?<div className="empty"><span className="icon">📭</span><strong>No hay registros</strong><p>{q||centroId!=="all"||tipoEqId!=="all"||origenId!=="all"?"Prueba con otra búsqueda u otro filtro.":"Pulsa «Nuevo registro» para añadir el primero."}</p></div>:<div className="table-scroll"><table><thead><tr>{config.columns.map(c=><th key={c.key} className={c.align==="right"?"right":""}>{c.label}</th>)}{(canUpdate||canDelete||config.qrTipo||config.extraAction)&&<th className="right">Acciones</th>}</tr></thead><tbody>{filtered.slice(0, limite).map(row=><tr key={String(row.id)}>{config.columns.map(c=><td key={c.key} className={c.align==="right"?"right":""}>{c.render?c.render(row):String(row[c.key]??"—")}</td>)}{(canUpdate||canDelete||config.qrTipo||config.extraAction)&&<td className="right"><div className="row-actions">{config.extraAction&&<button className="btn secondary small" title={config.extraAction.title} onClick={()=>void config.extraAction!.run(row)}>{config.extraAction.icon} {config.extraAction.label}</button>}{config.qrTipo&&<button className="btn secondary small" onClick={()=>setQrRow(row)}>🏷️ QR</button>}{canUpdate&&<button className="btn secondary small" onClick={()=>openEdit(row)}>✏️ Editar</button>}{canDelete&&<button className="btn danger small" onClick={()=>void remove(row)}>🗑️ Borrar</button>}</div></td>}</tr>)}</tbody>{totales&&<tfoot><tr>{config.columns.map((c,i)=><td key={c.key} className={c.align==="right"?"right":""}>{i===0?<strong>Totales · {formatNum(filtered.length)}</strong>:totales[c.key]!==undefined?formatNum(totales[c.key],2):null}</td>)}{(canUpdate||canDelete||config.qrTipo||config.extraAction)&&<td/>}</tr></tfoot>}</table></div>}{filtered.length > limite && <div style={{ textAlign: "center", padding: "10px 0 2px" }}>
    <button className="btn secondary" onClick={() => setLimite(l => l + 100)}>⬇️ Mostrar más · quedan {formatNum(filtered.length - limite)} de {formatNum(filtered.length)}</button>
  </div>}</div>
  <p className="no-print" style={{color:"var(--muted)",margin:0}}>{filtered.length} de {items.length} registros · {config.subtitle}</p>{qrRow&&config.qrTipo&&<QrModal tipo={config.qrTipo} id={Number(qrRow.id)} title={String(qrRow.nombre ?? qrRow.prenda ?? qrRow.numero_lote ?? qrRow.id)} onClose={()=>setQrRow(null)}/>}
  {editing&&<Modal title={editing.mode==="create"?`Nuevo registro · ${config.title}`:`Editar · ${config.title}`} subtitle={config.subtitle} onClose={()=>setEditing(null)}>{formError&&<div className="form-error">{formError}</div>}<div className="form-grid">{fields.map(f=><div key={f.name} className={f.type==="textarea"||f.type==="image"?"full":""}><Field def={editing.mode==="edit"&&f.type==="image"?{...f,hasExisting:Boolean(editing.values.tiene_foto),previewUrl:`${config.endpoint}/${String(editing.values.id)}/foto`}:f} value={editing.values[f.name]} onChange={v=>setVal(f.name, v)} error={fieldErrors.includes(f.name)}/></div>)}{config.formCentros&&editing.values.rol!=="admin"&&<div className={"field full"+(fieldErrors.includes("__centros")?" error":"")}><label>Centros de trabajo<span className="req">*</span></label><div className="centros-toggle">{centros.map(cn=><button type="button" key={String(cn.id)} className={"chip"+(formCentrosSel.has(Number(cn.id))?" on":"")} disabled={saving} onClick={()=>{setFieldErrors(prev=>prev.filter(k=>k!=="__centros"));const id=Number(cn.id);setFormCentrosSel(prev=>{const next=new Set(prev);if(next.has(id))next.delete(id);else next.add(id);return next;});}}>{String(cn.nombre)}</button>)}</div><small>Elige uno o varios centros donde trabajará.</small></div>}</div><div className="modal-footer"><button className="btn secondary" onClick={()=>setEditing(null)}>Cancelar</button><button className="btn" onClick={()=>void save()} disabled={saving}>{saving?"Guardando…":"Guardar"}</button></div></Modal>}{toast&&<Toast message={toast.message} kind={toast.kind} onClose={()=>setToast(null)}/>}</>;
}
