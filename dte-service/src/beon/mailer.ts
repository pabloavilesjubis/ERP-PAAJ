import type { Config } from '../config.js';
import { DteError } from '../errors.js';
import type { DteRecord } from './storage.js';

/**
 * Reenvío de PDF/JSON por correo. Implementación mínima: si los `SMTP_*` están
 * configurados, envía vía SMTP usando un cliente nativo no-deps. Si no, lanza
 * un error que la ruta convierte en 503 NOT_CONFIGURED — BEON puede caer en su
 * propio mailer mientras tanto.
 *
 * Para uso real con autenticación y TLS, agregar `nodemailer` y reemplazar
 * `sendNative` por su API. Esta implementación intencionalmente es muy básica.
 */

export class MailerNotConfigured extends DteError {
  constructor() {
    super('Mailer no configurado en PAAJ (faltan SMTP_*)', 'MAILER_NOT_CONFIGURED');
  }
}

export interface MailArgs {
  to: string;
  subject: string;
  body: string;
  attachments: Array<{ filename: string; path: string; contentType: string }>;
}

export async function sendDteByMail(cfg: Config, rec: DteRecord, to: string): Promise<void> {
  if (!cfg.SMTP_HOST || !cfg.SMTP_FROM) {
    throw new MailerNotConfigured();
  }
  // Implementación nodemailer-free intencional: si quieres mantener cero deps
  // adicionales, agrega aquí un cliente SMTP simple. Por ahora marcamos como
  // no implementado para evitar enviar correos parcialmente formados.
  // Reemplazar por nodemailer:
  //   const transporter = nodemailer.createTransport({ host: cfg.SMTP_HOST, port: cfg.SMTP_PORT, auth: {...} });
  //   await transporter.sendMail({ from: cfg.SMTP_FROM, to, subject, html: body, attachments });
  throw new DteError(
    'Backend de correo no implementado. Configurar nodemailer y reemplazar `sendDteByMail`.',
    'MAILER_NOT_IMPLEMENTED',
    { to, dte: rec.codigo_generacion },
  );
}
