/** Sección «Ayuda»: los manuales de la aplicación, consultables y
 *  descargables en PDF. Los PDF viven en public/docs y los sirve el build. */

interface Manual {
  icono: string;
  titulo: string;
  publico: string;
  resumen: string;
  temas: string[];
  datos: string;
  pdf: string;
}

const MANUALES: Manual[] = [
  {
    icono: "🛠️",
    titulo: "Manual del administrador",
    publico: "Administradores",
    resumen: "Guía completa: acceso, panel de control, altas y ediciones de registros, estaciones con QR, usuarios, centros, informes y mantenimiento de la aplicación.",
    temas: [
      "Acceso, errores frecuentes y recuperación de contraseña",
      "Panel de control, alertas y resumen por correo",
      "Consumibles: químicos, material, estaciones y entradas/salidas",
      "Maquinaria, histórico de situaciones y equipación",
      "Centros, zonas, alta de usuarios y roles",
      "Documentación, informes, auditoría e importación CSV",
      "Tabla de permisos y solución de problemas",
    ],
    datos: "13 apartados · 21 capturas",
    pdf: "docs/manual-administrador.pdf",
  },
  {
    icono: "🧭",
    titulo: "Manual del usuario",
    publico: "Operarios y usuarios de consulta",
    resumen: "Guía breve para el día a día: entrar, consultar el inventario, consumir material en planta con el QR de la estación y cambiar tu contraseña.",
    temas: [
      "Acceso y solución de problemas básicos",
      "Panel de control y búsqueda global",
      "Consulta de químicos, maquinaria y equipación",
      "Consumo en planta con el QR (modo estación y deshacer)",
      "Documentación y centros",
      "Mi cuenta: cambiar la contraseña",
    ],
    datos: "8 apartados · 12 capturas",
    pdf: "docs/manual-usuario.pdf",
  },
];

export function AyudaPage() {
  return <>
    <div className="card card-pad">
      <div className="section-head">
        <h3>🛟 Manuales de la aplicación</h3>
        <span style={{ color: "var(--muted)", fontSize: 12.5 }}>
          PDF con capturas · ábrelos en el navegador o descárgalos
        </span>
      </div>
      <p style={{ color: "var(--muted)", margin: "0 0 4px" }}>
        Dos manuales en español: uno completo para administrar la aplicación y otro corto para
        el uso diario en planta. Si algo no funciona, empieza por la tabla
        <em> «Solución de problemas»</em> de cada manual.
      </p>
    </div>

    <div className="ayuda-grid">
      {MANUALES.map((m) => (
        <div key={m.pdf} className="card card-pad ayuda-card">
          <div className="ayuda-head">
            <span className="ayuda-icono" aria-hidden="true">{m.icono}</span>
            <div>
              <h3>{m.titulo}</h3>
              <span className="badge info">{m.publico}</span>{" "}
              <span className="badge muted">{m.datos}</span>
            </div>
          </div>
          <p className="ayuda-resumen">{m.resumen}</p>
          <ul className="ayuda-temas">
            {m.temas.map((t) => <li key={t}>{t}</li>)}
          </ul>
          <div className="ayuda-acciones">
            <a className="btn" href={m.pdf} target="_blank" rel="noreferrer">📘 Abrir el manual</a>
            <a className="btn secondary" href={m.pdf} download>⬇️ Descargar PDF</a>
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
      </ul>
    </div>
  </>;
}
