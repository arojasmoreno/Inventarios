import { useCallback, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { api } from "./api";
import { Modal, formatNum } from "./ui";

type Row = Record<string, unknown>;

export function qrContent(tipo: string, id: number): string {
  return `${window.location.origin}/#/consumo?tipo=${tipo}&id=${id}`;
}

/** Modal con el QR del artículo, listo para imprimir y pegar en el puesto. */
export function QrModal({ tipo, id, title, onClose }: { tipo: string; id: number; title: string; onClose: () => void }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const url = qrContent(tipo, id);
  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: "#0f172a", light: "#ffffff" } })
      .then((d) => { if (alive) setDataUrl(d); })
      .catch(() => { if (alive) setError("No se pudo generar el código QR"); });
    return () => { alive = false; };
  }, [url]);
  return <Modal title="Código QR" subtitle={title} onClose={onClose}>
    {error && <div className="form-error">{error}</div>}
    {dataUrl
      ? <div className="qr-wrap"><img src={dataUrl} alt="Código QR" />
          <p className="qr-url">{url}</p>
          <p className="qr-help">Pega esta etiqueta en el puesto de consumo: al escanearla se abrirá el formulario de descuento de stock.</p>
          <button className="btn secondary" onClick={() => window.print()}>🖨️ Imprimir etiqueta</button>
        </div>
      : <div className="loading">Generando QR…</div>}
  </Modal>;
}

type Detector = { detect: (v: HTMLVideoElement) => Promise<Array<{ rawValue: string }>> };
type BarcodeDetectorCtor = new (o: { formats: string[] }) => Detector;

