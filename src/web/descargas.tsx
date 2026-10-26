import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { CENTROS, EPIS, MAQUINARIA, MATERIAL, MOVIMIENTOS, QUIMICOS, ROPA, USUARIOS, type ResourceConfig } from "./resources";
import { Toast, downloadCsv, formatNum } from "./ui";

type Row = Record<string, unknown>;

// Columnas de las hojas que no tienen un ResourceConfig propio.
interface Columna { key: string; label: string; csv?: (r: Row) => string | number }

interface Hoja {
  id: string;
  icono: string;
  nombre: string;
  descripcion: string;
  endpoint: string;
  csvName: string;
  /** Hoja con ResourceConfig: sus columnas (y su CSV) son las de la ficha. */
  config?: ResourceConfig;
  columns?: Columna[];
  /** El filtro por centro lo aplica el servidor con ?centro_id=. */
  filtroServidor?: boolean;
  /** Hojas sin columna centro_id: el filtro se aplica en el navegador. */
  filtroCliente?: (r: Row, centroId: number) => boolean;
  /** Registro global: no admite filtro por centro. */
  global?: boolean;
}

// Cada hoja es una tabla de la aplicación, lista para descargar en CSV.
const HOJAS: Hoja[] = [
  { id: "quimicos", icono: "🧪", nombre: "Productos químicos", csvName: "quimicos",
    descripcion: "Ficha de cada producto: código, marca, litros por garrafa, stock mínimo, estado y centro.", endpoint: "/api/quimicos", filtroServidor: true, config: QUIMICOS },
  { id: "material", icono: "🧽", nombre: "Material de limpieza", csvName: "material-limpieza",
    descripcion: "Referencias por color, unidades y origen.", endpoint: "/api/material-limpieza", filtroServidor: true, config: MATERIAL },
  { id: "maquinaria", icono: "🧭", nombre: "Maquinaria", csvName: "maquinaria",
    descripcion: "Máquinas con su tipo, ubicación y estado actual.", endpoint: "/api/maquinaria", filtroServidor: true, config: MAQUINARIA },
  { id: "epis", icono: "🦺", nombre: "EPIs", csvName: "epis",
    descripcion: "Equipos de protección con stock y próxima revisión.", endpoint: "/api/epis", filtroServidor: true, config: EPIS },
  { id: "ropa", icono: "🥼", nombre: "Ropa de trabajo", csvName: "ropa-trabajo",
    descripcion: "Prendas con talla, características y stock.", endpoint: "/api/ropa-trabajo", filtroServidor: true, config: ROPA },
  { id: "estaciones", icono: "🚻", nombre: "Estaciones de consumo", csvName: "estaciones",
    descripcion: "Estaciones QR con su zona, soporte y artículo asociado.", endpoint: "/api/estaciones", filtroServidor: true,
    columns: [
      { key: "id", label: "Id" },
      { key: "centro_nombre", label: "Centro" },
      { key: "zona_nombre", label: "Zona" },
      { key: "subzona_nombre", label: "Subzona" },
      { key: "soporte_nombre", label: "Soporte" },
      { key: "tipo_nombre", label: "Tipo de consumible" },
      { key: "articulo_tipo", label: "Tipo de artículo" },
      { key: "articulo_nombre", label: "Artículo" },
      { key: "articulo_codigo", label: "Código" },
      { key: "articulo_stock", label: "Stock" },
      { key: "activo", label: "Activa", csv: r => Number(r.activo) === 1 ? "Sí" : "No" },
    ] },
  { id: "entradas", icono: "🔄", nombre: "Entradas y salidas", csvName: "movimientos",
    descripcion: "Consumos, entradas, salidas y ajustes con su autor y motivo. Registro global de la aplicación.",
    endpoint: "/api/movimientos", global: true, config: MOVIMIENTOS },
  { id: "entregas", icono: "📦", nombre: "Entregas de equipación", csvName: "entregas",
    descripcion: "Prendas y EPIs entregados a cada operario.", endpoint: "/api/ropa-entregas", filtroServidor: true,
    columns: [
      { key: "fecha", label: "Fecha" },
      { key: "usuario_nombre", label: "Operario" },
      { key: "usuario_username", label: "Login" },
      { key: "centro_nombre", label: "Centro" },
      { key: "prenda", label: "Prenda" },
      { key: "articulo_tipo", label: "Tipo de artículo" },
      { key: "cantidad", label: "Cantidad" },
      { key: "talla", label: "Talla" },
      { key: "color", label: "Color" },
      { key: "alta_visibilidad", label: "Alta visibilidad", csv: r => Number(r.alta_visibilidad) === 1 ? "Sí" : "No" },
      { key: "manga_larga", label: "Manga larga", csv: r => Number(r.manga_larga) === 1 ? "Sí" : "No" },
    ] },
  { id: "zonas", icono: "🗺️", nombre: "Zonas", csvName: "zonas",
    descripcion: "Zonas de cada planta donde están las estaciones.", endpoint: "/api/zonas", filtroServidor: true,
    columns: [
      { key: "centro_nombre", label: "Centro" },
      { key: "nombre", label: "Zona" },
      { key: "notas", label: "Notas" },
    ] },
  { id: "subzonas", icono: "🧱", nombre: "Subzonas", csvName: "subzonas",
    descripcion: "Subzonas de cada zona (el centro se aplica sobre la zona que las contiene).", endpoint: "/api/subzonas",
    filtroCliente: (r, centroId) => Number(r.zona_centro_id) === centroId,
    columns: [
      { key: "centro_nombre", label: "Centro" },
      { key: "zona_nombre", label: "Zona" },
      { key: "nombre", label: "Subzona" },
      { key: "notas", label: "Notas" },
    ] },
  { id: "documentos", icono: "📚", nombre: "Documentación", csvName: "documentos",
    descripcion: "Fichas de seguridad, técnicas y manuales con su URL.", endpoint: "/api/documentos", filtroServidor: true,
    columns: [
      { key: "nombre", label: "Documento" },
      { key: "tipo_nombre", label: "Tipo" },
      { key: "fabricante", label: "Fabricante" },
      { key: "descripcion", label: "Descripción" },
      { key: "url", label: "URL" },
      { key: "centros_nombre", label: "Centros" },
    ] },
  { id: "usuarios", icono: "👥", nombre: "Usuarios", csvName: "usuarios",
    descripcion: "Cuentas con su rol y sus centros asignados.",
    endpoint: "/api/usuarios", config: USUARIOS,
    filtroCliente: (r, centroId) => String(r.centros_ids ?? "").split(",").filter(Boolean).map(Number).includes(centroId) },
  { id: "centros", icono: "🏙️", nombre: "Centros", csvName: "centros",
    descripcion: "Plantas con dirección, ciudad y responsable.", endpoint: "/api/centros", config: CENTROS },
];

