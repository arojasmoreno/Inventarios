import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { Field, Toast } from "./ui";
import { CENTROS, MAQUINARIA, MATERIAL, QUIMICOS, ResourcePage, USUARIOS, type ResourceConfig } from "./resources";
import { Informes } from "./Informes";

export interface User {
  id: number;
  username: string;
  nombre: string;
  email: string | null;
  rol: "admin" | "usuario";
  activo: boolean;
  centro_id: number | null;
}

interface NavItem {
  hash: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
  resource?: ResourceConfig;
}

const NAV: NavItem[] = [
  { hash: "#/quimicos", label: "Químicos", icon: "🧴", resource: QUIMICOS },
  { hash: "#/material", label: "Material de limpieza", icon: "🧽", resource: MATERIAL },
  { hash: "#/maquinaria", label: "Maquinaria", icon: "🧹", resource: MAQUINARIA },
  { hash: "#/centros", label: "Centros", icon: "🏭", resource: CENTROS },
  { hash: "#/usuarios", label: "Usuarios", icon: "👥", adminOnly: true, resource: USUARIOS },
  { hash: "#/informes", label: "Informes", icon: "📊" },
];

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [route, setRoute] = useState<string>(() => window.location.hash || "#/quimicos");
  useEffect(() => {
    const onHash = () => setRoute(window.location.hash || "#/quimicos");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.get<{ user: User }>("/api/auth/me").then((r) => { if (!cancelled) setUser(r.user); }).catch(() => { if (!cancelled) setUser(null); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  if (loading) return <div className="loading">Cargando Inventarios…</div>;
  if (!user) return <Login onLoggedIn={setUser} />;
  return <Shell user={user} route={route} onUserChange={setUser} />;
}

function Login({ onLoggedIn }: { onLoggedIn: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"login" | "recover">("login");
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { const r = await api.post<{ user: User }>("/api/auth/login", { username, password }); onLoggedIn(r.user); }
    catch (err) { setError(err instanceof Error ? err.message : "Error de acceso"); }
    finally { setBusy(false); }
  };
  if (view === "recover") return <Recover onBack={() => setView("login")} />;
  return <div className="login-wrap"><form className="login-card" onSubmit={submit}>
    <h1>Inventarios</h1><p className="sub">Químicos · Material de limpieza · Maquinaria</p>
    {error && <div className="form-error">{error}</div>}
    <div className="field" style={{ marginBottom: 12 }}><label htmlFor="u">Usuario</label><input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
    <div className="field" style={{ marginBottom: 16 }}><label htmlFor="p">Contraseña</label><input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
    <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Entrando…" : "Entrar"}</button>
    <button type="button" className="login-link" onClick={() => setView("recover")}>¿Has olvidado tu contraseña?</button>
    <div className="login-hint">Primer acceso: <strong>admin / admin123</strong> (administrador) y <strong>operario / operario123</strong> (usuario). Cambia las contraseñas desde <em>Usuarios</em> o <em>Mi cuenta</em>.</div>
  </form></div>;
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
  const [busy, setBusy] = useState(false);

  const sendCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ token: string; message?: string }>("/api/auth/request-password-reset", { email });
      setToken(r.token);
      setInfo(r.message ?? "Si el correo existe en el sistema, recibirás un código de verificación.");
      setStep("code");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al enviar el código"); }
    finally { setBusy(false); }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api.post<{ message?: string }>("/api/auth/verify-password-reset", { token, code });
      setInfo(r.message ?? "Código verificado.");
      setStep("password");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al verificar el código"); }
    finally { setBusy(false); }
  };

  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) { setError("Las contraseñas no coinciden"); return; }
    setBusy(true); setError(null);
    try {
      await api.post<{ message?: string }>("/api/auth/finish-password-reset", { token, password });
      setStep("done");
    } catch (err) { setError(err instanceof Error ? err.message : "Error al guardar la contraseña"); }
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
      <div className="field" style={{ marginBottom: 16 }}><label htmlFor="re">Correo electrónico</label><input id="re" className="input" type="email" autoComplete="email" placeholder="tu@empresa.com" value={email} onChange={(e) => setEmail(e.target.value)} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy}>{busy ? "Enviando…" : "Enviar código"}</button>
      <button type="button" className="login-link" onClick={onBack}>Volver al inicio de sesión</button>
    </form>}
    {step === "code" && <form onSubmit={verifyCode}>
      {info && <div className="login-hint" style={{ marginTop: 0, marginBottom: 14 }}>{info}</div>}
      <div className="field" style={{ marginBottom: 16 }}><label htmlFor="rc">Código de verificación</label><input id="rc" className="input" autoComplete="one-time-code" maxLength={8} placeholder="XXXXXXXX" style={{ textTransform: "uppercase", letterSpacing: "3px", fontWeight: 600 }} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required /></div>
      <button className="btn" style={{ width: "100%" }} disabled={busy || code.trim().length < 4}>{busy ? "Verificando…" : "Verificar código"}</button>
      <button type="button" className="login-link" onClick={() => { setStep("email"); setError(null); }}>Usar otro correo</button>
    </form>}
    {step === "password" && <form onSubmit={savePassword}>
      <div className="field" style={{ marginBottom: 12 }}><label htmlFor="np">Nueva contraseña</label><input id="np" className="input" type="password" autoComplete="new-password" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
      <div className="field" style={{ marginBottom: 16 }}><label htmlFor="np2">Repite la contraseña</label><input id="np2" className="input" type="password" autoComplete="new-password" minLength={6} value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></div>
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
  const active = NAV.find((n) => n.hash === route) ?? NAV[0];
  let page: ReactNode;
  if (route === "#/cuenta") page = <MiCuenta user={user} />;
  else if (route === "#/informes") page = <Informes />;
  else if (active.resource) page = <ResourcePage key={route} config={active.resource} user={user} />;
  else page = <ResourcePage key="#/quimicos" config={QUIMICOS} user={user} />;
  return <div className="app">
    <aside className="sidebar no-print"><div className="brand"><span className="logo">📦</span> Inventarios</div><div className="nav-section">Inventario</div>
      {NAV.filter((n) => !n.adminOnly || user.rol === "admin").map((n) => <a key={n.hash} className={"nav-item" + (n.hash === active.hash ? " active" : "")} href={n.hash}><span>{n.icon}</span> {n.label}</a>)}
      <div className="nav-section">Cuenta</div><a className={"nav-item" + (route === "#/cuenta" ? " active" : "")} href="#/cuenta"><span>⚙️</span> Mi cuenta</a>
      <div className="sidebar-footer"><div className="who">{user.nombre}</div><div>{user.rol === "admin" ? "Administrador" : "Usuario"}</div><button className="btn secondary small" style={{ marginTop: 10 }} onClick={logout}>Cerrar sesión</button></div>
    </aside>
    <main className="main"><header className="topbar"><div><h1>{route === "#/cuenta" ? "Mi cuenta" : (active.label ?? "Inventarios")}</h1><p>{route === "#/cuenta" ? "Datos de acceso y contraseña" : "Gestión del inventario de planta"}</p></div><div className="no-print"><span className={`badge ${user.rol === "admin" ? "info" : "muted"}`}>{user.rol === "admin" ? "Administrador" : "Usuario"}</span></div></header><div className="content">{page}</div></main>
    {logoutToast && <Toast message="Sesión cerrada. Hasta pronto." kind="ok" onClose={() => setLogoutToast(false)} />}
  </div>;
}

