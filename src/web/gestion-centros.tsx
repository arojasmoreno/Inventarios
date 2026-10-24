import { useState } from "react";
import { CENTROS, ResourcePage, USUARIOS } from "./resources";
import { ZonasCentroPage } from "./zonas";
import { EmpresaPage } from "./empresa";

type Tab = "centros" | "zonas" | "usuarios" | "empresa";

const TABS: Array<{ id: Tab; label: string; icon: string; adminOnly?: boolean }> = [
  { id: "centros", label: "Centros", icon: "🏭" },
  { id: "zonas", label: "Zonas y subzonas", icon: "🗺️" },
  { id: "usuarios", label: "Usuarios", icon: "👥", adminOnly: true },
  { id: "empresa", label: "Empresa", icon: "🏢", adminOnly: true },
];

/** Sección «Gestión de centros»: los centros con sus zonas y subzonas, los
 *  usuarios (y sus centros asignados) y los datos de la empresa. */
export function GestionCentrosPage({ user }: { user: { rol: string; nombre: string; centro_id: number | null } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const inicial: Tab = hash === "#/zonas" ? "zonas"
    : hash === "#/usuarios" ? "usuarios"
    : hash === "#/empresa" ? "empresa" : "centros";
  const [tab, setTab] = useState<Tab>(inicial);

  const visibles = TABS.filter((t) => !t.adminOnly || user.rol === "admin");
  const activa = visibles.some((t) => t.id === tab) ? tab : visibles[0].id;

  return <>
    <div className="toolbar no-print" style={{ gap: 8, flexWrap: "wrap" }}>
      {visibles.map((t) => (
        <button key={t.id} className={"btn" + (activa === t.id ? "" : " secondary")} onClick={() => setTab(t.id)}>
          {t.icon} {t.label}
        </button>
      ))}
      <div className="spacer" />
      <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
        Centros con sus zonas, subzonas y operarios asignados
      </span>
    </div>
    {activa === "centros" && <ResourcePage key="centros" config={CENTROS} user={user} />}
    {activa === "zonas" && <ZonasCentroPage key="zonas" user={user} />}
    {activa === "usuarios" && <ResourcePage key="usuarios" config={USUARIOS} user={user} />}
    {activa === "empresa" && <EmpresaPage key="empresa" />}
  </>;
}
