import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { Modal, formatFecha } from "./ui";

type Row = Record<string, unknown>;

interface Linea { ropaId: number; label: string; marca: string; modelo: string; talla: string | null; cantidad: number; }

/** Flujo de entrega: seleccionar todas las prendas y generar el informe con el logo. */
export function EntregaPage({ user }: { user: { nombre: string } }) {
  const [usuarios, setUsuarios] = useState<Row[]>([]);
  const [ropas, setRopas] = useState<Row[]>([]);
  const [usuarioId, setUsuarioId] = useState("");
  const [marcaSel, setMarcaSel] = useState("");
  const [modeloSel, setModeloSel] = useState("");
  const [ropaSel, setRopaSel] = useState("");
  const [cant, setCant] = useState("1");
  const [lineas, setLineas] = useState<Linea[]>([]);
  const [notas, setNotas] = useState("");
  const [empresa, setEmpresa] = useState<{ nombre: string | null; logo: string | null }>({ nombre: null, logo: null });
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [informe, setInforme] = useState<{ operario: string; lineas: Linea[]; fecha: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [u, r, e] = await Promise.all([
        api.get<{ items: Row[] }>("/api/usuarios"),
        api.get<{ items: Row[] }>("/api/ropa-trabajo"),
        api.get<{ empresa: { nombre: string | null; logo: string | null } }>("/api/empresa"),
      ]);
      setUsuarios(u.items.filter((x) => Number(x.activo) === 1));
      setRopas(r.items);
      setEmpresa({ nombre: e.empresa.nombre, logo: e.empresa.logo });
    } catch { setError("No se pudieron cargar los datos"); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const marcas = [...new Set(ropas.map((r) => String(r.marca ?? "—")))];
  const modelos = [...new Set(ropas.filter((r) => String(r.marca ?? "—") === marcaSel).map((r) => String(r.modelo ?? "—")))];
  const tallasOpts = ropas.filter((r) => String(r.marca ?? "—") === marcaSel && String(r.modelo ?? "—") === modeloSel);

  const addLinea = () => {
    setError(null);
    const r = ropas.find((x) => Number(x.id) === Number(ropaSel));
    const n = Number(cant);
    if (!r) { setError("Elige marca, modelo y talla para añadir la prenda"); return; }
    if (!Number.isInteger(n) || n < 1) { setError("La cantidad debe ser un número entero positivo"); return; }
    const stock = Number(r.stock ?? 0);
    const enCurso = lineas.filter((l) => l.ropaId === Number(r.id)).reduce((s, l) => s + l.cantidad, 0);
    if (stock - enCurso < n) { setError(`Stock insuficiente: quedan ${stock - enCurso} uds. de esa prenda`); return; }
    const marca = String(r.marca ?? "—"), modelo = String(r.modelo ?? "—");
    const talla = r.talla ? String(r.talla) : null;
    const label = `${marca !== "—" ? marca + " " : ""}${modelo !== "—" ? modelo : String(r.prenda)}`;
    setLineas((prev) => {
      const exist = prev.find((l) => l.ropaId === Number(r.id));
      if (exist) return prev.map((l) => l.ropaId === Number(r.id) ? { ...l, cantidad: l.cantidad + n } : l);
      return [...prev, { ropaId: Number(r.id), label, marca, modelo, talla, cantidad: n }];
    });
    setRopaSel(""); setCant("1");
  };

  const removeLinea = (ropaId: number) => setLineas((prev) => prev.filter((l) => l.ropaId !== ropaId));

  const registrar = async () => {
    if (!usuarioId) { setError("Elige el operario destinatario"); return; }
    if (!lineas.length) { setError("Añade al menos una prenda a la entrega"); return; }
    setBusy(true); setError(null);
    try {
      for (const l of lineas) {
        await api.post("/api/entregas", { usuario_id: Number(usuarioId), ropa_id: l.ropaId, cantidad: l.cantidad, notas: notas || null });
      }
      const operario = usuarios.find((x) => Number(x.id) === Number(usuarioId));
      setInforme({ operario: String(operario?.nombre ?? ""), lineas, fecha: new Date().toISOString().slice(0, 10) });
      setLineas([]); setNotas(""); setToast("Entregas registradas · stock descontado");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : "No se pudieron registrar las entregas"); }
    finally { setBusy(false); }
  };

  return <>
    <div className="card card-pad" style={{ maxWidth: 720 }}>
      <div className="section-head"><h3>Nueva entrega de ropa</h3></div>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>Selecciona el operario y todas las prendas a entregar; al registrarlas se descuenta el stock y se genera el informe imprimible.</p>
      {error && <div className="form-error" style={{ marginBottom: 12 }}>{error}</div>}
      <div className="form-grid">
        <div className="full"><div className="field"><label htmlFor="en-op">Operario</label>
          <select id="en-op" className="input" value={usuarioId} onChange={(e) => setUsuarioId(e.target.value)}>
            <option value="">— Elige un operario —</option>
            {usuarios.map((u) => <option key={String(u.id)} value={String(u.id)}>{String(u.nombre)} ({String(u.username)})</option>)}
          </select></div></div>
        <div><div className="field"><label htmlFor="en-marca">Marca</label>
          <select id="en-marca" className="input" value={marcaSel} onChange={(e) => { setMarcaSel(e.target.value); setModeloSel(""); setRopaSel(""); }}>
            <option value="">— Marca —</option>
            {marcas.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></div></div>
        <div><div className="field"><label htmlFor="en-modelo">Modelo</label>
          <select id="en-modelo" className="input" value={modeloSel} onChange={(e) => { setModeloSel(e.target.value); setRopaSel(""); }} disabled={!marcaSel}>
            <option value="">— Modelo —</option>
            {modelos.map((m) => <option key={m} value={m}>{m}</option>)}
          </select></div></div>
        <div><div className="field"><label htmlFor="en-ropa">Talla</label>
          <select id="en-ropa" className="input" value={ropaSel} onChange={(e) => setRopaSel(e.target.value)} disabled={!modeloSel}>
            <option value="">— Talla —</option>
            {tallasOpts.map((r) => <option key={String(r.id)} value={String(r.id)} disabled={Number(r.stock) <= 0}>T. {String(r.talla ?? "—")} · {String(r.codigo)} — stock {String(r.stock)}</option>)}
          </select></div></div>
        <div style={{ maxWidth: 130 }}><div className="field"><label htmlFor="en-cant">Cantidad</label>
          <input id="en-cant" className="input" type="number" min={1} step={1} value={cant} onChange={(e) => setCant(e.target.value)} /></div></div>
        <div style={{ display: "flex", alignItems: "flex-end", paddingBottom: 2 }}><button className="btn secondary" onClick={addLinea}>＋ Añadir</button></div>
        <div className="full"><div className="field"><label htmlFor="en-notas">Notas de la entrega (opcional)</label>
          <input id="en-notas" className="input" value={notas} onChange={(e) => setNotas(e.target.value)} placeholder="Ej. Equipación para el turno de noche" /></div></div>
      </div>
      {lineas.length > 0 && <table style={{ marginTop: 8 }}><thead><tr><th>Prenda</th><th>Marca</th><th>Modelo</th><th>Talla</th><th className="right">Cantidad</th><th className="right"></th></tr></thead>
        <tbody>{lineas.map((l) => <tr key={l.ropaId}><td>{l.label}</td><td>{l.marca}</td><td>{l.modelo}</td><td>{l.talla ?? "—"}</td><td className="right">{l.cantidad}</td>
          <td className="right"><button className="btn danger small" onClick={() => removeLinea(l.ropaId)}>✕ Quitar</button></td></tr>)}</tbody></table>}
      <div className="modal-footer"><button className="btn" onClick={() => void registrar()} disabled={busy || !lineas.length}>{busy ? "Registrando…" : "Registrar entrega y generar informe"}</button></div>
    </div>
    {toast && <div className="banner" style={{ maxWidth: 720 }}>{toast}</div>}
    {informe && <Modal title="Informe de entrega de ropa" subtitle={`${informe.fecha} · ${informe.operario}`} onClose={() => setInforme(null)}>
      <div className="report">
        <div className="report-head">
          {empresa.logo ? <img src={empresa.logo} alt="Logo" className="report-logo" /> : <span className="report-logo placeholder">📦</span>}
          <div><strong>{empresa.nombre ?? "Inventarios"}</strong><div className="report-sub">Informe de entrega de ropa de trabajo</div></div>
        </div>
        <table><tbody>
          <tr><th>Operario</th><td>{informe.operario}</td></tr>
          <tr><th>Fecha</th><td>{formatFecha(informe.fecha)}</td></tr>
          <tr><th>Entregado por</th><td>{user.nombre}</td></tr>
        </tbody></table>
        <table style={{ marginTop: 10 }}><thead><tr><th>Marca</th><th>Modelo</th><th>Talla</th><th className="right">Cantidad</th></tr></thead>
          <tbody>{informe.lineas.map((l) => <tr key={l.ropaId}><td>{l.marca}</td><td>{l.modelo}</td><td>{l.talla ?? "—"}</td><td className="right">{l.cantidad}</td></tr>)}
          <tr><th>Total prendas</th><td></td><td></td><td className="right"><strong>{informe.lineas.reduce((s, l) => s + l.cantidad, 0)}</strong></td></tr></tbody></table>
        <div className="firma-row"><div className="firma">Firma del operario</div><div className="firma">Firma de quien entrega</div></div>
      </div>
      <div className="modal-footer print-hide">
        <button className="btn secondary" onClick={() => setInforme(null)}>Cerrar</button>
        <button className="btn" onClick={() => { document.body.classList.add("print-report"); window.print(); document.body.classList.remove("print-report"); }}>🖨️ Imprimir informe</button>
      </div>
    </Modal>}
  </>;
}
