import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { emailVerificationOn } from "@/lib/auth/config";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { activateStart } from "../actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Activate your account" };

export default async function ActivatePage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email = "" } = await searchParams;
  const codes = emailVerificationOn();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Activate your account</h1>
      <p className="mt-1.5 text-sm text-slate-500">
        {codes ? "Your employer added you. Verify your email with a one-time code, then set a password."
          : "Your employer added you. Enter the email HR used and choose a password."}
      </p>
      <ActionForm action={activateStart} className="mt-6 space-y-4">
        <Field label="Work email"><input className="input" name="email" type="email" defaultValue={email} required autoFocus /></Field>
        {!codes && <>
          <Field label="Choose a password" hint={PASSWORD_RULE}><PasswordInput name="password" minLength={8} required autoComplete="new-password" /></Field>
          <Field label="Confirm password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
        </>}
        <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="consent" required className="mt-0.5" />
          <span>I agree that my personal data is processed to run attendance, payroll and work tools for my employer, as described in the <Link href="/privacy" className="font-medium text-brand-600 hover:underline">privacy notice</Link> (Digital Personal Data Protection Act, 2023).</span></label>
        <SubmitButton className="btn-primary w-full" pendingText="Working…">{codes ? "Send code" : "Activate account"}</SubmitButton>
      </ActionForm>
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm text-slate-500">Already activated? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
    </>
  );
}