/** Página de consumo: escanea el QR del puesto (o pega el enlace) y descuenta stock. */
export function ConsumoPage({ user }: { user: { rol: string } }) {
  const [tipo, setTipo] = useState<string>("quimicos");
  const [manual, setManual] = useState("");
  const [item, setItem] = useState<Row | null>(null);
  const [cantidad, setCantidad] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  void user; // cualquier usuario autenticado puede descontar consumibles

  const loadItem = useCallback(async (t: string, id: number) => {
    setError(null); setItem(null);
    const endpoint = t === "quimicos" ? "/api/quimicos" : t === "material_limpieza" ? "/api/material-limpieza" : "/api/puntos-consumo";
    try { const r = await api.get<{ item: Row }>(`${endpoint}/${id}`); setItem(r.item); }
    catch (e) { setError(e instanceof Error ? e.message : "Consumible no encontrado"); }
  }, []);

  // Al llegar con QR preseleccionado (cámara del móvil al escanear la etiqueta).
  useEffect(() => {
    const m = /tipo=([^&]+)&id=(\d+)/.exec(window.location.hash);
    if (m) {
      const raw = decodeURIComponent(m[1]);
      const t = raw === "material_limpieza" || raw === "punto" ? raw : "quimicos";
      setTipo(t); void loadItem(t, Number(m[2]));
    }
  }, [loadItem]);

  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null; setScanning(false);
  }, []);
  useEffect(() => () => { streamRef.current?.getTracks().forEach((t) => t.stop()); }, []);

  const handleCode = (raw: string) => {
    const m = /tipo=([^&]+)&id=(\d+)/.exec(raw);
    if (!m) { setError("Ese QR no contiene un enlace de consumo válido"); return; }
    const val = decodeURIComponent(m[1]);
    const t = val === "material_limpieza" || val === "punto" ? val : "quimicos";
    setTipo(t); setManual(raw); void loadItem(t, Number(m[2]));
  };

  const startScan = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Este navegador no permite acceder a la cámara; introduce el enlace del QR a mano.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream; setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play();
      const Ctor = (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
      if (Ctor) {
        const detector = new Ctor({ formats: ["qr_code"] });
        const tick = async () => {
          if (!streamRef.current) return;
          try {
            const found = await detector.detect(video);
            if (found.length) { handleCode(found[0].rawValue); stopScan(); return; }
          } catch { /* fotograma aún no analizable */ }
          window.setTimeout(() => { void tick(); }, 300);
        };
        void tick();
      } else {
        // Fallback p.ej. iPhone/Safari: decodifica los fotogramas con jsQR.
        const canvas = document.createElement("canvas"), ctx = canvas.getContext("2d", { willReadFrequently: true });
        const tickJs = () => {
          if (!streamRef.current) return;
          if (video.readyState >= 2 && video.videoWidth > 0) {
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            ctx?.drawImage(video, 0, 0);
            const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
            if (img) { const code = jsQR(img.data, img.width, img.height); if (code?.data) { handleCode(code.data); stopScan(); return; } }
          }
          window.setTimeout(tickJs, 250);
        };
        tickJs();
      }
    } catch { setError("No se pudo acceder a la cámara"); stopScan(); }
  };

  const deduct = async () => {
    if (!item) return;
    setBusy(true); setError(null); setMsg(null);
    try {
      const url = tipo === "punto" ? `/api/puntos-consumo/${String(item.id)}/consumir` : "/api/consumo";
      const body = tipo === "punto" ? { cantidad: Number(cantidad) } : { tipo, id: Number(item.id), cantidad: Number(cantidad) };
      const r = await api.post<{ mensaje?: string }>(url, body);
      setMsg({ message: r.mensaje ?? "Stock descontado", kind: "ok" });
      await loadItem(tipo, Number(item.id));
    } catch (e) { setMsg({ message: e instanceof Error ? e.message : "No se pudo descontar el stock", kind: "error" }); }
    finally { setBusy(false); }
  };

  const stockLabel = tipo === "quimicos" ? "garrafas" : "unidades";
  return <div className="card card-pad" style={{ maxWidth: 680 }}>
    <div className="section-head"><h3>Consumo por QR</h3></div>
    <p style={{ color: "var(--muted)", marginTop: 0 }}>Escanea el QR pegado en el puesto de consumo (o pega su enlace) para descontar stock de químicos o material de limpieza.</p>
    {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
    {msg && <div className={"banner " + (msg.kind === "ok" ? "" : "danger")} style={{ marginBottom: 12 }}>{msg.message}</div>}
    <div className="form-grid">
      <div className="full"><div className="field"><label htmlFor="cq-tipo">Tipo de consumible</label>
        <select id="cq-tipo" className="input" value={tipo} onChange={(e) => { setTipo(e.target.value); setItem(null); }}>
          <option value="quimicos">Productos químicos (se descuentan garrafas)</option>
          <option value="material_limpieza">Material de limpieza (se descuentan unidades)</option>
        </select></div></div>
      <div className="full"><div className="field"><label htmlFor="cq-manual">O pega aquí el enlace del QR</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input id="cq-manual" className="input" placeholder="https://…/#/consumo?tipo=quimicos&id=1" value={manual} onChange={(e) => setManual(e.target.value)} />
          <button className="btn secondary" onClick={() => handleCode(manual.trim())} disabled={!manual.trim()}>Cargar</button>
        </div></div></div>
    </div>
    {scanning
      ? <div style={{ marginTop: 12 }}><video ref={videoRef} className="scan-video" muted playsInline /><div><button className="btn secondary" style={{ marginTop: 8 }} onClick={stopScan}>Detener cámara</button></div></div>
      : <button className="btn secondary" style={{ marginTop: 4 }} onClick={() => void startScan()}>📷 Escanear con la cámara</button>}
    {item && <div className="card card-pad" style={{ marginTop: 16 }}>
      <table><tbody>
        <tr><th>Consumible</th><td>{String(item.nombre ?? "—")}</td></tr>
        {tipo === "quimicos" && <tr><th>Lote</th><td>{String(item.numero_lote ?? "—")}</td></tr>}
        {tipo === "material_limpieza" && <tr><th>Color</th><td>{String(item.color ?? "—")}</td></tr>}
        {tipo === "punto" && <>
          <tr><th>Zona · subzona</th><td>{[String(item.zona ?? "—"), String(item.subzona ?? "")].filter(v => v && v !== "—").join(" · ") || "—"}</td></tr>
          <tr><th>Producto del punto</th><td>{String(item.producto_nombre ?? "—")}</td></tr>
        </>}
        <tr><th>Centro</th><td>{String(item.centro_nombre ?? "—")}</td></tr>
        <tr><th>Stock actual</th><td><strong>{formatNum(item[tipo === "quimicos" ? "num_garrafas" : tipo === "punto" ? "producto_stock" : "cantidad"])}</strong> {stockLabel}</td></tr>
      </tbody></table>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", marginTop: 12 }}>
        <div className="field" style={{ width: 150 }}><label htmlFor="cq-cant">Cantidad a descontar</label>
          <input id="cq-cant" className="input" type="number" min={1} step={1} value={cantidad} onChange={(e) => setCantidad(e.target.value)} /></div>
        <button className="btn" onClick={() => void deduct()} disabled={busy || !(Number(cantidad) >= 1)}>{busy ? "Descontando…" : `Descontar ${stockLabel}`}</button>
      </div>
    </div>}
  </div>;
}
