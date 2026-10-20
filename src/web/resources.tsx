import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";
import { ColorSwatch, Field, Modal, Toast, diasHasta, downloadCsv, formatFecha, formatNum, type FieldDef } from "./ui";
import { QrModal } from "./qr";

type Row = Record<string, unknown>;
type Permission = "all" | "admin";
type Column = { key: string; label: string; align?: "right"; render?: (row: Row) => ReactNode; csv?: (row: Row) => string | number };
export interface ResourceConfig {
  title: string; subtitle: string; endpoint: string; csvName: string; searchKeys: string[]; centroFilter?: boolean;
  perms: { read: Permission; create: Permission; update: Permission; delete: Permission }; fields: FieldDef[]; columns: Column[];
  // Selects de otros recursos (operario, prenda…): endpoint + etiqueta por fila.
  links?: Record<string, { endpoint?: string; endpoints?: string[]; label: (r: Row) => string; value?: (r: Row) => string | number }>;
  // Muestra el botón de imprimir el QR del artículo (puesto de consumo).
  qrTipo?: string;
  // Página de solo consulta (sin altas, ediciones ni borrados).
  readOnlyPage?: boolean;
  // Columna con botones de asignación de 1 o varios centros (Usuarios).
  centrosToggle?: boolean;
}
const allow = (role: string, p: Permission) => p === "all" || role === "admin";
const center = { name: "centro_id", label: "Centro", type: "select" as const };
const notes = { name: "notas", label: "Notas", type: "textarea" as const };
const colors = ["Rojo", "Azul", "Verde", "Amarillo", "Blanco", "Negro", "Naranja", "Morado", "Gris", "Marrón", "Otro"];
const machineStates = ["Operativa", "En reparación", "Averiada", "Baja"];
const dateBadge = (r: Row) => { const n = diasHasta(r.fecha_caducidad), cls = n === null || n > 90 ? "" : n < 0 ? "danger" : n <= 30 ? "warn" : "info"; const text = n === null || n > 90 ? formatFecha(r.fecha_caducidad) : n < 0 ? `Vencida (${formatFecha(r.fecha_caducidad)})` : `${formatFecha(r.fecha_caducidad)} · ${n} d`; return cls ? <span className={`badge ${cls}`}>{text}</span> : text; };
const centerCol: Column = { key: "centro_nombre", label: "Centro", render: r => String(r.centro_nombre ?? "—"), csv: r => String(r.centro_nombre ?? "—") };
const stockMin = { name: "stock_minimo", label: "Stock mínimo (alerta)", type: "integer" as const };
const fotoField = { name: "foto", label: "Foto", type: "image" as const, help: "Se recimensiona automáticamente antes de guardarla" };
// Celda de stock con aviso ⚠️ cuando llega al mínimo configurado.
const stockCell = (r: Row, key: string) => { const n = Number(r[key] ?? 0), min = Number(r.stock_minimo ?? 0); return <>{formatNum(n)}{min > 0 && n <= min ? <> <span className="badge danger">⚠️ mín. {min}</span></> : null}</>; };
const fotoCol = (endpoint: string): Column => ({ key: "foto", label: "Foto", render: r => Number(r.tiene_foto) === 1 ? <a href={`${endpoint}/${String(r.id)}/foto`} target="_blank" rel="noreferrer"><img className="thumb" src={`${endpoint}/${String(r.id)}/foto`} alt="Foto" loading="lazy" /></a> : "—" });
// Badge de próxima revisión de EPI (verde, ámbar a 30 días, rojo si caducada).
const revisionBadge = (r: Row) => { const f = r.fecha_revision; if (typeof f !== "string" || f.length < 10) return "—"; const n = diasHasta(f); const cls = n === null ? "" : n < 0 ? "danger" : n <= 30 ? "warn" : "ok"; const text = n !== null && n < 0 ? `Caducada (${formatFecha(f)})` : formatFecha(f); return cls ? <span className={`badge ${cls}`}>{text}</span> : text; };
export const QUIMICOS: ResourceConfig = {
  title: "Productos químicos", subtitle: "Lote, litros por garrafa, número de garrafas y fecha de caducidad", endpoint: "/api/quimicos", csvName: "quimicos", searchKeys: ["nombre", "numero_lote", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" }, qrTipo: "quimicos",
  fields: [{ name: "codigo", label: "Código", type: "text" }, { name: "marca", label: "Marca", type: "text" }, { name: "nombre", label: "Producto", type: "text", required: true }, { name: "numero_lote", label: "Nº de lote", type: "text", required: true }, { name: "litros_por_garrafa", label: "Litros por garrafa (L)", type: "number", required: true }, { name: "num_garrafas", label: "Nº de garrafas", type: "integer", required: true }, { name: "fecha_caducidad", label: "Fecha de caducidad", type: "date", required: true }, center, notes, stockMin, fotoField, { name: "coste_unitario", label: "Coste por garrafa (€)", type: "number" }],
  columns: [{ key: "codigo", label: "Código", render: r => String(r.codigo ?? "—") }, { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") }, { key: "nombre", label: "Producto" }, { key: "numero_lote", label: "Lote" }, { key: "litros_por_garrafa", label: "L/garrafa", align: "right", render: r => formatNum(r.litros_por_garrafa, 2) }, { key: "num_garrafas", label: "Garrafas", align: "right", render: r => stockCell(r, "num_garrafas") }, { key: "total_litros", label: "Total litros", align: "right", render: r => <strong>{formatNum(r.total_litros, 2)}</strong> }, { key: "coste_unitario", label: "Coste/ud. (€)", align: "right", render: r => r.coste_unitario == null ? "—" : formatNum(r.coste_unitario, 2) }, { key: "fecha_caducidad", label: "Caducidad", render: dateBadge }, centerCol, fotoCol("/api/quimicos")],
};
export const MATERIAL: ResourceConfig = {
  title: "Material de limpieza", subtitle: "Segregado por colores (código de zona de uso)", endpoint: "/api/material-limpieza", csvName: "material-limpieza", searchKeys: ["nombre", "color", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" }, qrTipo: "material_limpieza",
  fields: [{ name: "codigo", label: "Código", type: "text" }, { name: "marca", label: "Marca", type: "text" }, { name: "nombre", label: "Material", type: "text", required: true }, { name: "color", label: "Color", type: "enum", required: true, enumValues: colors }, { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true }, center, notes, stockMin, fotoField, { name: "coste_unitario", label: "Coste por unidad (€)", type: "number" }],
  columns: [{ key: "codigo", label: "Código", render: r => String(r.codigo ?? "—") }, { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") }, { key: "nombre", label: "Material" }, { key: "color", label: "Color", render: r => <><ColorSwatch color={String(r.color ?? "")} />{String(r.color ?? "—")}</> }, { key: "cantidad", label: "Unidades", align: "right", render: r => stockCell(r, "cantidad") }, { key: "coste_unitario", label: "Coste/ud. (€)", align: "right", render: r => r.coste_unitario == null ? "—" : formatNum(r.coste_unitario, 2) }, centerCol, { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") }, fotoCol("/api/material-limpieza")],
};
export const MAQUINARIA: ResourceConfig = {
  title: "Maquinaria de limpieza", subtitle: "Segregada por tipo de máquina", endpoint: "/api/maquinaria", csvName: "maquinaria", searchKeys: ["nombre", "tipo", "estado", "numero_serie", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [{ name: "nombre", label: "Máquina", type: "text", required: true }, { name: "tipo", label: "Tipo", type: "select", required: true }, { name: "marca", label: "Marca", type: "text" }, { name: "modelo", label: "Modelo", type: "text" }, { name: "cantidad", label: "Cantidad (uds.)", type: "integer", required: true }, { name: "numero_serie", label: "Nº de serie", type: "text" }, { name: "estado", label: "Estado", type: "enum", required: true, enumValues: machineStates }, center, notes, fotoField],
  links: { tipo: { endpoint: "/api/tipos-maquinaria", label: r => String(r.nombre) } },
  columns: [{ key: "nombre", label: "Máquina" }, { key: "tipo", label: "Tipo" }, { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") }, { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") }, { key: "cantidad", label: "Unidades", align: "right", render: r => formatNum(r.cantidad) }, { key: "numero_serie", label: "Nº de serie", render: r => String(r.numero_serie ?? "—") }, { key: "estado", label: "Estado", render: r => <span className={`badge ${r.estado === "Operativa" ? "ok" : r.estado === "En reparación" ? "warn" : r.estado === "Averiada" ? "danger" : "muted"}`}>{String(r.estado ?? "—")}</span> }, centerCol, fotoCol("/api/maquinaria")],
};
export const CENTROS: ResourceConfig = {
  title: "Centros", subtitle: "Plantas o ubicaciones donde se guarda el material", endpoint: "/api/centros", csvName: "centros", searchKeys: ["nombre", "ciudad", "responsable", "direccion"], perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [{ name: "nombre", label: "Nombre del centro", type: "text", required: true }, { name: "direccion", label: "Dirección", type: "text" }, { name: "ciudad", label: "Ciudad", type: "text" }, { name: "responsable", label: "Responsable", type: "text" }, { name: "telefono", label: "Teléfono", type: "text" }],
  columns: [{ key: "nombre", label: "Centro" }, ...["direccion", "ciudad", "responsable", "telefono"].map(key => ({ key, label: key[0].toUpperCase() + key.slice(1), render: (r: Row) => String(r[key] ?? "—") }))],
};
export const USUARIOS: ResourceConfig = {
  title: "Usuarios", subtitle: "Administradores y usuarios de la aplicación", endpoint: "/api/usuarios", csvName: "usuarios", searchKeys: ["username", "nombre", "email", "centros_nombre"], perms: { read: "admin", create: "admin", update: "admin", delete: "admin" }, centrosToggle: true,
  fields: [{ name: "username", label: "Usuario (login)", type: "text", required: true }, { name: "nombre", label: "Nombre completo", type: "text", required: true }, { name: "email", label: "Email", type: "text" }, { name: "password", label: "Contraseña", type: "password", writeOnly: true, help: "Al crear es obligatoria (mínimo 6 caracteres); al editar, en blanco la conserva." }, { name: "rol", label: "Rol", type: "enum", required: true, enumValues: ["admin", "usuario"] }, { name: "activo", label: "Usuario activo", type: "boolean" }],
  columns: [{ key: "username", label: "Login" }, { key: "nombre", label: "Nombre" }, { key: "email", label: "Email", render: r => String(r.email ?? "—") }, { key: "rol", label: "Rol", render: r => <span className={`badge ${r.rol === "admin" ? "info" : "muted"}`}>{r.rol === "admin" ? "Administrador" : "Usuario"}</span> }, { key: "activo", label: "Estado", render: r => Number(r.activo) === 1 ? <span className="badge ok">Activo</span> : <span className="badge muted">Desactivado</span> }, { key: "centros_nombre", label: "Centros asignados", render: r => String(r.centros_nombre ?? "—") }],
};
export const EPIS: ResourceConfig = {
  title: "EPIs", subtitle: "Equipos de protección individual con stock por centro", endpoint: "/api/epis", csvName: "epis", searchKeys: ["codigo", "marca", "modelo", "talla", "color", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true },
    { name: "marca", label: "Marca", type: "text" },
    { name: "modelo", label: "Modelo", type: "text" },
    { name: "talla", label: "Talla (opcional)", type: "text" },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    { name: "color", label: "Color", type: "enum", enumValues: colors },
    { name: "stock", label: "Stock", type: "integer", required: true }, stockMin,
    { name: "fecha_revision", label: "Próxima revisión", type: "date" },
    { name: "coste_unitario", label: "Coste por unidad (€)", type: "number" }, center,
  ],
  columns: [
    { key: "codigo", label: "Código" },
    { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") },
    { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") },
    { key: "talla", label: "Talla", render: r => String(r.talla ?? "—") },
    { key: "color", label: "Color", render: r => r.color ? <><ColorSwatch color={String(r.color)} />{String(r.color)}</> : "—" },
    { key: "stock", label: "Stock", align: "right", render: r => stockCell(r, "stock") }, centerCol,
    { key: "fecha_revision", label: "Próxima revisión", render: revisionBadge },
    { key: "descripcion", label: "Descripción", render: r => String(r.descripcion ?? "—") },
  ],
};
export const ROPA: ResourceConfig = {
  title: "Ropa de trabajo", subtitle: "Prendas de los centros: alta visibilidad y manga larga", endpoint: "/api/ropa-trabajo", csvName: "ropa-trabajo", searchKeys: ["codigo", "prenda", "fabricante", "modelo", "color", "centro_nombre"], centroFilter: true, perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "codigo", label: "Código", type: "text", required: true },
    { name: "prenda", label: "Prenda", type: "text", required: true },
    { name: "marca", label: "Marca", type: "text" },
    { name: "fabricante", label: "Fabricante", type: "text" },
    { name: "modelo", label: "Modelo", type: "text" },
    { name: "talla", label: "Talla", type: "text" },
    { name: "alta_visibilidad", label: "Alta visibilidad", type: "boolean", required: true },
    { name: "manga_larga", label: "Manga larga", type: "boolean", required: true },
    { name: "descripcion", label: "Descripción", type: "textarea" },
    { name: "color", label: "Color", type: "enum", enumValues: colors },
    { name: "stock", label: "Stock", type: "integer", required: true }, stockMin,
    { name: "coste_unitario", label: "Coste por unidad (€)", type: "number" }, center,
  ],
  columns: [
    { key: "codigo", label: "Código" },
    { key: "prenda", label: "Prenda" },
    { key: "marca", label: "Marca", render: r => String(r.marca ?? "—") },
    { key: "fabricante", label: "Fabricante", render: r => String(r.fabricante ?? "—") },
    { key: "modelo", label: "Modelo", render: r => String(r.modelo ?? "—") },
    { key: "talla", label: "Talla", render: r => String(r.talla ?? "—") },
    { key: "alta_visibilidad", label: "A. visibilidad", render: r => Number(r.alta_visibilidad) === 1 ? <span className="badge warn">Sí</span> : <span className="badge muted">No</span> },
    { key: "manga_larga", label: "Manga larga", render: r => Number(r.manga_larga) === 1 ? <span className="badge info">Sí</span> : <span className="badge muted">No</span> },
    { key: "color", label: "Color", render: r => r.color ? <><ColorSwatch color={String(r.color)} />{String(r.color)}</> : "—" },
    { key: "stock", label: "Stock", align: "right", render: r => stockCell(r, "stock") }, centerCol,
  ],
};
export const TALLAS: ResourceConfig = {
  title: "Tallas de operarios", subtitle: "Operario · prenda · talla · notas", endpoint: "/api/tallas", csvName: "tallas-operarios", searchKeys: ["usuario_nombre", "usuario_username", "prenda", "talla"], perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: { usuario_id: { endpoint: "/api/usuarios", label: r => `${String(r.nombre)} (${String(r.username)})` } },
  fields: [
    { name: "usuario_id", label: "Operario", type: "select", required: true },
    { name: "prenda", label: "Prenda", type: "text", required: true, placeholder: "Ej. Chaqueta, Pantalón, Botas…" },
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
export const ENTREGAS: ResourceConfig = {
  title: "Entregas de ropa", subtitle: "Historial de ropa entregada a cada operario", endpoint: "/api/entregas", csvName: "entregas-ropa", searchKeys: ["usuario_nombre", "ropa_marca", "ropa_modelo", "ropa_talla", "ropa_prenda", "notas"], perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: {
    usuario_id: { endpoint: "/api/usuarios", label: r => `${String(r.nombre)} (${String(r.username)})` },
    ropa_id: { endpoint: "/api/ropa-trabajo", label: r => `${String(r.codigo)} · ${String(r.prenda)}` },
  },
  fields: [
    { name: "usuario_id", label: "Operario", type: "select", required: true },
    { name: "ropa_id", label: "Prenda de ropa", type: "select", required: true },
    { name: "cantidad", label: "Cantidad", type: "integer", required: true },
    { name: "fecha", label: "Fecha de entrega", type: "date", help: "En blanco, hoy" },
    { name: "notas", label: "Notas", type: "textarea" },
  ],
  columns: [
    { key: "fecha", label: "Fecha de entrega", render: r => formatFecha(String(r.fecha ?? "")) },
    { key: "usuario_nombre", label: "Operario", render: r => String(r.usuario_nombre ?? "—") },
    { key: "ropa_marca", label: "Marca", render: r => String(r.ropa_marca ?? "—") },
    { key: "ropa_modelo", label: "Modelo", render: r => String(r.ropa_modelo ?? "—") },
    { key: "ropa_talla", label: "Talla", render: r => String(r.ropa_talla ?? "—") },
    { key: "ropa_prenda", label: "Prenda", render: r => String(r.ropa_prenda ?? "—") },
    { key: "cantidad", label: "Cantidad", align: "right", render: r => formatNum(r.cantidad) },
    { key: "entregado_por_nombre", label: "Entregado por", render: r => String(r.entregado_por_nombre ?? "—") },
    { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") },
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
export const PUNTOS: ResourceConfig = {
  title: "Zonas de consumo", subtitle: "Puntos con QR por subzona; al escanear descuentan 1 unidad de su producto", endpoint: "/api/puntos-consumo", csvName: "puntos-consumo", searchKeys: ["nombre", "zona_nombre", "subzona_nombre", "producto_nombre", "centro_nombre"], centroFilter: true,
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" }, qrTipo: "punto",
  links: {
    producto: {
      endpoints: ["/api/quimicos", "/api/material-limpieza"],
      label: r => `${r._tipo === "quimicos" ? "Químico" : "Material"}: ${String(r.nombre)}`,
      value: r => `${String(r._tipo)}:${Number(r.id)}`,
    },
    subzona_id: { endpoint: "/api/subzonas", label: r => `${String(r.zona_nombre)} · ${String(r.nombre)} · ${String(r.centro_nombre ?? "—")}` },
  },
  fields: [
    { name: "nombre", label: "Nombre del punto", type: "text", required: true },
    center,
    { name: "subzona_id", label: "Subzona", type: "select" },
    { name: "producto", label: "Producto del punto", type: "select", required: true },
  ],
  columns: [
    { key: "nombre", label: "Punto" },
    { key: "zona_nombre", label: "Zona", render: r => String(r.zona_nombre ?? "—") },
    { key: "subzona_nombre", label: "Subzona", render: r => String(r.subzona_nombre ?? "—") },
    centerCol,
    { key: "producto_nombre", label: "Producto", render: r => String(r.producto_nombre ?? "—") },
    { key: "producto_stock", label: "Stock", align: "right", render: r => formatNum(r.producto_stock) },
  ],
};
export const MOVIMIENTOS: ResourceConfig = {
  title: "Auditoría de movimientos", subtitle: "Entradas, salidas, consumos y entregas con coste y motivo", endpoint: "/api/movimientos", csvName: "movimientos", searchKeys: ["usuario_nombre", "accion", "descripcion", "motivo"], readOnlyPage: true,
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [],
  columns: [
    { key: "created_at", label: "Fecha y hora", render: r => String(r.created_at ?? "—").replace("T", " ").slice(0, 16) },
    { key: "usuario_nombre", label: "Usuario", render: r => String(r.usuario_nombre ?? "—") },
    { key: "accion", label: "Tipo de movimiento", render: r => <span className={`badge ${String(r.accion ?? "").startsWith("consumo") ? "info" : String(r.accion) === "entrada" ? "ok" : "warn"}`}>{String(r.accion ?? "—").replaceAll("_", " ")}</span> },
    { key: "descripcion", label: "Detalle", render: r => String(r.descripcion ?? "—") },
    { key: "cantidad", label: "Cant.", align: "right", render: r => r.cantidad == null ? "—" : formatNum(r.cantidad) },
    { key: "coste", label: "Coste (€)", align: "right", render: r => r.coste == null ? "—" : formatNum(Number(r.coste), 2) },
    { key: "motivo", label: "Motivo", render: r => String(r.motivo ?? "—") },
  ],
};
export const ZONAS: ResourceConfig = {
  title: "Zonas y subzonas", subtitle: "Zonas de cada centro (gestiona las subzonas en su pestaña)", endpoint: "/api/zonas", csvName: "zonas", searchKeys: ["nombre", "centro_nombre", "notas"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  fields: [
    { name: "centro_id", label: "Centro", type: "select", required: true },
    { name: "nombre", label: "Nombre de la zona", type: "text", required: true },
    { name: "notas", label: "Notas", type: "textarea" },
  ],
  columns: [
    { key: "nombre", label: "Zona" },
    centerCol,
    { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") },
  ],
};
export const SUBZONAS: ResourceConfig = {
  title: "Subzonas", subtitle: "Subzona de cada zona", endpoint: "/api/subzonas", csvName: "subzonas", searchKeys: ["nombre", "zona_nombre", "centro_nombre"],
  perms: { read: "all", create: "admin", update: "admin", delete: "admin" },
  links: { zona_id: { endpoint: "/api/zonas", label: r => `${String(r.nombre)} · ${String(r.centro_nombre ?? "—")}` } },
  fields: [
    { name: "zona_id", label: "Zona", type: "select", required: true },
    { name: "nombre", label: "Nombre de la subzona", type: "text", required: true },
    { name: "notas", label: "Notas", type: "textarea" },
  ],
  columns: [
    { key: "nombre", label: "Subzona" },
    { key: "zona_nombre", label: "Zona", render: r => String(r.zona_nombre ?? "—") },
    centerCol,
    { key: "notas", label: "Notas", render: r => String(r.notas ?? "—") },
  ],
};
// Botones de asignación de centros a un usuario: cada clic guarda al momento
// (sin botón de «aplicar»). Los administradores no llevan centro.
function CentrosCell({ centros, initial, userId, editable }: { centros: Row[]; initial: string; userId: number; editable: boolean }) {
  const [sel, setSel] = useState<Set<number>>(() => new Set(initial.split(",").filter(Boolean).map(Number)));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = async (id: number) => {
    if (!editable || busy) return;
    const next = new Set(sel);
    if (next.has(id)) next.delete(id); else next.add(id);
    setBusy(true); setErr(null);
    try { await api.put(`/api/usuarios/${userId}/centros`, { centros: [...next] }); setSel(next); }
    catch (e) { setErr(e instanceof Error ? e.message : "No se pudo guardar"); }
    finally { setBusy(false); }
  };
  if (!editable) return <span style={{ color: "var(--muted)" }}>{sel.size ? `${sel.size} centro${sel.size > 1 ? "s" : ""}` : "—"}</span>;
  return <div className="centros-toggle">
    {centros.map((cn) => <button key={String(cn.id)} className={"chip" + (sel.has(Number(cn.id)) ? " on" : "")} disabled={busy} onClick={() => void toggle(Number(cn.id))}>{String(cn.nombre)}</button>)}
    {err && <span className="chip err">{err}</span>}
  </div>;
}

export function ResourcePage({ config, user }: { config: ResourceConfig; user: { rol: string } }) {
  const [items, setItems] = useState<Row[]>([]), [centros, setCentros] = useState<Row[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [q, setQ] = useState(""), [centroId, setCentroId] = useState("all"), [editing, setEditing] = useState<{ mode: "create" | "edit"; values: Row } | null>(null), [formError, setFormError] = useState<string | null>(null), [saving, setSaving] = useState(false), [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null), [linkRows, setLinkRows] = useState<Record<string, Row[]>>({}), [qrRow, setQrRow] = useState<Row | null>(null);
  const canCreate = !config.readOnlyPage && allow(user.rol, config.perms.create), canUpdate = !config.readOnlyPage && allow(user.rol, config.perms.update), canDelete = !config.readOnlyPage && allow(user.rol, config.perms.delete);
  const load = useCallback(async () => { setLoading(true); setError(null); try { setItems((await api.get<{ items: Row[] }>(config.endpoint)).items); } catch (e) { setError(e instanceof Error ? e.message : "Error cargando los datos"); } finally { setLoading(false); } }, [config.endpoint]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (config.centroFilter || config.fields.some(f => f.name === "centro_id")) api.get<{ items: Row[] }>("/api/centros").then(r => setCentros(r.items)).catch(() => setCentros([])); }, [config]);
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
  const filtered = useMemo(() => { const needle = q.trim().toLowerCase(); return items.filter(row => (centroId === "all" || String(row.centro_id ?? "") === centroId) && (!needle || config.searchKeys.some(k => String(row[k] ?? "").toLowerCase().includes(needle)))); }, [items, q, centroId, config]);
  if (config.perms.read === "admin" && user.rol !== "admin") return <div className="card empty"><span className="icon">🔒</span><strong>Sección restringida</strong><p>Solo los administradores pueden gestionar los usuarios.</p></div>;
  const fields: FieldDef[] = config.fields.map(f => {
    if (f.name === "centro_id") return { ...f, options: centros.map(c => ({ value: Number(c.id), label: String(c.nombre) })) };
    const link = config.links?.[f.name];
    return link ? { ...f, options: (linkRows[f.name] ?? []).map(r => ({ value: link.value ? link.value(r) : Number(r.id), label: link.label(r) })) } : f;
  });
  const openCreate = () => { const values: Row = {}; for (const f of config.fields) values[f.name] = f.type === "boolean" ? true : ""; setFormError(null); setEditing({ mode: "create", values }); };
  const openEdit = (row: Row) => { const values: Row = { id: row.id, tiene_foto: row.tiene_foto }; for (const f of config.fields) { if (f.type === "image") continue; values[f.name] = f.name === "password" ? "" : row[f.name] ?? (f.type === "boolean" ? false : ""); } setFormError(null); setEditing({ mode: "edit", values }); };
  const save = async () => { if (!editing) return; setSaving(true); setFormError(null); const payload: Row = {}; for (const f of config.fields) { if (f.type === "image" && !(f.name in editing.values)) continue; let v = editing.values[f.name]; if (f.type === "number" || f.type === "integer") v = v === "" || v == null ? null : Number(String(v).replace(",", ".")); if (f.type === "boolean") v = v === true || v === 1 ? 1 : 0; payload[f.name] = v ?? null; } try { if (editing.mode === "create") await api.post(config.endpoint, payload); else await api.put(`${config.endpoint}/${String(editing.values.id)}`, payload); setEditing(null); setToast({ message: "Cambios guardados", kind: "ok" }); await load(); } catch (e) { setFormError(e instanceof Error ? e.message : "No se pudo guardar el registro"); } finally { setSaving(false); } };
  const remove = async (row: Row) => { if (!window.confirm(`¿Eliminar "${String(row.nombre ?? row.username ?? row.id)}"? Esta acción no se puede deshacer.`)) return; try { await api.del(`${config.endpoint}/${String(row.id)}`); setToast({ message: "Registro eliminado", kind: "ok" }); await load(); } catch (e) { setToast({ message: e instanceof Error ? e.message : "No se pudo eliminar", kind: "error" }); } };
  const exportCsv = () => { const stamp = new Date().toISOString().slice(0, 10); downloadCsv(`${config.csvName}-${stamp}.csv`, config.columns.map(c => c.label), filtered.map(row => config.columns.map(c => c.csv ? c.csv(row) : String(row[c.key] ?? "")))); };
  return <><div className="toolbar no-print"><input className="input" style={{ maxWidth: 260 }} placeholder="🔍 Buscar…" value={q} onChange={e => setQ(e.target.value)} />{(config.centroFilter || config.fields.some(f => f.name === "centro_id")) && <select className="input" style={{ maxWidth: 220 }} value={centroId} onChange={e => setCentroId(e.target.value)}><option value="all">Todos los centros</option>{centros.map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}</select>}<div className="spacer"/><button className="btn secondary" onClick={exportCsv} disabled={!filtered.length}>⬇️ CSV</button>{canCreate && <button className="btn" onClick={openCreate}>＋ Nuevo registro</button>}</div>
  <div className="card">{loading?<div className="loading">Cargando…</div>:error?<div className="empty">⚠️ {error}</div>:!filtered.length?<div className="empty"><span className="icon">📭</span><strong>No hay registros</strong><p>{q||centroId!=="all"?"Prueba con otra búsqueda u otro centro.":"Pulsa «Nuevo registro» para añadir el primero."}</p></div>:<div className="table-scroll"><table><thead><tr>{config.columns.map(c=><th key={c.key} className={c.align==="right"?"right":""}>{c.label}</th>)}{config.centrosToggle&&<th>Asignar centros</th>}{(canUpdate||canDelete||config.qrTipo)&&<th className="right">Acciones</th>}</tr></thead><tbody>{filtered.map(row=><tr key={String(row.id)}>{config.columns.map(c=><td key={c.key} className={c.align==="right"?"right":""}>{c.render?c.render(row):String(row[c.key]??"—")}</td>)}{config.centrosToggle&&<td><CentrosCell centros={centros} initial={String(row.centros_ids??"")} userId={Number(row.id)} editable={user.rol==="admin"&&row.rol!=="admin"}/></td>}{(canUpdate||canDelete||config.qrTipo)&&<td className="right"><div className="row-actions">{config.qrTipo&&<button className="btn secondary small" onClick={()=>setQrRow(row)}>🏷️ QR</button>}{canUpdate&&<button className="btn secondary small" onClick={()=>openEdit(row)}>✏️ Editar</button>}{canDelete&&<button className="btn danger small" onClick={()=>void remove(row)}>🗑️ Borrar</button>}</div></td>}</tr>)}</tbody></table></div>}</div>
  <p className="no-print" style={{color:"var(--muted)",margin:0}}>{filtered.length} de {items.length} registros · {config.subtitle}</p>{qrRow&&config.qrTipo&&<QrModal tipo={config.qrTipo} id={Number(qrRow.id)} title={String(qrRow.nombre ?? qrRow.prenda ?? qrRow.numero_lote ?? qrRow.id)} onClose={()=>setQrRow(null)}/>}
  {editing&&<Modal title={editing.mode==="create"?`Nuevo registro · ${config.title}`:`Editar · ${config.title}`} subtitle={config.subtitle} onClose={()=>setEditing(null)}>{formError&&<div className="form-error">{formError}</div>}<div className="form-grid">{fields.map(f=><div key={f.name} className={f.type==="textarea"||f.type==="image"?"full":""}><Field def={editing.mode==="edit"&&f.type==="image"?{...f,hasExisting:Boolean(editing.values.tiene_foto),previewUrl:`${config.endpoint}/${String(editing.values.id)}/foto`}:f} value={editing.values[f.name]} onChange={v=>setEditing({...editing,values:{...editing.values,[f.name]:v}})}/></div>)}</div><div className="modal-footer"><button className="btn secondary" onClick={()=>setEditing(null)}>Cancelar</button><button className="btn" onClick={()=>void save()} disabled={saving}>{saving?"Guardando…":"Guardar"}</button></div></Modal>}{toast&&<Toast message={toast.message} kind={toast.kind} onClose={()=>setToast(null)}/>}</>;
}
