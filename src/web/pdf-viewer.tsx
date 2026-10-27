/** Lector de PDF integrado («hoja a hoja»): se abre en un modal de la propia
 *  aplicación para leer un documento sin salir de ella ni descargarlo.
 *
 *  El PDF se pinta en un <canvas> con pdf.js: el contenido del documento no se
 *  inyecta como HTML (solo se dibuja en el lienzo, sin ejecutar su JavaScript),
 *  y el worker de pdf.js se sirve desde el mismo origen (lo empaqueta Vite),
 *  sin dependencias de CDNs externas. Si el navegador bloquea la carga (p. ej.
 *  un PDF de otro dominio sin CORS), se ofrece abrirlo en una pestaña como
 *  vía de escape. */

import { useCallback, useEffect, useRef, useState } from "react";
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// Worker de pdf.js servido por Vite desde el mismo origen.
GlobalWorkerOptions.workerSrc = workerUrl;

/** Documento ya cargado (PDFDocumentProxy, derivado del tipo de getDocument). */
type Doc = Awaited<ReturnType<typeof getDocument>["promise"]>;
/** Mínimo estructural de la tarea de renderizado (cancelable). */
type RenderTaskLike = { promise: Promise<void>; cancel: () => void };

interface PdfViewerProps {
  /** URL del PDF (misma origen o externa). */
  src: string;
  /** Título que se muestra en la barra del lector. */
  title: string;
  /** Cierra el lector y vuelve a la pantalla anterior. */
  onClose: () => void;
}

/** Modal a pantalla completa con navegación por hojas (← →), zoom y cierre (Esc). */
export default function PdfViewer({ src, title, onClose }: PdfViewerProps) {
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<Doc | null>(null);
  const taskRef = useRef<{ destroy: () => Promise<void> } | null>(null);
  const renderRef = useRef<RenderTaskLike | null>(null);

  // Carga del documento: se destruye al cambiar de PDF o al cerrar el modal.
  useEffect(() => {
    let vivo = true;
    setCargando(true);
    setError(null);
    setNumPages(0);
    setPage(1);
    const task = getDocument({ url: src });
    taskRef.current = task;
    task.promise
      .then((doc) => {
        // Si el modal ya se cerró, la limpieza destruye la tarea (y con ella
        // el documento); no hace falta tocar `doc` aquí.
        if (!vivo) return;
        docRef.current = doc;
        setNumPages(doc.numPages);
        setCargando(false);
      })
      .catch((e: unknown) => {
        if (!vivo) return;
        setError(e instanceof Error ? e.message : "No se pudo abrir el PDF");
        setCargando(false);
      });
    return () => {
      vivo = false;
      renderRef.current?.cancel();
      renderRef.current = null;
      docRef.current = null;
      const t = taskRef.current;
      taskRef.current = null;
      // Destruir la tarea de carga libera el documento y el worker de pdf.js.
      if (t) void t.destroy().catch(() => { /* ya destruido */ });
    };
  }, [src]);

  // Pinta la hoja actual: encaja el ancho de la página en el contenedor y
  // multiplica por el zoom y la densidad de píxeles de la pantalla.
  const renderPagina = useCallback(async (num: number) => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas) return;
    const stage = canvas.parentElement;
    try {
      renderRef.current?.cancel();
      const p = await doc.getPage(num);
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const base = p.getViewport({ scale: 1 });
      const encaje = stage && base.width > 0 ? Math.min(1.6, (stage.clientWidth - 44) / base.width) : 1;
      const viewport = p.getViewport({ scale: Math.max(0.2, encaje * zoom) * dpr });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
      canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const task = p.render({ canvas, canvasContext: ctx, viewport }) as unknown as RenderTaskLike;
      renderRef.current = task;
      await task.promise;
    } catch (e: unknown) {
      // Cancelaciones al cambiar de hoja rápido: se ignoran.
      if (e instanceof Error && (e.name === "RenderingCancelledException" || e.name === "AbortException")) return;
      setError(e instanceof Error ? e.message : "No se pudo mostrar la hoja");
    }
  }, [zoom]);

  // Repinta al cambiar de hoja, de zoom o al terminar la carga.
  useEffect(() => {
    if (cargando || error || !numPages) return;
    void renderPagina(Math.min(Math.max(page, 1), numPages));
  }, [cargando, error, numPages, page, renderPagina]);

  // Vuelve a encajar la hoja si cambia el tamaño de la ventana.
  useEffect(() => {
    if (cargando) return;
    let t: number | undefined;
    const onResize = () => {
      window.clearTimeout(t);
      t = window.setTimeout(() => void renderPagina(page), 150);
    };
    window.addEventListener("resize", onResize);
    return () => { window.removeEventListener("resize", onResize); window.clearTimeout(t); };
  }, [cargando, page, renderPagina]);

  // Navegación con teclado: ←/→ (o PgUp/PgDn) pasan hoja, Esc cierra.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      // Dentro del campo de número se respeta el comportamiento nativo.
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === "ArrowRight" || e.key === "PageDown") {
        e.preventDefault();
        setPage((p) => Math.min(p + 1, Math.max(numPages, 1)));
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        setPage((p) => Math.max(p - 1, 1));
      } else if (e.key === "Home") {
        setPage(1);
      } else if (e.key === "End" && numPages) {
        setPage(numPages);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numPages, onClose]);

  // El modal tapa la página: evita que el fondo siga haciendo scroll.
  useEffect(() => {
    const previo = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previo; };
  }, []);

  return (
    <div className="pdf-overlay" role="dialog" aria-modal="true" aria-label={`Lector de PDF: ${title}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="pdf-head">
        <span className="pdf-title" title={title}>📘 {title}</span>
        <div className="pdf-nav">
          <button className="pdf-btn" onClick={() => setPage((p) => Math.max(p - 1, 1))}
            disabled={cargando || page <= 1} aria-label="Hoja anterior">‹</button>
          <span className="pdf-page-ind">
            Hoja{" "}
            <input className="pdf-page-input" type="number" min={1} max={numPages || 1} value={page}
              aria-label="Número de hoja"
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setPage(Math.min(Math.max(Math.trunc(n), 1), numPages || 1));
              }} />{" "}
            de {numPages || "…"}
          </span>
          <button className="pdf-btn" onClick={() => setPage((p) => Math.min(p + 1, numPages))}
            disabled={cargando || !numPages || page >= numPages} aria-label="Hoja siguiente">›</button>
          <button className="pdf-btn" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.15) * 100) / 100))}
            disabled={cargando || zoom <= 0.5} aria-label="Alejar">−</button>
          <span className="pdf-page-ind">{Math.round(zoom * 100)}%</span>
          <button className="pdf-btn" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.15) * 100) / 100))}
            disabled={cargando || zoom >= 3} aria-label="Acercar">＋</button>
          <button className="pdf-btn" onClick={onClose} aria-label="Cerrar lector">✕ Cerrar</button>
        </div>
      </div>

      <div className="pdf-stage">
        {cargando && <div className="pdf-msg">Cargando documento…</div>}
        {error && (
          <div className="pdf-msg">
            <strong>⚠️ No se pudo mostrar el PDF aquí.</strong>
            <span className="pdf-msg-det">{error}</span>
            <a className="pdf-btn" href={src} target="_blank" rel="noreferrer">↗ Abrir en una pestaña</a>
          </div>
        )}
        {!cargando && !error && numPages > 0 && <canvas ref={canvasRef} />}
      </div>

      <div className="pdf-hint">Hoja a hoja con ← → · Esc para cerrar · el documento no sale de la aplicación</div>
    </div>
  );
}
