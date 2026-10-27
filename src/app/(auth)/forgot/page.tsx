import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { forgotStart } from "../actions";

export const metadata = { title: "Forgot password" };

export default function ForgotPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Forgot your password?</h1>
      <p className="mt-1.5 text-sm text-slate-500">We&apos;ll email a code so you can set a new one. All other sessions will be signed out.</p>
      <ActionForm action={forgotStart} className="mt-6 space-y-4">
        <Field label="Work email"><input className="input" name="email" type="email" required autoFocus /></Field>
        <SubmitButton className="btn-primary w-full" pendingText="Sending code…">Send code</SubmitButton>
      </ActionForm>
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm"><Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">← Back to sign in</Link></p>
    </>
  );
}
