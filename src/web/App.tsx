import { Fragment, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { Field, Toast, camposConError } from "./ui";
import { QUIMICOS, ResourcePage, type ResourceConfig } from "./resources";
import { ConsumiblesPage } from "./consumibles";
import { GestionCentrosPage } from "./gestion-centros";
import { GestionInformesPage } from "./gestion-informes";
import { MaquinariaPage } from "./maquinaria";
import { EquipacionPage } from "./equipacion";
import { PanelPage } from "./panel";
import { GlobalSearch } from "./busqueda";
import { DocumentosPage } from "./documentos";
import { AyudaPage } from "./ayuda";export interface User {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  rol: "admin" | "admin_centros" | "usuario";
  activo: boolean;
  centro_id: number | null;
  /** Centros asignados al usuario (asignación multi `usuario_centros`). */
  centros?: { id: number; nombre: string }[];
}

interface NavItem {
  hash: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  resource?: ResourceConfig;
}
interface NavGroup {
  section: string;
  items: NavItem[];
}

// Menú lateral agrupado por secciones (iconos de la web de referencia).
const NAV: NavGroup[] = [
  {
    section: "Resumen",
    items: [
      { hash: "#/panel", label: "Panel de control", icon: "🏠" },
    ],
  },
  {
    section: "Consumibles",
    items: [
      { hash: "#/consumibles", label: "Consumibles", icon: "🧴" },
      { hash: "#/inventario", label: "Inventario de químicos", icon: "📦" },
    ],
  },
  {
    section: "Maquinaria",
    items: [
      { hash: "#/maquinaria", label: "Control de maquinaria", icon: "🧭" },
    ],
  },
  {
    section: "Equipación",
    items: [
      { hash: "#/equipacion", label: "Equipación de operarios", icon: "🦺" },
    ],
  },
  {
    section: "Gestión de centros",
    items: [
      { hash: "#/gestion-centros", label: "Gestión de centros", icon: "🏙️" },
    ],
  },
  {
    section: "Gestión",
    items: [
      { hash: "#/documentacion", label: "Documentación", icon: "📚" },
    ],
  },
  {
    section: "Gestión de informes",
    items: [
      { hash: "#/gestion-informes", label: "Gestión de informes", icon: "📈" },
    ],
  },
  {
    section: "Ayuda",
    items: [
      { hash: "#/ayuda", label: "Manuales y ayuda", icon: "🛟" },
    ],
  },
];

// Menú del perfil «Usuario»: solo estaciones de consumo, entradas y salidas,
// maquinaria, documentación, gestión de informes y manuales. No ve el panel de
// control, los consumibles completos, la equipación ni la gestión de centros.
const NAV_USUARIO: NavGroup[] = [
  {
    section: "Consumibles",
    items: [
      { hash: "#/estaciones", label: "Estaciones de consumo", icon: "🚻" },
      { hash: "#/entradas", label: "Entradas y salidas", icon: "🔄" },
      { hash: "#/inventario", label: "Inventario de químicos", icon: "📦" },
    ],
  },
  {
    section: "Maquinaria",
    items: [
      { hash: "#/maquinaria", label: "Control de maquinaria", icon: "🧭" },
    ],
  },
  {
    section: "Gestión",
    items: [
      { hash: "#/documentacion", label: "Documentación", icon: "📚" },
    ],
  },
  {
    section: "Gestión de informes",
    items: [
      { hash: "#/gestion-informes", label: "Gestión de informes", icon: "📈" },
    ],
  },
  {
    section: "Ayuda",
    items: [
      { hash: "#/ayuda", label: "Manuales y ayuda", icon: "🛟" },
    ],
  },
];

const rolLabel = (rol: string) => (rol === "admin" ? "Administrador" : rol === "admin_centros" ? "Administrador de centros" : "Usuario");
const rolBadge = (rol: string) => (rol === "admin" ? "info" : rol === "admin_centros" ? "warn" : "muted");

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<string>(() => window.location.hash || "#/panel");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/panel");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.get<{ user: User }>("/api/auth/me").then((r) => { if (!cancelled) setUser(r.user); }).catch(() => { if (!cancelled) setUser(null); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  // Con sesión iniciada y sin sección concreta, la URL refleja la primera
  // sección del rol: el panel de control para administradores y las
  // estaciones de consumo para el perfil usuario.
  useEffect(() => { if (user && !window.location.hash) window.location.hash = user.rol === "usuario" ? "#/estaciones" : "#/panel"; }, [user]);
  if (loading) return <div className="loading">Cargando Inventarios…</div>;
  if (!user) return <Login onLoggedIn={setUser} />;
  return <Shell user={user} route={route} onUserChange={setUser} />;

}

