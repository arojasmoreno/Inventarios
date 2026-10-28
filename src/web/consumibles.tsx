import { useState } from "react";
import { MATERIAL, QUIMICOS, ResourcePage, SOPORTES, TIPOS_CONSUMIBLES } from "./resources";
import { EstacionesPage } from "./estaciones";
import { InventarioQuimicosPage } from "./inventario";
import { StockPage } from "./stock";
import { ConsumosCostesPage } from "./costes";
import { PedidoMaterialPage, ProductosDisponiblesPage } from "./pedido";

type Tab = "quimicos" | "inventario" | "material" | "disponibles" | "pedido" | "estaciones" | "tipos" | "soportes" | "entradas" | "costes";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "quimicos", label: "Químicos", icon: "🧴" },
  { id: "inventario", label: "Inventario por producto", icon: "📦" },
  { id: "material", label: "Material de limpieza", icon: "🧽" },
  { id: "disponibles", label: "Productos disponibles", icon: "📋" },
  { id: "pedido", label: "Pedido material", icon: "🛒" },
  { id: "estaciones", label: "Estaciones de consumo", icon: "🚻" },
  { id: "tipos", label: "Tipos de consumible", icon: "🏷️" },
  { id: "soportes", label: "Soportes", icon: "📌" },
  { id: "entradas", label: "Entradas / Salidas", icon: "🔄" },
  { id: "costes", label: "Consumos", icon: "📊" },
];
// El perfil «Usuario» solo ve «Estaciones de consumo», «Entradas / Salidas»
// (esta última en solo lectura: registrar movimientos es de administradores)
// y el inventario de químicos, también en consulta.
const TABS_USUARIO: Tab[] = ["estaciones", "entradas", "inventario"];

/** Sección «Consumibles»: químicos y material de limpieza con su stock, las
 *  estaciones de consumo (QR que descuentan), los tipos de consumible, los
 *  soportes donde se instalan y el registro de entradas y salidas. */
export function ConsumiblesPage({ user }: { user: { rol: string; nombre: string; centro_id: number | null } }) {
  const hash = typeof window !== "undefined" ? window.location.hash : "";
  const inicial: Tab = hash === "#/material" ? "material"
    : hash === "#/productos-disponibles" ? "disponibles"
    : hash === "#/pedido-material" ? "pedido"
    : hash.startsWith("#/estaciones") ? "estaciones"
    : hash === "#/consumibles-tipos" ? "tipos"
    : hash === "#/soportes" ? "soportes"
    : hash === "#/entradas" ? "entradas"
    : hash === "#/inventario" ? "inventario"
    : hash === "#/costes" ? "costes" : "quimicos";
  const [tab, setTab] = useState<Tab>(inicial);

  const visibles = TABS.filter((t) => user.rol !== "usuario" || TABS_USUARIO.includes(t.id));
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
        Las estaciones descuentan el stock al escanear su QR
      </span>
    </div>
    {activa === "quimicos" && <ResourcePage key="quimicos" config={QUIMICOS} user={user} />}
    {activa === "inventario" && <InventarioQuimicosPage key="inventario" user={user} />}
    {activa === "material" && <ResourcePage key="material" config={MATERIAL} user={user} />}
    {activa === "disponibles" && <ProductosDisponiblesPage key="disponibles" user={user} />}
    {activa === "pedido" && <PedidoMaterialPage key="pedido" user={user} />}
    {activa === "estaciones" && <EstacionesPage key="estaciones" user={user} />}
    {activa === "tipos" && <ResourcePage key="tipos" config={TIPOS_CONSUMIBLES} user={user} />}
    {activa === "soportes" && <ResourcePage key="soportes" config={SOPORTES} user={user} />}
    {activa === "entradas" && <StockPage key="entradas" user={user} />}
    {activa === "costes" && <ConsumosCostesPage key="costes" />}
  </>;
}
