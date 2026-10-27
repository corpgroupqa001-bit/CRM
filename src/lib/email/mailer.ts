import "server-only";
import nodemailer, { type Transporter } from "nodemailer";
import { APP_NAME } from "@/lib/format";
import { explainSmtpError, smtpOptions } from "./smtp";

// AUTH-08: Nodemailer over SMTP in Node.js server code. With no SMTP_HOST configured (local
// development) the message is printed to the server console instead.

type Mail = { to: string; subject: string; text: string; html: string; attachments?: { filename: string; content: Buffer }[] };

let transporter: Transporter | null = null;
function transport() {
  const opts = smtpOptions();
  if (!opts) return null;
  transporter ??= nodemailer.createTransport(opts);
  return transporter;
}

export async function sendMail(mail: Mail): Promise<{ ok: boolean; error?: string }> {
  const t = transport();
  if (!t) {
    // production must really send: an emailed code printed to a log would never reach the user and would sit in the logs
    if (process.env.NODE_ENV === "production") {
      console.error(`[mail] SMTP is not configured; not sent to ${mail.to} (${mail.subject})`);
      return { ok: false, error: "Email isn't set up on this server yet (SMTP). Ask the administrator." };
    }
    // local / staging development: show the message (with its code) in the server log instead
    console.log(`\n──── ✉  DEV EMAIL (SMTP not configured) ────\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n────────────────────────────────────────────\n`);
    return { ok: true };
  }
  try {
    await t.sendMail({ from: process.env.MAIL_FROM ?? `${APP_NAME} <no-reply@corpgroup.com>`, ...mail });
    return { ok: true };
  } catch (err) {
    const reason = explainSmtpError(err);
    console.error(`[mail] send failed to ${mail.to} (${mail.subject}): ${reason}\n`, err);
    return { ok: false, error: reason };
  }
}

const shell = (title: string, body: string) => `<!doctype html><html><body style="margin:0;background:#f4f5f7;font-family:Segoe UI,Arial,sans-serif;color:#1f2937">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="480" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden">
<tr><td style="background:#1e3a8a;color:#fff;padding:18px 24px;font-size:18px;font-weight:600">${APP_NAME}</td></tr>
<tr><td style="padding:24px"><h2 style="margin:0 0 12px;font-size:18px">${title}</h2>${body}</td></tr>
<tr><td style="padding:16px 24px;font-size:12px;color:#6b7280;border-top:1px solid #e5e7eb">You received this email because of activity on your ${APP_NAME} account. If this wasn't you, ignore it.</td></tr>
</table></td></tr></table></body></html>`;

const PURPOSE_TEXT: Record<string, string> = {
  signup: "Use this code to verify your email and create your account.",
  login: "Use this code to sign in.",
  reset: "Use this code to reset your password.",
  invite: "Use this code to activate your account.",
  change_email: "Use this code to confirm your new email address.",
};

export function otpEmail(to: string, code: string, purpose: string, link?: string): Mail {
  const lead = PURPOSE_TEXT[purpose] ?? "Your verification code:";
  return {
    to,
    subject: `${code} is your ${APP_NAME} verification code`,
    text: `${lead}\n\n${code}\n\n${link ? `Or open this link to verify in one click:\n${link}\n\n` : ""}The code and link expire in 10 minutes and work once. If you didn't ask for this, ignore this email.`,
    html: shell("Verify your email", `<p>${lead}</p>
      <p style="font-size:32px;letter-spacing:8px;font-weight:700;margin:20px 0;color:#1e3a8a">${code}</p>
      ${link ? `<p style="margin:24px 0"><a href="${link}" style="background:#1e3a8a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">Verify email</a></p>
      <p style="color:#6b7280;font-size:12px">Button not working? Paste this into your browser:<br><span style="word-break:break-all">${link}</span></p>` : ""}
      <p style="color:#6b7280">The code and link expire in 10 minutes and work once. If you didn't ask for this, ignore this email.</p>`),
  };
}

export function inviteEmail(to: string, name: string, company: string, link: string): Mail {
  return {
    to,
    subject: `${company} invited you to ${APP_NAME}`,
    text: `Hi ${name},\n\n${company} has added you on ${APP_NAME}. Activate your account here:\n${link}\n\nYou will verify your email with a one-time code and set a password.`,
    html: shell(`Welcome to ${company}`, `<p>Hi ${name},</p><p>${company} has added you on ${APP_NAME}, where you can see attendance, apply for leave, view payslips, work on tasks and chat with your team.</p>
      <p style="margin:24px 0"><a href="${link}" style="background:#1e3a8a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none">Activate my account</a></p>
      <p style="color:#6b7280">You will verify your email with a one-time code and set a password.</p>`),
  };
}

export function payslipEmail(to: string, name: string, month: string, pdf: Buffer, protectedWith?: string | null): Mail {
  const pw = protectedWith ? ` The PDF is password-protected: the password is your ${protectedWith}.` : "";
  return {
    to,
    subject: `Payslip for ${month}`,
    text: `Hi ${name},\n\nYour payslip for ${month} is attached.${pw} You can also view it in ${APP_NAME}.`,
    html: shell(`Payslip for ${month}`, `<p>Hi ${name},</p><p>Your payslip for ${month} is attached.${pw} You can also view it any time in ${APP_NAME}.</p>`),
    attachments: [{ filename: `payslip-${month.replace(/\s/g, "-")}.pdf`, content: pdf }],
  };
}