// Campos de los formularios de acceso: sirven para localizar, en un mensaje
// de error, el campo que hay que sombrear en rojo.
const ETIQUETAS_AUTH = [
  { clave: "cl", etiqueta: "Correo" }, { clave: "clc", etiqueta: "Código" },
  { clave: "re", etiqueta: "Correo" }, { clave: "rc", etiqueta: "Código" },
  { clave: "np", etiqueta: "Contraseña" }, { clave: "np2", etiqueta: "Repite la contraseña" },
];

function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"login" | "recover" | "code">("login");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await api.post<{ user: User }>("/api/auth/login", { username, password }); onLoggedIn(r.user); }
    catch (err) { setError(err instanceof Error ? err.message : "Error de acceso"); setCampoErr(["u", "p"]); }
    finally { setBusy(false); }
  };
  if (view === "recover") return <Recover onBack={() => setView("login")} />;
  if (view === "code") return <CodeLogin onLoggedIn={onLoggedIn} onBack={() => setView("login")} />;
  // Portada pública (estilo Doc Manager): presentación de la aplicación a la
  // izquierda y tarjeta de acceso a la derecha. El botón lleva al formulario.
  const irAlAcceso = () => {
    document.querySelector(".login-card")?.scrollIntoView({ behavior: "smooth", block: "center" });
    window.setTimeout(() => document.getElementById("u")?.focus(), 350);
  };
  return <div className="login-wrap landing">
    <section className="landing-intro">
      <span className="landing-eyebrow">📦 Gestión de planta</span>
      <h1>Inventarios</h1>
      <p className="landing-sub">Químicos · Material de limpieza · Maquinaria</p>
      <p className="landing-desc">Gestiona el inventario de tus centros de trabajo desde un solo lugar: consumibles con control de stock y caducidad, estaciones de consumo con QR, maquinaria con su histórico de estados y equipación de operarios, con informes y manuales listos para descargar.</p>
      <div className="landing-features">
        <div className="landing-feature"><span className="fi">🧴</span><div><h3>Consumibles</h3><p>Fichas de químicos y limpieza con lotes, litros y alertas de stock.</p></div></div>
        <div className="landing-feature"><span className="fi">🚻</span><div><h3>Estaciones QR</h3><p>Descuentan el stock al escanear, agrupadas por centro y zona.</p></div></div>
        <div className="landing-feature"><span className="fi">🧭</span><div><h3>Maquinaria</h3><p>Histórico de situaciones por máquina y fecha: operativo, averiado, baja…</p></div></div>
        <div className="landing-feature"><span className="fi">📈</span><div><h3>Informes</h3><p>Panel con KPIs, exportaciones CSV y manuales descargables.</p></div></div>
      </div>
      <div className="landing-cta">
        <button type="button" className="landing-btn" onClick={irAlAcceso}>🔑 Entrar en la aplicación</button>
      </div>
    </section>
    <form className="login-card" onSubmit={submit}>
    <h1>Iniciar sesión</h1><p className="sub">Accede con tu usuario para continuar</p>
    {error && <div className="form-error">{error}</div>}
    <div className={"field" + (campoErr.includes("u") ? " error" : "")} style={{ marginBottom: 12 }}><label htmlFor="u">Usuario</label><input id="u" className={"input" + (campoErr.includes("u") ? " error" : "")} autoComplete="username" value={username} onChange={(e) => { setCampoErr([]); setUsername(e.target.value); }} required /></div>
    <div className={"field" + (campoErr.includes("p") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="p">Contraseña</label><input id="p" className={"input" + (campoErr.includes("p") ? " error" : "")} type="password" autoComplete="current-password" value={password} onChange={(e) => { setCampoErr([]); setPassword(e.target.value); }} required /></div>
    <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
    <button type="button" className="login-link" onClick={() => setView("code")}>🔑 Entrar con código por correo</button>
    <button type="button" className="login-link" onClick={() => setView("recover")}>¿Has olvidado tu contraseña?</button>
  </form></div>;
}

/** Acceso sin contraseña: pide el correo, envía un código y abre sesión. */
function CodeLogin({ onLoggedIn, onBack }: { onLoggedIn: (u: User) => void; onBack: () => void }) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ token: string; message?: string }>("/api/auth/request-login-code", { email });
      setToken(r.token);
      setInfo(r.message ?? "Si el correo existe en el sistema, recibirás un código de verificación.");
      setStep("code");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al enviar el código"); setCampoErr(camposConError(err instanceof Error ? err.message : "", ETIQUETAS_AUTH)); }
    finally { setBusy(false); }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ user: User }>("/api/auth/verify-login-code", { token, code });
      onLoggedIn(r.user);
    } catch (err) { setError(err instanceof Error ? err.message : "Error al verificar el código"); setCampoErr(camposConError(err instanceof Error ? err.message : "", ETIQUETAS_AUTH)); }
    finally { setBusy(false); }
  };

  const subtitle = step === "email" ? "Paso 1 de 2 · Te enviaremos un código por correo" : "Paso 2 de 2 · Introduce el código recibido";

  return <div className="login-wrap"><div className="login-card">
    <h1>Entrar con código</h1><p className="sub">{subtitle}</p>
    {error && <div className="form-error">{error}</div>}
    {step === "email" && <form onSubmit={sendCode}>
      <div className={"field" + (campoErr.includes("cl") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="cl">Correo electrónico</label><input id="cl" className={"input" + (campoErr.includes("cl") ? " error" : "")} type="email" autoComplete="email" placeholder="tu@empresa.com" value={email} onChange={(e) => { setCampoErr([]); setEmail(e.target.value); }} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Enviando…" : "Enviar código"}</button>
      <button type="button" className="login-link" onClick={onBack}>Volver al inicio de sesión</button>
    </form>}
    {step === "code" && <form onSubmit={verifyCode}>
      {info && <div className="login-hint" style={{ marginTop: 0, marginBottom: 14 }}>{info}</div>}
      <div className={"field" + (campoErr.includes("clc") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="clc">Código de verificación</label><input id="clc" className={"input" + (campoErr.includes("clc") ? " error" : "")} autoComplete="one-time-code" maxLength={8} placeholder="XXXXXXXX" style={{ textTransform: "uppercase", letterSpacing: "3px", fontWeight: 600 }} value={code} onChange={(e) => { setCampoErr([]); setCode(e.target.value.toUpperCase()); }} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy || code.trim().length < 4}>{busy ? "Entrando…" : "Entrar"}</button>
      <button type="button" className="login-link" onClick={() => { setStep("email"); setError(null); setCode(""); }}>Usar otro correo</button>
    </form>}
  </div></div>;
}

function Recover({ onBack }: { onBack: () => void }) {
  const [step, setStep] = useState<"email" | "code" | "password" | "done">("email");
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ token: string; message?: string }>("/api/auth/request-password-reset", { email });
      setToken(r.token);
      setInfo(r.message ?? "Si el correo existe en el sistema, recibirás un código de verificación.");
      setStep("code");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al enviar el código"); setCampoErr(camposConError(err instanceof Error ? err.message : "", ETIQUETAS_AUTH)); }
    finally { setBusy(false); }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ message?: string }>("/api/auth/verify-password-reset", { token, code });
      setInfo(r.message ?? "Código verificado.");
      setStep("password");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al verificar el código"); setCampoErr(camposConError(err instanceof Error ? err.message : "", ETIQUETAS_AUTH)); }
    finally { setBusy(false); }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError("Las contraseñas no coinciden"); setCampoErr(["np", "np2"]); return; }
    setBusy(true); setError(null);
    try {
      await api.post<{ message?: string }>("/api/auth/finish-password-reset", { token, password });
      setStep("done");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al guardar la contraseña"); setCampoErr(camposConError(err instanceof Error ? err.message : "", ETIQUETAS_AUTH)); }
    finally { setBusy(false); }
  };

  const subtitle = step === "email" ? "Paso 1 de 3 · Te enviaremos un código por correo"
    : step === "code" ? "Paso 2 de 3 · Introduce el código recibido"
    : step === "password" ? "Paso 3 de 3 · Elige una nueva contraseña"
    : "Contraseña restablecida";

  return <div className="login-wrap"><div className="login-card">
    <h1>Recuperar contraseña</h1><p className="sub">{subtitle}</p>
    {error && <div className="form-error">{error}</div>}
    {step === "email" && <form onSubmit={sendCode}>
      <div className={"field" + (campoErr.includes("re") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="re">Correo electrónico</label><input id="re" className={"input" + (campoErr.includes("re") ? " error" : "")} type="email" autoComplete="email" placeholder="tu@empresa.com" value={email} onChange={(e) => { setCampoErr([]); setEmail(e.target.value); }} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Enviando…" : "Enviar código"}</button>
      <button type="button" className="login-link" onClick={onBack}>Volver al inicio de sesión</button>
    </form>}
    {step === "code" && <form onSubmit={verifyCode}>
      {info && <div className="login-hint" style={{ marginTop: 0, marginBottom: 14 }}>{info}</div>}
      <div className={"field" + (campoErr.includes("rc") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="rc">Código de verificación</label><input id="rc" className={"input" + (campoErr.includes("rc") ? " error" : "")} autoComplete="one-time-code" maxLength={8} placeholder="XXXXXXXX" style={{ textTransform: "uppercase", letterSpacing: "3px", fontWeight: 600 }} value={code} onChange={(e) => { setCampoErr([]); setCode(e.target.value.toUpperCase()); }} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy || code.trim().length < 4}>{busy ? "Verificando…" : "Verificar código"}</button>
      <button type="button" className="login-link" onClick={() => { setStep("email"); setError(null); }}>Usar otro correo</button>
    </form>}
    {step === "password" && <form onSubmit={savePassword}>
      <div className={"field" + (campoErr.includes("np") ? " error" : "")} style={{ marginBottom: 12 }}><label htmlFor="np">Nueva contraseña</label><input id="np" className={"input" + (campoErr.includes("np") ? " error" : "")} type="password" autoComplete="new-password" minLength={6} value={password} onChange={(e) => { setCampoErr([]); setPassword(e.target.value); }} required /></div>
      <div className={"field" + (campoErr.includes("np2") ? " error" : "")} style={{ marginBottom: 16 }}><label htmlFor="np2">Repite la contraseña</label><input id="np2" className={"input" + (campoErr.includes("np2") ? " error" : "")} type="password" autoComplete="new-password" minLength={6} value={confirm} onChange={(e) => { setCampoErr([]); setConfirm(e.target.value); }} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button>
    </form>}
    {step === "done" && <div>
      <div className="login-hint" style={{ marginTop: 0, marginBottom: 16 }}>La contraseña se ha restablecido correctamente. Ya puedes iniciar sesión con tu nueva contraseña.</div>
      <button className="btn" style={{ width: "100%" }} onClick={onBack}>Ir al inicio de sesión</button>
    </div>}
  </div></div>;
}

function Shell({ user, route, onUserChange }: { user: User; route: string; onUserChange: (u: User | null) => void }) {
  const [logoutToast, setLogoutToast] = useState(false);
  const logout = useCallback(async () => {
    try { await api.post("/api/auth/logout", {}); } catch { /* la sesión puede haber caducado */ }
    setLogoutToast(true); onUserChange(null); window.location.hash = "";
  }, [onUserChange]);
  const esLegacy = route === "#/ropa" || route === "#/epis" || route === "#/tallas" || route === "#/tipos-equipo" || route.startsWith("#/entregas");
  // «Tipos de maquinaria» ahora vive como pestaña de Control de maquinaria.
  const esTiposMaquinaria = route === "#/tipos";
  // Rutas antiguas que ahora son pestañas de la sección Consumibles.
  const esConsumibles = route === "#/consumibles" || route === "#/quimicos" || route === "#/material" || route.startsWith("#/estaciones")
    || route === "#/consumibles-tipos" || route === "#/soportes" || route === "#/entradas" || route === "#/costes"
    || route === "#/inventario";
  // Rutas de la sección Gestión de centros (su propia ruta y las antiguas).
  const esGestionCentros = route === "#/gestion-centros" || route === "#/centros" || route === "#/zonas" || route === "#/usuarios" || route === "#/empresa";
  // Rutas de la sección Gestión de informes (su propia ruta y las antiguas).
  const esGestionInformes = route === "#/gestion-informes" || route === "#/movimientos" || route === "#/importar" || route === "#/informes";
  // Menú y rutas permitidas según el rol: el perfil «Usuario» solo tiene
  // acceso a las secciones de su lista; cualquier otra ruta redirige a
  // «Estaciones de consumo».
  const gruposBase = user.rol === "usuario" ? NAV_USUARIO : NAV;
  const nav = (hash: string) => gruposBase.flatMap((g) => g.items).find((n) => n.hash === hash) ?? gruposBase[0].items[0];
  const permitida = user.rol !== "usuario" || esConsumibles || esGestionInformes
    || route === "#/maquinaria" || route === "#/tipos" || route === "#/documentacion"
    || route === "#/ayuda" || route === "#/cuenta";
  useEffect(() => { if (!permitida) window.location.hash = "#/estaciones"; }, [permitida, route]);
  const flat = gruposBase.flatMap((g) => g.items);
  const active = flat.find((n) => n.hash === route || route.startsWith(`${n.hash}?`))
    ?? (esLegacy ? nav("#/equipacion")
      : esTiposMaquinaria ? nav("#/maquinaria")
      : esConsumibles ? nav("#/consumibles")
      : esGestionCentros ? nav("#/gestion-centros")
      : esGestionInformes ? nav("#/gestion-informes") : flat[0]);
  // Ruta fuera del menú del rol: se redirige a la primera sección permitida.
  if (!permitida) return <div className="loading">Abriendo tu sección…</div>;
  let page: ReactNode;
  if (route === "#/ayuda") page = <AyudaPage user={user} />;
  else if (route === "#/cuenta") page = <MiCuenta user={user} />;
  else if (route === "#/panel") page = <PanelPage user={user} />;
  else if (esConsumibles) page = <ConsumiblesPage key={route} user={user} />;
  else if (esGestionCentros) page = <GestionCentrosPage key={route} user={user} />;
  else if (esGestionInformes) page = <GestionInformesPage key={route} user={user} />;
  else if (route === "#/maquinaria" || route === "#/tipos") page = <MaquinariaPage key={route} user={user} />;
  else if (route === "#/documentacion") page = <DocumentosPage user={user} />;
  else if (route === "#/equipacion" || route === "#/ropa" || route === "#/epis" || route === "#/tallas" || route === "#/tipos-equipo" || route.startsWith("#/entregas")) page = <EquipacionPage user={user} />;
  else if (active.resource) page = <ResourcePage key={route} config={active.resource} user={user} />;
  else page = <ResourcePage key="#/quimicos" config={QUIMICOS} user={user} />;
  const grupos = gruposBase
    .map((g) => ({ ...g, items: g.items.filter((n) => !n.adminOnly || user.rol === "admin") }))
    .filter((g) => g.items.length > 0);
  // Centros del usuario para la cabecera (los administradores ven todos).
  const centrosTexto = user.centros && user.centros.length > 0
    ? user.centros.map((c) => c.nombre).join(" · ")
    : user.rol === "admin" ? "Todos los centros" : "Sin centros asignados";
  return <div className="app">
    <aside className="sidebar no-print"><div className="brand"><span className="logo">📦</span> Inventarios</div>
      {grupos.map((g) => <Fragment key={g.section}>
        <div className="nav-section">{g.section}</div>
        {g.items.map((n) => <a key={n.hash} className={"nav-item" + (n.hash === active.hash ? " active" : "")} href={n.hash}><span>{n.icon}</span> {n.label}</a>)}
      </Fragment>)}
      <div className="nav-section">Cuenta</div><a className={"nav-item" + (route === "#/cuenta" ? " active" : "")} href="#/cuenta"><span>⚙️</span> Mi cuenta</a>
      <div className="sidebar-footer"><div className="who">{user.nombre}</div><div>{rolLabel(user.rol)}</div><button className="btn secondary small" style={{ marginTop: 10 }} onClick={logout}>Cerrar sesión</button></div>
    </aside>
    <main className="main"><header className="topbar"><div><h1>{route === "#/cuenta" ? "Mi cuenta" : (active.label ?? "Inventarios")}</h1><p>{route === "#/cuenta" ? "Datos de acceso y contraseña" : "Gestión del inventario de planta"}</p></div><div className="topbar-right no-print">
        <GlobalSearch />
        <div className="user-box">
          <div className="user-box-info">
            <span className="user-box-name" title={user.username}>{user.nombre}</span>
            <span className="user-box-status">
              <span className={`badge ${rolBadge(user.rol)}`}>{rolLabel(user.rol)}</span>
              <span className={`badge ${user.activo ? "ok" : "danger"}`}>{user.activo ? "● Activo" : "● Inactivo"}</span>
            </span>
            <span className="user-box-centros" title={centrosTexto}>🏢 {centrosTexto}</span>
          </div>
          <button className="btn secondary small" title="Salir de la aplicación" onClick={logout}>⏻ Salir</button>
        </div>
      </div></header><div className="content">{page}</div></main>
    {logoutToast && <Toast message="Sesión cerrada. Hasta pronto." kind="ok" onClose={() => setLogoutToast(false)} />}
  </div>;
}

function MiCuenta({ user }: { user: User }) {
  const actualField = { name: "actual", label: "Contraseña actual", type: "password" as const, required: true };
  const nuevaField = { name: "nueva", label: "Nueva contraseña", type: "password" as const, required: true, help: "Mínimo 6 caracteres" };
  const [values, setValues] = useState<Record<string, unknown>>({ actual: "", nueva: "" });
  // Campos que han fallado al validar (se sombrean en rojo).
  const [campoErr, setCampoErr] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await api.post("/api/auth/cambiar-password", { actual: values.actual, nueva: values.nueva }); setValues({ actual: "", nueva: "" }); setMsg({ message: "Contraseña actualizada correctamente", kind: "ok" }); }
    catch (err) { setMsg({ message: err instanceof Error ? err.message : "Error al cambiar la contraseña", kind: "error" }); setCampoErr(camposConError(err instanceof Error ? err.message : "", [{ clave: "actual", etiqueta: "Contraseña actual" }, { clave: "nueva", etiqueta: "Nueva contraseña" }])); }
    finally { setBusy(false); }
  };
  return <>
    <div className="card card-pad" style={{ maxWidth: 560 }}><div className="section-head"><h3>Datos de acceso</h3></div><table><tbody><tr><th>Usuario</th><td>{user.username}</td></tr><tr><th>Nombre</th><td>{user.nombre}</td></tr><tr><th>Email</th><td>{user.email ?? "—"}</td></tr><tr><th>Rol</th><td>{rolLabel(user.rol)}</td></tr></tbody></table></div>
    <form className="card card-pad" style={{ maxWidth: 560 }} onSubmit={submit}><div className="section-head"><h3>Cambiar contraseña</h3></div>
      {msg && <div className={"banner " + (msg.kind === "ok" ? "" : "danger")} style={{ marginBottom: 12 }}>{msg.message}</div>}
      <div className="form-grid"><div className="full"><Field def={actualField} value={values.actual} onChange={(v) => { setCampoErr((prev) => prev.filter((k) => k !== "actual")); setValues({ ...values, actual: v }); }} error={campoErr.includes("actual")} /></div><div className="full"><Field def={nuevaField} value={values.nueva} onChange={(v) => { setCampoErr((prev) => prev.filter((k) => k !== "nueva")); setValues({ ...values, nueva: v }); }} error={campoErr.includes("nueva")} /></div></div>
      <div className="modal-footer"><button className="btn" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button></div>
    </form>
  </>;
}
