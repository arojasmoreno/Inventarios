import { useState } from "react";
import manualAdminMd from "../../docs/manual-administrador.md?raw";
import manualUsuarioMd from "../../docs/manual-usuario.md?raw";

interface Manual {
  titulo: string;
  pdf: string;
  md: string;
  icono: string;
}

// Los manuales viven en docs/ y se regeneran con `node make-pdf.mjs`.
const MANUALES: Manual[] = [
  { titulo: "Manual del administrador", pdf: "docs/manual-administrador.pdf", md: manualAdminMd, icono: "🛡️" },
  { titulo: "Manual del usuario", pdf: "docs/manual-usuario.pdf", md: manualUsuarioMd, icono: "🛟" },
];

const ancla = (texto: string): string =>
  texto.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function marked(md: string): string {
  return md
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/^## (.*)$/gm, (_m, t: string) => `<h2 id="${ancla(t)}">${t}</h2>`)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\n+/g, "<br/>")
    .replace(/<br\/>$/, "");
}

interface ManualWeb {
  manual: Manual;
  apartados: string[];
  html: string;
}

const PARSEADOS: ManualWeb[] = MANUALES.map((m) => ({
  manual: m,
  apartados: m.md.split("\n## ").slice(1).map((a) => a.split("\n")[0].trim()).filter(Boolean),
  html: marked(m.md),
}));

export function AyudaPage({ user }: { user: { rol: string } }) {
  const [abierto, setAbierto] = useState<number | null>(null);
  const puedePdf = user.rol === "admin" || user.rol === "admin_centros";

  return (
    <main className="page">
      <section className="section-head">
        <h2>🛟 Manuales y ayuda</h2>
      </section>
      {abierto === null ? (
        <div className="cards">
          {PARSEADOS.map((m, i) => (
            <a key={m.manual.titulo} className="card" href="" onClick={(e) => { e.preventDefault(); setAbierto(i); }}>
              <span className="card-icon">{m.manual.icono}</span>
              <h3>{m.manual.titulo}</h3>
              <p>Ver en la web · {m.apartados.length} apartados · PDF</p>
            </a>
          ))}
        </div>
      ) : (
        <ManualWeb manual={PARSEADOS[abierto]} onVolver={() => setAbierto(null)} puedePdf={puedePdf} />
      )}
    </main>
  );
}

function ManualWeb({ manual, onVolver, puedePdf }: { manual: ManualWeb; onVolver: () => void; puedePdf: boolean }) {
  return (
    <div className="manual-web">
      <aside className="manual-indice no-print">
        <div className="manual-indice-titulo">{manual.manual.icono} {manual.manual.titulo}</div>
        <ul>
          {manual.apartados.map((a) => <li key={a}><a href={`#${ancla(a)}`}>{a}</a></li>)}
        </ul>
        <div className="chips" style={{ marginTop: 12 }}>
          {puedePdf && <a className="btn secondary small" href={manual.manual.pdf} download>⬇️ PDF</a>}
          <button className="btn secondary small" onClick={onVolver}>← Volver</button>
        </div>
      </aside>
      <article className="manual-cuerpo" dangerouslySetInnerHTML={{ __html: manual.html }} />
    </div>
  );
}
