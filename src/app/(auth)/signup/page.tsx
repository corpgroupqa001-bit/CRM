import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { CompanyPicker, JoinFields } from "@/components/join-fields";
import { emailVerificationOn } from "@/lib/auth/config";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { joinOptions } from "@/lib/join";
import { signupStart } from "../actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Create your account" };

// Candidate sign-up: company → designation and details → account + request. An administrator of
// that company checks the details and approves; until then the account can't sign in.
export default async function SignupPage({ searchParams }: { searchParams: Promise<{ company?: string }> }) {
  const { company } = await searchParams;
  const codes = emailVerificationOn();
  const options = await joinOptions(company);
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create your account</h1>
      <p className="mt-1.5 text-sm text-slate-500">Your company&apos;s administrator checks your details and approves you before you can sign in.</p>
      {!options.company ? <CompanyPicker options={options} path="/signup" /> : (
        <ActionForm action={signupStart} className="mt-6 space-y-4">
          {!codes && <JoinFields options={options} path="/signup" />}
          <Field label="Full name"><input className="input" name="name" required autoComplete="name" placeholder="Priya Sharma" /></Field>
          <Field label="Work email"><input className="input" name="email" type="email" required autoComplete="email" placeholder="you@company.com" /></Field>
          {!codes && <>
            <Field label="Password" hint={PASSWORD_RULE}><PasswordInput name="password" minLength={8} required autoComplete="new-password" /></Field>
            <Field label="Confirm password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
          </>}
          <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="consent" required className="mt-0.5" />
            <span>I agree that my personal data is processed to run attendance, payroll and work tools for my employer, as described in the <Link href="/privacy" className="font-medium text-brand-600 hover:underline">privacy notice</Link> (Digital Personal Data Protection Act, 2023).</span></label>
          <SubmitButton className="btn-primary w-full" pendingText={codes ? "Sending code…" : "Sending request…"}>{codes ? "Continue" : "Create account and request access"}</SubmitButton>
          {codes && <p className="text-xs text-slate-500">We&apos;ll email you a 6-digit code. After verifying, you choose your designation and send the request.</p>}
        </ActionForm>
      )}
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm text-slate-500">Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
    </>
  );
}
