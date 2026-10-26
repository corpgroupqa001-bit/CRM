// Check the SMTP settings in .env.local and send a real test email:
//   pnpm email:test you@example.com
import nodemailer from "nodemailer";
import { existsSync, readFileSync } from "node:fs";
import { explainSmtpError, smtpOptions } from "../src/lib/email/smtp";

if (existsSync(".env.local")) {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

async function main() {
  const to = process.argv[2];
  const opts = smtpOptions();
  if (!opts) {
    console.error("✕ SMTP_HOST is empty in .env.local — emails are only printed to the terminal.\n  Fill SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM (see README → Email).");
    process.exit(1);
  }
  console.log(`SMTP ${opts.host}:${opts.port} (${opts.secure ? "TLS" : "STARTTLS"}) as ${process.env.SMTP_USER || "(no login)"}`);
  const t = nodemailer.createTransport(opts);
  try {
    await t.verify();
    console.log("✓ Connected and logged in");
  } catch (err) {
    console.error("✕", explainSmtpError(err));
    process.exit(1);
  }
  if (!to) {
    console.log("Add an address to send a test email:  pnpm email:test you@example.com");
    process.exit(0);
  }
  try {
    const info = await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER, to,
      subject: "corpgroup.com test email", text: "If you can read this, verification emails will be delivered.",
    });
    console.log(`✓ Sent to ${to} (message id ${info.messageId}). Check the inbox and the spam folder.`);
  } catch (err) {
    console.error("✕", explainSmtpError(err));
    process.exit(1);
  }
}

main();
