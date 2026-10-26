// SMTP settings and plain-language failure reasons. No "server-only" import so the
// `pnpm email:test` script can use it outside Next.js.
import type SMTPTransport from "nodemailer/lib/smtp-transport";

export function smtpOptions(env: NodeJS.ProcessEnv = process.env): SMTPTransport.Options | null {
  if (!env.SMTP_HOST) return null;
  const port = Number(env.SMTP_PORT || 587);
  return {
    host: env.SMTP_HOST,
    port,
    // 465 = implicit TLS; 587 / 25 = STARTTLS. Follow SMTP_SECURE when set, otherwise the port.
    secure: env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  };
}

/** Turn a Nodemailer error into something an admin can act on. */
export function explainSmtpError(err: unknown, env: NodeJS.ProcessEnv = process.env): string {
  const e = err as { code?: string; responseCode?: number; message?: string; command?: string };
  const msg = e?.message ?? String(err);
  const host = env.SMTP_HOST ?? "";
  if (e?.code === "EAUTH" || e?.responseCode === 535 || e?.responseCode === 534) {
    return /gmail/i.test(host)
      ? "Gmail rejected the login. Use a 16-character App Password (Google account → Security → 2-Step Verification → App passwords), not your normal password."
      : "The SMTP server rejected SMTP_USER / SMTP_PASS. Check the username and the SMTP password or key from your provider.";
  }
  if (/wrong version number|ssl3_get_record|EPROTO/i.test(msg)) {
    return `TLS mismatch: port ${env.SMTP_PORT} needs SMTP_SECURE=${Number(env.SMTP_PORT) === 465 ? "true" : "false"}.`;
  }
  if (e?.code === "ETIMEDOUT" || e?.code === "ECONNECTION" || e?.code === "ECONNREFUSED" || /timeout/i.test(msg)) {
    return `Could not reach ${host}:${env.SMTP_PORT}. Check SMTP_HOST / SMTP_PORT; some networks block outgoing SMTP — try port 587 or 2525.`;
  }
  if (e?.code === "EDNS" || /ENOTFOUND|getaddrinfo/i.test(msg)) return `SMTP_HOST "${host}" does not exist. Check the spelling.`;
  if (e?.code === "EENVELOPE" || e?.responseCode === 550 || e?.responseCode === 553 || e?.responseCode === 554) {
    return `The server refused the sender or recipient (${msg}). Make sure MAIL_FROM uses an address or domain verified with your provider.`;
  }
  return msg;
}
