/** Sección «Ayuda»: los manuales de la aplicación en formato web (índice +
 *  apartados + contenido) y, para administradores, descargables en PDF.
 *  El contenido sale de los Markdown de docs/ (fuente única) y las capturas
 *  de public/docs/img, que sirve el build. */

import { useState, type MouseEvent } from "react";
import manualAdminMd from "../../docs/manual-administrador.md?raw";
import manualUsuarioMd from "../../docs/manual-usuario.md?raw";

type Clave = "admin" | "usuario";

interface Entrada { id: string; texto: string; nivel: number }

interface Manual {
  clave: Clave;
  icono: string;
  titulo: string;
  publico: string;
  resumen: string;
  pdf: string;
  md: string;
}

const MANUALES: Manual[] = [
  {
    clave: "admin",
    icono: "🛠️",
    titulo: "Manual del administrador",
    publico: "Administradores",
    resumen: "Guía completa: acceso, panel de control, altas y ediciones de registros, estaciones con QR, usuarios, centros, informes, copias de seguridad y mantenimiento de la aplicación.",
    pdf: "docs/manual-administrador.pdf",
    md: manualAdminMd,
  },
  {
    clave: "usuario",
    icono: "🧭",
    titulo: "Manual del usuario",
    publico: "Operarios y usuarios de consulta",
    resumen: "Guía breve para el día a día: entrar, qué secciones ves, consumir material en planta con el QR y cambiar tu contraseña.",
    pdf: "docs/manual-usuario.pdf",
    md: manualUsuarioMd,
  },
];

