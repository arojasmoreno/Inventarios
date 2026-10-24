import { useState } from "react";
import { EPIS, ROPA, ResourcePage, TALLAS, TIPOS_EQUIPO } from "./resources";
import { EntregaPage } from "./entrega";

type Tab = "ropa" | "epis" | "entregas" | "tipos" | "tallas";

const TABS: Array<{ id: Tab; label: string; icon: string; adminOnly?: boolean }> = [
  { id: "ropa", label: "Ropa de trabajo", icon: "🥼" },
  { id: "epis", label: "EPIs", icon: "🦺" },
  { id: "entregas", label: "Entregas", icon: "👕" },
  { id: "tipos", label: "Tipos de equipo", icon: "🧷" },
  { id: "tallas", label: "Tallas operarios", icon: "📏", adminOnly: true },
];

/** Sección «Equipación de operarios»: catálogos de ropa y EPIs con su
 *  inventario, registro de entregas (descuentan stock), tipos de equipo y
 *  tallas de los operarios, todo junto. */
export function EquipacionPage({ user }: { user: { rol: string; centro_id: number | null } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const inicial: Tab = hash === "#/epis" ? "epis"
    : hash.startsWith("#/entregas") ? "entregas"
    : hash === "#/tipos-equipo" ? "tipos"
    : hash === "#/tallas" ? "tallas" : "ropa";
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
        Las entregas descuentan el stock automáticamente · no es consumible
      </span>
    </div>
    {activa === "ropa" && <ResourcePage key="ropa" config={ROPA} user={user} />}
    {activa === "epis" && <ResourcePage key="epis" config={EPIS} user={user} />}
    {activa === "entregas" && <EntregaPage key="entregas" user={user} />}
    {activa === "tipos" && <ResourcePage key="tipos" config={TIPOS_EQUIPO} user={user} />}
    {activa === "tallas" && <ResourcePage key="tallas" config={TALLAS} user={user} />}
  </>;
}
