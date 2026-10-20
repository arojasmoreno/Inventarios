import { useEffect, useState } from "react";
import { api } from "./api";
import { fileToDataUrl } from "./ui";

/** Apartado (solo admin) para cargar el nombre y el logo de la empresa. */
export function EmpresaPage() {
  const [nombre, setNombre] = useState("");
  const [logo, setLogo] = useState<string | null>(null); // null = sin cambios, "" = quitar
  const [tiene, setTiene] = useState(false);
  const [msg, setMsg] = useState<{ text: string; kind: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<{ empresa: { nombre: string | null; tiene_logo: boolean } }>("/api/empresa")
      .then((r) => { setNombre(r.empresa.nombre ?? ""); setTiene(r.empresa.tiene_logo); })
      .catch(() => setMsg({ text: "No se pudieron cargar los datos de la empresa", kind: "error" }));
  }, []);
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const payload: Record<string, unknown> = { nombre };
      if (typeof logo === "string") payload.logo = logo;
      const r = await api.put<{ empresa: { tiene_logo: boolean } }>("/api/empresa", payload);
      setTiene(r.empresa.tiene_logo); setLogo(null);
      setMsg({ text: "Datos guardados correctamente", kind: "ok" });
    } catch (e) { setMsg({ text: e instanceof Error ? e.message : "No se pudo guardar", kind: "error" }); }
    finally { setBusy(false); }
  };
  return <div className="card card-pad" style={{ maxWidth: 560 }}>
    <div className="section-head"><h3>Datos de la empresa</h3></div>
    <p style={{ color: "var(--muted)", marginTop: 0 }}>El nombre y el logo se usan en los informes imprimibles, como el informe de entrega de ropa.</p>
    {msg && <div className={"banner " + (msg.kind === "ok" ? "" : "danger")} style={{ marginBottom: 12 }}>{msg.text}</div>}
    <div className="form-grid">
      <div className="full"><div className="field"><label htmlFor="emp-nombre">Nombre de la empresa</label>
        <input id="emp-nombre" className="input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Ej. Limpiezas Rojas S.L." /></div></div>
      <div className="full"><div className="field"><label>Logo</label>
        {tiene && typeof logo !== "string" && <img className="thumb-preview" src="/api/empresa/logo" alt="Logo actual" style={{ maxHeight: 90 }} />}
        {typeof logo === "string" && logo && <img className="thumb-preview" src={logo} alt="Nuevo logo" style={{ maxHeight: 90 }} />}
        <input type="file" accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { setLogo(await fileToDataUrl(f, 600, 0.8)); } catch { setMsg({ text: "No se pudo leer la imagen", kind: "error" }); } } }} />
        {tiene && typeof logo !== "string" && <button type="button" className="btn secondary small" onClick={() => setLogo("")}>🗑️ Quitar logo actual</button>}
        <small>Se imprimirá en los informes. Recomendado: menos de 500 px de ancho.</small>
      </div></div>
    </div>
    <div className="modal-footer"><button className="btn" onClick={() => void save()} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button></div>
  </div>;
}
