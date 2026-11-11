import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";

type Item = { id: number; nombre: string; extra: string | null; hash: string; categoria: string };

/** Búsqueda global de la barra superior: artículos, zonas, estaciones,
 *  documentación y usuarios, con un filtro por categoría. */
export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [categoria, setCategoria] = useState("all");
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const needle = q.trim();
    if (needle.length < 2) { setItems([]); setOpen(false); setLoading(false); return; }
    setLoading(true);
    // Pequeña espera para no lanzar una petición por pulsación.
    const t = window.setTimeout(() => {
      api.get<{ items: Item[] }>(`/api/buscar?q=${encodeURIComponent(needle)}`)
        .then((r) => { setItems(r.items); setOpen(true); })
        .catch(() => { setItems([]); setOpen(false); })
        .finally(() => setLoading(false));
    }, 280);
    return () => window.clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, []);

  const categorias = useMemo(
    () => [...new Set(items.map((i) => i.categoria))].sort((a, b) => a.localeCompare(b, "es")),
    [items],
  );
  const visibles = categoria === "all" ? items : items.filter((i) => i.categoria === categoria);
  const go = (it: Item) => { window.location.hash = it.hash; setQ(""); setOpen(false); setCategoria("all"); };

  return <div className="global-search" ref={boxRef}>
    <input className="input" style={{ maxWidth: 230 }} placeholder="🔎 Buscar en todo…" aria-label="Búsqueda global"
      value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => { if (items.length) setOpen(true); }} />
    {open && <div className="search-results">
      <div className="chips" style={{ marginBottom: 6 }}>
        <button className={"badge" + (categoria === "all" ? " info" : " muted")} onClick={() => setCategoria("all")}>Todo</button>
        {categorias.map((c) => <button key={c} className={"badge" + (categoria === c ? " info" : " muted")} onClick={() => setCategoria(c)}>{c}</button>)}
      </div>
      {loading && <div className="search-item muted">Buscando…</div>}
      {!loading && !visibles.length && <div className="search-item muted">Sin resultados para «{q.trim()}»{categoria !== "all" ? ` en ${categoria}` : ""}</div>}
      {visibles.map((it) => <button key={`${it.hash}-${it.id}-${it.categoria}`} className="search-item" onClick={() => go(it)}>
        <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>{it.nombre}{it.extra ? <span style={{ color: "var(--muted)", fontSize: 12 }}> · {it.extra}</span> : null}</span>
        <span className="badge muted" style={{ fontSize: 11 }}>{it.categoria}</span>
      </button>)}
    </div>}
  </div>;
}