const slug = (s: string): string => s.toLowerCase().trim().replace(/[^\wáéíóúñü]+/g, "-").replace(/^-+|-+$/g, "");

/** «Copias de seguridad» (solo administradores): descarga hoja por hoja la
 *  información introducida, filtrada por centro. El CSV se genera en el propio
 *  navegador y se guarda en el ordenador: la aplicación no crea ninguna copia
 *  en la nube. */
export function DescargasPage() {
  const [centros, setCentros] = useState<Row[]>([]);
  const [centroId, setCentroId] = useState("all");
  const [conteos, setConteos] = useState<Record<string, number | null>>({});
  const [descargando, setDescargando] = useState<string | null>(null);
  const [cargandoConteos, setCargandoConteos] = useState(true);
  const [toast, setToast] = useState<{ message: string; kind: "ok" | "error" } | null>(null);

  useEffect(() => {
    api.get<{ items: Row[] }>("/api/centros").then(r => setCentros(r.items)).catch(() => setCentros([]));
  }, []);

  // Filas de una hoja ya aplicando el filtro de centro elegido.
  const cargar = useCallback(async (h: Hoja): Promise<Row[]> => {
    const qs = h.filtroServidor && centroId !== "all" ? `?centro_id=${centroId}` : "";
    const r = await api.get<{ items: Row[] }>(`${h.endpoint}${qs}`);
    // Misma selección de filas que en su pestaña (p. ej. una fila por producto).
    const items = h.config?.preFilter ? h.config.preFilter(r.items) : r.items;
    if (h.filtroCliente && centroId !== "all") return items.filter(x => h.filtroCliente!(x, Number(centroId)));
    return items;
  }, [centroId]);

  // Recuento de cada hoja (respeta el filtro de centro seleccionado).
  useEffect(() => {
    let vivo = true;
    setCargandoConteos(true);
    Promise.all(HOJAS.map(async (h): Promise<[string, number | null]> => {
      try { return [h.id, (await cargar(h)).length]; } catch { return [h.id, null]; }
    })).then(entries => {
      if (!vivo) return;
      setConteos(Object.fromEntries(entries));
      setCargandoConteos(false);
    });
    return () => { vivo = false; };
  }, [cargar]);

  const descargar = async (h: Hoja) => {
    setDescargando(h.id);
    try {
      const items = await cargar(h);
      const columnas = (h.config ? h.config.columns : h.columns ?? [])
        .filter(c => c.key !== "foto" && c.key !== "tiene_foto");
      const nombreCentro = centroId === "all"
        ? "todos-los-centros"
        : slug(String(centros.find(c => String(c.id) === centroId)?.nombre ?? "centro"));
      downloadCsv(`${h.csvName}-${nombreCentro}-${new Date().toISOString().slice(0, 10)}.csv`,
        columnas.map(c => c.label),
        items.map(row => columnas.map(c => c.csv ? c.csv(row) : String(row[c.key] ?? ""))));
      setToast({
        message: `${h.nombre}: ${formatNum(items.length)} registros descargados en tu ordenador`,
        kind: "ok",
      });
    } catch (e) {
      setToast({ message: e instanceof Error ? e.message : `No se pudo descargar ${h.nombre}`, kind: "error" });
    } finally {
      setDescargando(null);
    }
  };

  const centroNombre = centroId === "all" ? "todos los centros" : String(centros.find(c => String(c.id) === centroId)?.nombre ?? "");

  return <>
    <div className="card card-pad">
      <div className="section-head">
        <h3>💾 Copias de seguridad</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          Descarga directa a tu ordenador · sin copias en la nube
        </span>
      </div>
      <p style={{ color: "var(--muted)", margin: "0 0 4px" }}>
        Cada hoja se genera como <strong>CSV</strong> (compatible con Excel, separador «;») <strong>en tu propio
        navegador</strong> y se guarda en la carpeta de descargas de tu equipo: la aplicación no almacena ninguna
        copia de lo que descargues.
      </p>
      <ul style={{ margin: 0, paddingLeft: 20, color: "var(--muted)", fontSize: 13, lineHeight: 1.7 }}>
        <li><strong>Descargas de esta página</strong>: van a tu ordenador, hoja por hoja y filtradas por centro.</li>
        <li><strong>Copia completa de la base de datos</strong>: se hace desde el servidor con
          <code> sh ./scripts/backup-d1.sh</code> y queda guardada en la carpeta local <code>backups/</code> del
          proyecto (no se sube a la nube ni a git).</li>
      </ul>
    </div>

    <div className="toolbar no-print">
      <label htmlFor="copias-centro" style={{ fontWeight: 600 }}>Centro / planta:</label>
      <select id="copias-centro" className="input" style={{ maxWidth: 240 }} value={centroId} onChange={e => setCentroId(e.target.value)}>
        <option value="all">Todos los centros</option>
        {centros.map(c => <option key={String(c.id)} value={String(c.id)}>{String(c.nombre)}</option>)}
      </select>
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        Información de <strong>{centroNombre}</strong>
      </span>
    </div>

    <div className="ayuda-grid">
      {HOJAS.map(h => {
        const n = conteos[h.id];
        const sinCentro = h.global;
        return <div key={h.id} className="card card-pad ayuda-card">
          <div className="ayuda-head">
            <span className="ayuda-icono" aria-hidden="true">{h.icono}</span>
            <div style={{ flex: 1 }}>
              <h3>{h.nombre}</h3>
              <span className="badge info">
                {cargandoConteos ? "Calculando…" : n == null ? "Sin recuento" : `${formatNum(n)} registro${n === 1 ? "" : "s"}`}
              </span>{" "}
              <span className="badge muted">CSV</span>
              {sinCentro && <span className="badge warn">Global</span>}
            </div>
          </div>
          <p className="ayuda-resumen">{h.descripcion}</p>
          {sinCentro && <p className="ayuda-resumen" style={{ fontSize: 12 }}>
            Esta hoja no se filtra por centro: es el registro global de todos los centros.
          </p>}
          <div className="ayuda-acciones">
            <button className="btn" onClick={() => void descargar(h)} disabled={descargando === h.id}>
              {descargando === h.id ? "Generando…" : "⬇️ Descargar CSV"}
            </button>
          </div>
        </div>;
      })}
    </div>

    {toast && <Toast message={toast.message} kind={toast.kind} onClose={() => setToast(null)} />}
  </>;
}
