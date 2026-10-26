import { useState } from "react";
import { MOVIMIENTOS, ResourcePage } from "./resources";
import { ImportarPage } from "./importar";
import { Informes } from "./Informes";
import { Dashboard } from "./dashboard";
import { DescargasPage } from "./descargas";

type Tab = "dashboard" | "informes" | "auditoria" | "descargas" | "importar";

const TABS: Array<{ id: Tab; label: string; icon: string; adminOnly?: boolean }> = [
  { id: "dashboard", label: "Dashboard", icon: "📊" },
  { id: "informes", label: "Informes", icon: "📈" },
  { id: "auditoria", label: "Auditoría", icon: "📋" },
  { id: "descargas", label: "Copias de seguridad", icon: "💾", adminOnly: true },
  { id: "importar", label: "Importar CSV", icon: "📤", adminOnly: true },
];

/** Sección «Gestión de informes»: el dashboard con todos los datos, los
 *  informes del inventario, la auditoría de movimientos y la importación de
 *  datos por CSV. */
export function GestionInformesPage({ user }: { user: { rol: string } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const inicial: Tab = hash === "#/movimientos" ? "auditoria"
    : hash === "#/importar" ? "importar"
    : hash === "#/informes" ? "informes" : "dashboard";
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
        Dashboard, informes, auditoría, copias de seguridad e importación de CSV
      </span>
    </div>
    {activa === "dashboard" && <Dashboard key="dashboard" user={user} />}
    {activa === "informes" && <Informes key="informes" user={user} />}
    {activa === "auditoria" && <ResourcePage key="auditoria" config={MOVIMIENTOS} user={user} />}
    {activa === "descargas" && (user.rol === "admin"
      ? <DescargasPage key="descargas" />
      : <div className="card empty"><span className="icon">🔒</span><strong>Sección restringida</strong><p>Solo los administradores pueden descargar las copias.</p></div>)}
    {activa === "importar" && (user.rol === "admin"
      ? <ImportarPage key="importar" />
      : <div className="card empty"><span className="icon">🔒</span><strong>Sección restringida</strong><p>Solo los administradores pueden importar datos.</p></div>)}
  </>;
}