// ---------------------------------------------------------------- Markdown
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const slug = (s: string): string => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
// Las capturas viven en public/docs/img: «img/foo.png» → «docs/img/foo.png».
const rutaImagen = (src: string): string => src.replace(/^\.?\/*img\//, "docs/img/");

function inline(s: string): string {
  let t = esc(s);
  const codes: string[] = [];
  t = t.replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, src: string) => `<img src="${rutaImagen(src)}" alt="${alt}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt: string, href: string) => `<a href="${href}">${txt}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${esc(codes[Number(i)])}</code>`);
  return t;
}

/** Markdown → HTML (con índice de apartados). Todo el texto crudo se escapa
 *  antes de interpretarlo, así que el contenido renderizado es seguro. */
function md2html(md: string): { html: string; toc: Entrada[] } {
  const lines = md.split("\n");
  const out: string[] = [];
  const toc: Entrada[] = [];
  const isTable = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const esIni = (l: string): boolean => /^(#{1,4}\s|>\s?|\s*[-*]\s|\s*\d+\.\s)/.test(l) || isTable(l) || /^---+\s*$/.test(l);
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) {
      const nivel = h[1].length, texto = h[2].trim(), id = slug(texto);
      if (nivel === 2 || nivel === 3) toc.push({ id, texto, nivel });
      out.push(`<h${nivel} id="${id}">${inline(texto)}</h${nivel}>`);
      i++; continue;
    }
    if (/^>\s?/.test(l)) {
      const b: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { b.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${b.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (isTable(l)) {
      const rows: string[] = [];
      while (i < lines.length && isTable(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r: string): string[] => r.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>`
        + body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")
        + `</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const it: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      out.push(`<ul>${it.map(x => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const it: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push(`<ol>${it.map(x => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }
    const b: string[] = [];
    while (i < lines.length && lines[i].trim() && !esIni(lines[i])) { b.push(lines[i]); i++; }
    out.push(`<p>${b.map(inline).join(" ")}</p>`);
  }
  return { html: out.join("\n"), toc };
}

// Los manuales se interpretan una sola vez al cargar la sección.
const PARSEADOS = MANUALES.map(m => {
  const { html, toc } = md2html(m.md);
  return {
    ...m,
    html,
    toc,
    apartados: toc.filter(e => e.nivel === 2).length,
    capturas: (m.md.match(/^!\[/gm) ?? []).length,
  };
});

// ----------------------------------------------------------------- Lector
/** Manual en formato web: índice lateral con los apartados y el contenido
 *  completo en la columna principal. */
function ManualWeb({ manual, onVolver, onIrA, puedePdf }: {
  manual: (typeof PARSEADOS)[number];
  onVolver: () => void;
  onIrA: (clave: Clave) => void;
  puedePdf: boolean;
}) {
  const irA = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  // Los enlaces a otros manuales (.md) abren ese manual en la vista web.
  const onClickCuerpo = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (a && /\.md$/.test(href)) {
      e.preventDefault();
      onIrA(href.includes("usuario") ? "usuario" : "admin");
    }
  };
  return <>
    <div className="toolbar no-print">
      <button className="btn secondary" onClick={onVolver}>← Volver a Manuales</button>
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        {manual.apartados} apartados · {manual.capturas} capturas
      </span>
      {puedePdf && <a className="btn secondary" href={manual.pdf} download>⬇️ Descargar PDF</a>}
    </div>

    <div className="manual-web">
      <aside className="manual-indice no-print">
        <div className="manual-indice-titulo">{manual.icono} {manual.titulo}</div>
        <ul>
          {manual.toc.map(e => (
            <li key={e.id} className={e.nivel === 3 ? "sub" : undefined}>
              <a href={`#${e.id}`} onClick={(ev) => { ev.preventDefault(); irA(e.id); }}>{e.texto}</a>
            </li>
          ))}
        </ul>
      </aside>
      <article className="manual-cuerpo" onClick={onClickCuerpo} dangerouslySetInnerHTML={{ __html: manual.html }} />
    </div>
  </>;
}

// --------------------------------------------------------------- Sección
export function AyudaPage({ user }: { user: { rol: string } }) {
  // El PDF se descarga solo para administradores; todos leen la versión web.
  const puedePdf = user.rol !== "usuario";
  const [abierto, setAbierto] = useState<Clave | null>(null);

  const actual = abierto ? PARSEADOS.find(m => m.clave === abierto) : null;
  if (actual) {
    return <ManualWeb manual={actual} onVolver={() => setAbierto(null)} onIrA={setAbierto} puedePdf={puedePdf} />;
  }

  return <>
    <div className="card card-pad">
      <div className="section-head">
        <h3>🛟 Manuales de la aplicación</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          Léelos en la web · los administradores también pueden descargarlos en PDF
        </span>
      </div>
      <p style={{ color: "var(--muted)", margin: "0 0 4px" }}>
        Dos manuales en español: uno completo para administrar la aplicación y otro corto para el uso diario en
        planta. Pulsa <strong>«Ver en la web»</strong> para leerlos aquí con su índice de apartados. Si algo no
        funciona, empieza por la tabla <em>«Solución de problemas»</em> de cada manual.
      </p>
    </div>

    <div className="ayuda-grid">
      {PARSEADOS.map(m => (
        <div key={m.clave} className="card card-pad ayuda-card">
          <div className="ayuda-head">
            <span className="ayuda-icono" aria-hidden="true">{m.icono}</span>
            <div>
              <h3>{m.titulo}</h3>
              <span className="badge info">{m.publico}</span>{" "}
              <span className="badge muted">{m.apartados} apartados · {m.capturas} capturas</span>
            </div>
          </div>
          <p className="ayuda-resumen">{m.resumen}</p>
          <ul className="ayuda-temas">
            {m.toc.filter(e => e.nivel === 2).slice(0, 7).map(e => <li key={e.id}>{e.texto}</li>)}
          </ul>
          <div className="ayuda-acciones">
            <button className="btn" onClick={() => setAbierto(m.clave)}>📖 Ver en la web</button>
            {puedePdf && <a className="btn secondary" href={m.pdf} download>⬇️ Descargar PDF</a>}
          </div>
        </div>
      ))}
    </div>

    <div className="card card-pad">
      <div className="section-head"><h3>💡 Ayuda rápida</h3></div>
      <ul style={{ margin: 0, paddingLeft: 20, color: "var(--muted)", lineHeight: 1.7 }}>
        <li><strong>«Usuario o contraseña incorrectos»</strong>: revisa mayúsculas; tras 5 fallos en 15 minutos la cuenta se bloquea 15 minutos.</li>
        <li><strong>«Failed to fetch»</strong>: no hay conexión con el servidor (red, VPN o firewall); recarga la página.</li>
        <li><strong>Un campo en rojo</strong>: ese dato es obligatorio o no es válido; el color desaparece al corregirlo.</li>
        <li><strong>Olvidé mi contraseña</strong>: en la pantalla de acceso, «¿Has olvidado tu contraseña?».</li>
        <li><strong>Contraseña propia</strong>: se cambia en <em>Cuenta › Mi cuenta</em>.</li>
        <li><strong>Los botones de descarga (CSV / PDF) no aparecen</strong>: son exclusivos de los administradores.</li>
      </ul>
    </div>
  </>;
}