function MiCuenta({ user }: { user: User }) {
  const actualField = { name: "actual", label: "Contraseña actual", type: "password" as const, required: true };
  const nuevaField = { name: "nueva", label: "Nueva contraseña", type: "password" as const, required: true, help: "Mínimo 6 caracteres" };
  const [values, setValues] = useState<Record<string, unknown>>({ actual: "", nueva: "" });
  const [msg, setMsg] = useState<{ message: string; kind: "ok" | "error" } | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setMsg(null);
    try { await api.post("/api/auth/cambiar-password", { actual: values.actual, nueva: values.nueva }); setValues({ actual: "", nueva: "" }); setMsg({ message: "Contraseña actualizada correctamente", kind: "ok" }); }
    catch (err) { setMsg({ message: err instanceof Error ? err.message : "Error al cambiar la contraseña", kind: "error" }); }
    finally { setBusy(false); }
  };
  return <>
    <div className="card card-pad" style={{ maxWidth: 560 }}><div className="section-head"><h3>Datos de acceso</h3></div><table><tbody><tr><th>Usuario</th><td>{user.username}</td></tr><tr><th>Nombre</th><td>{user.nombre}</td></tr><tr><th>Email</th><td>{user.email ?? "—"}</td></tr><tr><th>Rol</th><td>{user.rol === "admin" ? "Administrador" : "Usuario"}</td></tr></tbody></table></div>
    <form className="card card-pad" style={{ maxWidth: 560 }} onSubmit={submit}><div className="section-head"><h3>Cambiar contraseña</h3></div>
      {msg && <div className={"banner " + (msg.kind === "ok" ? "" : "danger")} style={{ marginBottom: 12 }}>{msg.message}</div>}
      <div className="form-grid"><div className="full"><Field def={actualField} value={values.actual} onChange={(v) => setValues({ ...values, actual: v })} /></div><div className="full"><Field def={nuevaField} value={values.nueva} onChange={(v) => setValues({ ...values, nueva: v })} /></div></div>
      <div className="modal-footer"><button className="btn" disabled={busy}>{busy ? "Guardando…" : "Guardar contraseña"}</button></div>
    </form>
  </>;
}
