import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { resendCode, verifyCode } from "../actions";

export const metadata = { title: "Verify your email" };

const TITLES: Record<string, string> = {
  signup: "Verify your email", login: "Enter your sign-in code", reset: "Reset your password",
  invite: "Activate your account", change_email: "Confirm your new email", join: "Verify your email",
};

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ email?: string; purpose?: string; next?: string }> }) {
  const { email = "", purpose = "login", next = "" } = await searchParams;
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{TITLES[purpose] ?? "Verify"}</h1>
      <p className="mt-1 text-sm text-slate-500">
        If <span className="font-medium text-slate-700">{email}</span> has an account, an email with a 6-digit code and a
        one-click <b>Verify email</b> button is on its way. Both are valid for 10 minutes.
      </p>
      {!process.env.SMTP_HOST && process.env.NODE_ENV !== "production" && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          Development mode: no mail server is configured (SMTP_HOST is empty), so the email — code and link — is printed in the terminal running <code>pnpm dev</code>.
        </p>
      )}
      <ActionForm action={verifyCode} className="mt-5 space-y-4">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="purpose" value={purpose} />
        <input type="hidden" name="next" value={next} />
        <input className="input text-center text-2xl tracking-[0.5em]" name="code" inputMode="numeric" autoComplete="one-time-code"
          pattern="[0-9]{6}" maxLength={6} placeholder="••••••" required autoFocus />
        <SubmitButton className="btn-primary w-full" pendingText="Verifying…">Verify</SubmitButton>
      </ActionForm>
      <ActionForm action={resendCode} className="mt-3 space-y-2">
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="purpose" value={purpose} />
        <SubmitButton className="btn-ghost w-full" pendingText="Sending…">Resend code</SubmitButton>
      </ActionForm>
      <p className="mt-4 text-center text-sm"><Link href="/login" className="text-slate-500 hover:underline">Use a different email</Link></p>
    </>
  );
}
