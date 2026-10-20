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
