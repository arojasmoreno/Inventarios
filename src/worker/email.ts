import type { Env } from "./d1";

// Envío de correo transaccional con la API v3 de Twilio SendGrid.
// Se llama con fetch nativo de Workers en lugar del SDK @sendgrid/mail,
// que depende de axios y módulos CommonJS incompatibles con workerd.
const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const FROM_NAME = "Inventarios";
const RESET_SUBJECT = "Recupera tu contraseña · Inventarios";
const LOGIN_SUBJECT = "Tu código de acceso · Inventarios";

interface MailPayload {
  to: string;
  subject: string;
  html: string;
  text: string;
}

async function sendViaSendGrid(env: Env, payload: MailPayload): Promise<void> {
  const apiKey = (env.SENDGRID_API_KEY ?? "").trim();
  const fromEmail = (env.SENDGRID_FROM_EMAIL ?? "").trim() || "no-reply@inventarios.local";
  const res = await fetch(SENDGRID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: payload.to }] }],
      from: { email: fromEmail, name: FROM_NAME },
      subject: payload.subject,
      content: [
        { type: "text/plain", value: payload.text },
        { type: "text/html", value: payload.html },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`SendGrid respondió ${res.status}: ${detail.slice(0, 300)}`);
  }
}

function resetTemplate(username: string, nombre: string, code: string): { html: string; text: string } {
  const html = `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <style>
          body { margin: 0; padding: 0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background: #0f172a; color: #0f172a; }
          .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
          .header { background: #1e3a8a; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0 0 6px; font-size: 22px; }
          .content { padding: 28px 24px 24px; }
          .token { display: inline-block; background: #0f172a; color: #ffffff; font-family: "Courier New", monospace; font-size: 22px; letter-spacing: 6px; padding: 12px 18px; border-radius: 8px; margin: 16px 0; }
          .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="header">
            <h1>Inventarios</h1>
            <p>${nombre}, has solicitado recuperar tu contraseña.</p>
          </div>
          <div class="content">
            <p>Hola <strong>${username}</strong>: usa este código para configurar tu nueva contraseña.</p>
            <p class="token">${code}</p>
            <p style="margin: 8px 0 0; color: #64748b; font-size: 13px;">Caduca en 10 minutos. Si no solicitaste este cambio, puedes ignorar este correo.</p>
          </div>
          <div class="footer">
            <p>Este mensaje se envió automáticamente. Por favor no responderlo.</p>
          </div>
        </div>
      </body>
    </html>
  `;
  const text = [
    `${nombre}:`,
    "",
    `Has solicitado recuperar la contraseña de ${username} en Inventarios.`,
    "",
    `Código de verificación: ${code}`,
    "",
    "Caduca en 10 minutos. Si no solicitaste este cambio, ignora este correo.",
  ].join("\n");
  return { html, text };
}

function loginCodeTemplate(nombre: string, code: string): { html: string; text: string } {
  const html = `
    <!DOCTYPE html>
    <html lang="es">
      <head>
        <meta charset="utf-8" />
        <style>
          body { margin: 0; padding: 0; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; background: #0f172a; color: #0f172a; }
          .wrapper { max-width: 600px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,.35); }
          .header { background: #1e3a8a; color: #ffffff; padding: 24px; text-align: center; }
          .header h1 { margin: 0 0 6px; font-size: 22px; }
          .content { padding: 28px 24px 24px; }
          .token { display: inline-block; background: #0f172a; color: #ffffff; font-family: "Courier New", monospace; font-size: 22px; letter-spacing: 6px; padding: 12px 18px; border-radius: 8px; margin: 16px 0; }
          .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
        </style>
      </head>
      <body>
        <div class="wrapper">
          <div class="header">
            <h1>Inventarios</h1>
            <p>${nombre}, este es tu código de acceso.</p>
          </div>
          <div class="content">
            <p>Usa este código para iniciar sesión en la aplicación:</p>
            <p class="token">${code}</p>
            <p style="margin: 8px 0 0; color: #64748b; font-size: 13px;">Caduca en 10 minutos. Si no has solicitado este acceso, puedes ignorar este correo.</p>
          </div>
          <div class="footer">
            <p>Este mensaje se envió automáticamente. Por favor no responderlo.</p>
          </div>
        </div>
      </body>
    </html>
  `;
  const text = [
    `${nombre}:`,
    "",
    "Has solicitado iniciar sesión en Inventarios con código por correo.",
    "",
    `Código de acceso: ${code}`,
    "",
    "Caduca en 10 minutos. Si no has solicitado este acceso, ignora este correo.",
  ].join("\n");
  return { html, text };
}

export async function sendLoginCode(env: Env, to: string, nombre: string, code: string): Promise<void> {
  if (!(env.SENDGRID_API_KEY ?? "").trim()) {
    // Sin clave (desarrollo local): no hay envío real, se registra el código
    // para poder completar el acceso sin servidor SMTP.
    console.warn(`[email-dev] Sin SENDGRID_API_KEY. Código de acceso para ${to}: ${code}`);
    return;
  }
  const { html, text } = loginCodeTemplate(nombre, code);
  await sendViaSendGrid(env, { to, subject: LOGIN_SUBJECT, html, text });
}

export async function sendPasswordResetCode(env: Env, to: string, username: string, nombre: string, code: string): Promise<void> {
  if (!(env.SENDGRID_API_KEY ?? "").trim()) {
    // Sin clave (desarrollo local): no hay envío real, se registra el código
    // para poder completar el flujo de recuperación sin servidor SMTP.
    console.warn(`[email-dev] Sin SENDGRID_API_KEY. Código de recuperación para ${to}: ${code}`);
    return;
  }
  const { html, text } = resetTemplate(username, nombre, code);
  await sendViaSendGrid(env, { to, subject: RESET_SUBJECT, html, text });
}
