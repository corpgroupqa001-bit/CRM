import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { emailVerificationOn } from "@/lib/auth/config";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { signupStart } from "../actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Create your company account" };

// AUTH-01 owner sign-up: name, email and company name. With email codes on, the address is verified
// with a 6-digit code first and the password is set afterwards. Employees sign up on /join with their
// company's code (AUTH-19) or activate an HR invitation (AUTH-04).
export default function SignupPage() {
  const codes = emailVerificationOn();
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create your company account</h1>
      <p className="mt-1.5 text-sm text-slate-500">For business owners. You&apos;ll be the Owner of the company you create and can add more companies later.</p>
      <ActionForm action={signupStart} className="mt-6 space-y-4">
        <Field label="Your full name"><input className="input" name="name" required autoComplete="name" placeholder="Priya Sharma" /></Field>
        <Field label="Work email"><input className="input" name="email" type="email" required autoComplete="email" placeholder="you@company.com" /></Field>
        <Field label="Company name"><input className="input" name="company_name" required maxLength={120} autoComplete="organization" placeholder="Acme Industries Pvt Ltd" /></Field>
        {!codes && <>
          <Field label="Password" hint={PASSWORD_RULE}><PasswordInput name="password" minLength={8} required autoComplete="new-password" /></Field>
          <Field label="Confirm password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
        </>}
        <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="consent" required className="mt-0.5" />
          <span>I agree that personal data is processed to run attendance, payroll and work tools, as described in the <Link href="/privacy" className="font-medium text-brand-600 hover:underline">privacy notice</Link> (Digital Personal Data Protection Act, 2023).</span></label>
        <SubmitButton className="btn-primary w-full" pendingText={codes ? "Sending code…" : "Creating…"}>{codes ? "Continue" : "Create account and company"}</SubmitButton>
        {codes && <p className="text-xs text-slate-500">We&apos;ll email you a 6-digit code. After verifying it you choose a password.</p>}
      </ActionForm>
      <div className="mt-8 space-y-1.5 border-t border-slate-100 pt-6 text-sm text-slate-500">
        <p>Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
        <p>Joining as an employee? <Link href="/join" className="font-medium text-brand-600 hover:text-brand-700">Sign up with your company&apos;s link or code</Link>, or <Link href="/activate" className="font-medium text-brand-600 hover:text-brand-700">activate the invitation</Link> HR emailed you.</p>
      </div>
    </>
  );
}
