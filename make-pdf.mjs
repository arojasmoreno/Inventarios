// Genera los PDF de los manuales a partir de su Markdown:
//   docs/manual-*.md  →  src/web/public/docs/*.pdf  (que sirve la app y descarga «Ayuda»).
// Uso: node make-pdf.mjs [--keep]   (requiere: npm i --no-save playwright)
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  let t = esc(s);
  const codes = [];
  t = t.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = t.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, a, s2) => `<img src="${s2}" alt="${a}">`);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t2, h) => `<a href="${h}">${t2}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return t;
}

const isTable = (l) => /^\s*\|.*\|\s*$/.test(l);
const esIni = (l) => /^(#{1,4}\s|>\s?|\s*[-*]\s|\s*\d+\.\s)/.test(l) || isTable(l) || /^---+\s*$/.test(l);

function md2html(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    if (/^---+\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    if (h) { const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); i++; continue; }
    if (/^>\s?/.test(l)) {
      const b = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { b.push(lines[i].replace(/^>\s?/, "")); i++; }
      out.push(`<blockquote>${b.map(inline).join("<br>")}</blockquote>`);
      continue;
    }
    if (isTable(l)) {
      const rows = [];
      while (i < lines.length && isTable(lines[i])) { rows.push(lines[i]); i++; }
      const cells = (r) => r.trim().replace(/^\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(2).map(cells);
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + `</tbody></table>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(l)) {
      const it = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++; }
      out.push(`<ul>${it.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(l)) {
      const it = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { it.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++; }
      out.push(`<ol>${it.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
      continue;
    }
    const b = [];
    while (i < lines.length && lines[i].trim() && !esIni(lines[i])) { b.push(lines[i]); i++; }
    out.push(`<p>${b.map(inline).join(" ")}</p>`);
  }
  return out.join("\n");
}
const CSS = `
body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:#0f172a;font-size:10.5pt;line-height:1.55;margin:0}
h1{font-size:23pt;margin:0 0 4px}
h1:after{content:"";display:block;width:64px;height:5px;background:#2563eb;border-radius:3px;margin-top:10px}
h2{font-size:14.5pt;margin:20px 0 8px;padding-bottom:5px;border-bottom:2px solid #e2e8f0;break-after:avoid}
h3{font-size:11.5pt;margin:15px 0 6px;break-after:avoid}
h4{font-size:10.5pt;margin:12px 0 4px;break-after:avoid}
p{margin:7px 0}ul,ol{margin:7px 0 7px 22px;padding:0}li{margin:3px 0}
table{width:100%;border-collapse:collapse;margin:9px 0 14px;font-size:9pt}
th{background:#f1f5f9;text-align:left}th,td{border:1px solid #cbd5e1;padding:5px 7px;vertical-align:top}tr{break-inside:avoid}
blockquote{margin:10px 0;padding:8px 12px;background:#eff6ff;border-left:4px solid #2563eb;border-radius:6px;color:#1e3a8a}
img{max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:8px 0;display:block}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-family:ui-monospace,Consolas,monospace;font-size:9.5pt}
hr{border:0;border-top:1px solid #e2e8f0;margin:16px 0}a{color:#2563eb;text-decoration:none}
`;

function pagina(titulo, cuerpo) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(titulo)}</title>` +
    `<style>${CSS}</style></head><body>${cuerpo}</body></html>`;
}

const MANUALES = [
  { md: "docs/manual-administrador.md", titulo: "Manual del administrador · Inventarios", salida: "src/web/public/docs/manual-administrador.pdf", tmp: "docs/.tmp-admin.html" },
  { md: "docs/manual-usuario.md", titulo: "Manual del usuario · Inventarios", salida: "src/web/public/docs/manual-usuario.pdf", tmp: "docs/.tmp-usuario.html" },
];

mkdirSync("src/web/public/docs", { recursive: true });
const browser = await chromium.launch();

for (const m of MANUALES) {
  const md = readFileSync(m.md, "utf8");
  const cuerpo = md2html(md);
  writeFileSync(m.tmp, pagina(m.titulo, cuerpo));
  const page = await browser.newPage();
  await page.goto("file://" + resolve(m.tmp), { waitUntil: "load" });
  await page.waitForTimeout(300);
  await page.pdf({
    path: m.salida,
    format: "A4",
    printBackground: true,
    margin: { top: "17mm", bottom: "16mm", left: "14mm", right: "14mm" },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:7.5px;width:100%;text-align:right;padding-right:14mm;color:#94a3b8;font-family:Arial">${esc(m.titulo)}</div>`,
    footerTemplate: `<div style="font-size:7.5px;width:100%;text-align:center;padding-left:14mm;color:#94a3b8;font-family:Arial">Inventarios · Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>`,
  });
  console.log("OK", m.salida);
  await page.close();
}

await browser.close();
if (!process.argv.includes("--keep")) for (const m of MANUALES) rmSync(m.tmp, { force: true });
console.log("DONE");

