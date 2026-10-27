import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { emailVerificationOn } from "@/lib/auth/config";
import { forgotStart } from "../actions";

export const metadata = { title: "Forgot password" };

export default function ForgotPage() {
  const codes = emailVerificationOn();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Forgot your password?</h1>
      {codes ? (
        <>
          <p className="mt-1.5 text-sm text-slate-500">We&apos;ll email a code so you can set a new one. All other sessions will be signed out.</p>
          <ActionForm action={forgotStart} className="mt-6 space-y-4">
            <Field label="Work email"><input className="input" name="email" type="email" required autoFocus /></Field>
            <SubmitButton className="btn-primary w-full" pendingText="Sending code…">Send code</SubmitButton>
          </ActionForm>
        </>
      ) : (
        <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
          Ask your company admin or HR to set a new password for you: they can do it from <b>Employees → your profile → Access</b>.
          Once you&apos;re signed in, you can change it any time under <b>Account &amp; security</b>.
        </div>
      )}
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm"><Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">← Back to sign in</Link></p>
    </>
  );
}
