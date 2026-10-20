import { useEffect, type ReactNode } from "react";
export type FieldType = "text" | "textarea" | "number" | "integer" | "date" | "boolean" | "enum" | "password" | "select" | "image";
export interface SelectOption { value: string | number; label: string; }
export interface FieldDef { name: string; label: string; type: FieldType; required?: boolean; enumValues?: string[]; options?: SelectOption[]; placeholder?: string; help?: string; writeOnly?: boolean; hasExisting?: boolean; previewUrl?: string; }
// Recimensiona en el navegador la foto elegida (máx. 900 px, JPEG) antes de
// enviarla como base64, para no cargar fotos de varios MB en la base de datos.
export function fileToDataUrl(file: File, max = 900, quality = 0.72): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const scale = Math.min(1, max / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("No se pudo leer la imagen")); };
    img.src = url;
  });
}
export function Modal({ title, subtitle, onClose, children }: { title: string; subtitle?: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => { const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey); }, [onClose]);
  return <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-modal="true"><div className="modal-head"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-btn" onClick={onClose} aria-label="Cerrar">✕</button></div><div className="modal-body">{children}</div></div></div>;
}
export function Field({ def, value, onChange }: { def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  const id = `f-${def.name}`, cls = "input" + (def.required ? " required" : "");
  if (def.type === "boolean") return <label className="field checkbox" htmlFor={id}><input id={id} type="checkbox" checked={value === true || value === 1} onChange={(e) => onChange(e.target.checked)} /><span>{def.label}</span></label>;
  let control: ReactNode;
  if (def.type === "textarea") control = <textarea id={id} className={cls} rows={3} placeholder={def.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  else if (def.type === "enum" || def.type === "select") {
    const options = def.options ?? (def.enumValues ?? []).map((v) => ({ value: v, label: v }));
    control = <select id={id} className={cls} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => { const raw = e.target.value; if (raw === "") return onChange(null); const opt = options.find((o) => String(o.value) === raw); onChange(opt ? opt.value : raw); }}><option value="">— Sin asignar —</option>{options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}</select>;
  } else if (def.type === "number" || def.type === "integer") control = <input id={id} className={cls} type="number" step={def.type === "integer" ? 1 : "any"} min={0} placeholder={def.placeholder} value={value === null || value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)} />;
  else if (def.type === "date") control = <input id={id} className={cls} type="date" value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value || null)} />;
  else if (def.type === "image") control = <div className="img-field">
    {def.hasExisting && typeof value !== "string" && def.previewUrl && <img className="thumb-preview" src={def.previewUrl} alt="Foto actual" />}
    {typeof value === "string" && value.startsWith("data:") && <img className="thumb-preview" src={value} alt="Vista previa" />}
    <input id={id} type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { onChange(await fileToDataUrl(f)); } catch (err) { onChange(null); alert(err instanceof Error ? err.message : "Error leyendo la imagen"); } } }} />
    {def.hasExisting && typeof value !== "string" && <button type="button" className="btn secondary small" onClick={() => onChange("")}>🗑️ Quitar foto actual</button>}
  </div>;
  else if (def.type === "password") control = <input id={id} className={cls} type="password" autoComplete="new-password" placeholder={def.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  else control = <input id={id} className={cls} type="text" placeholder={def.placeholder} value={typeof value === "string" ? value : ""} onChange={(e) => onChange(e.target.value)} />;
  return <div className="field"><label htmlFor={id}>{def.label}{def.required && <span className="req">*</span>}</label>{control}{def.help && <small>{def.help}</small>}</div>;
}
export function Toast({ message, kind, onClose }: { message: string; kind: "ok" | "error"; onClose: () => void }) {
  useEffect(() => { const t = setTimeout(onClose, 4500); return () => clearTimeout(t); }, [onClose]);
  return <div className={`toast ${kind}`} role="status"><span>{message}</span><button className="icon-btn" onClick={onClose} aria-label="Cerrar aviso">✕</button></div>;
}
const nf0 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }), nf2 = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
export function formatNum(n: unknown, decimales = 0): string { const v = Number(n ?? 0); if (!Number.isFinite(v)) return "0"; return decimales > 0 ? nf2.format(v) : nf0.format(v); }
export function formatFecha(f: unknown): string { if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(f)) return "—"; const [y,m,d] = f.slice(0,10).split("-"); return `${d}/${m}/${y}`; }
export function diasHasta(f: unknown): number | null { if (typeof f !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(f)) return null; const target = new Date(`${f.slice(0,10)}T00:00:00`), today = new Date(); today.setHours(0,0,0,0); return Math.round((target.getTime()-today.getTime())/86400000); }
const COLOR_HEX: Record<string,string> = { Rojo:"#dc2626", Azul:"#2563eb", Verde:"#16a34a", Amarillo:"#eab308", Blanco:"#f8fafc", Negro:"#111827", Naranja:"#ea580c", Morado:"#9333ea", Gris:"#6b7280", "Marrón":"#92400e", Otro:"#94a3b8" };
export function ColorSwatch({ color }: { color: string }) { return <span className="swatch" style={{ background: COLOR_HEX[color] ?? "#94a3b8" }} aria-hidden="true" />; }
export function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]): void {
  const esc = (v: string | number): string => { const s = String(v ?? ""); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = "\uFEFF" + [headers, ...rows].map((r) => r.map(esc).join(";")).join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" }), url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}
