import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Modal } from "./ui";

/** Enlace que lleva al modo estación de la estación indicada. */
export function qrContent(tipo: string, id: number): string {
  if (tipo === "estacion") return `${window.location.origin}/#/estaciones?consumo=${id}`;
  return `${window.location.origin}/#/estaciones?consumo=${id}`;
}

/** Modal con el QR de la estación, listo para imprimir y pegar en su soporte. */
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
  return <Modal title="Código QR de la estación" subtitle={title} onClose={onClose}>
    {error && <div className="form-error">{error}</div>}
    {dataUrl
      ? <div className="qr-wrap"><img src={dataUrl} alt="Código QR" />
          <p className="qr-url">{url}</p>
          <p className="qr-help">Pega esta etiqueta en el soporte de la estación: al escanearla se abre el modo estación para descontar unidades del artículo.</p>
          <button className="btn secondary" onClick={() => window.print()}>🖨️ Imprimir etiqueta</button>
        </div>
      : <div className="loading">Generando QR…</div>}
  </Modal>;
}

/** Modal con etiquetas QR en lote (una por estación), lista para imprimir. */
export function QrLoteModal({ items, subtitle, onClose }: { items: { id: number; title: string }[]; subtitle?: string; onClose: () => void }) {
  const [urls, setUrls] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const key = items.map((i) => i.id).join(",");
  useEffect(() => {
    document.body.classList.add("qr-lote");
    let alive = true;
    Promise.all(items.map(async (it) => ({
      id: it.id,
      url: await QRCode.toDataURL(qrContent("estacion", it.id), { width: 260, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } }),
    })))
      .then((list) => { if (alive) setUrls(Object.fromEntries(list.map((l) => [l.id, l.url]))); })
      .catch(() => { if (alive) setError("No se pudieron generar los códigos QR"); });
    return () => { alive = false; document.body.classList.remove("qr-lote"); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return <Modal title={`Etiquetas QR · ${items.length}`} subtitle={subtitle} onClose={onClose}>
    {error && <div className="form-error">{error}</div>}
    <div className="qr-lote-grid">{items.map((it) => <div className="qr-lote-item" key={it.id}>
      {urls[it.id] ? <img src={urls[it.id]} alt={`QR ${it.title}`} /> : <span className="loading" style={{ padding: 12 }}>Generando…</span>}
      <strong>{it.title}</strong>
      <small>{qrContent("estacion", it.id)}</small>
    </div>)}</div>
    <div className="modal-footer">
      <button className="btn secondary" onClick={onClose}>Cerrar</button>
      <button className="btn" onClick={() => window.print()}>🖨️ Imprimir todas</button>
    </div>
  </Modal>;
}
