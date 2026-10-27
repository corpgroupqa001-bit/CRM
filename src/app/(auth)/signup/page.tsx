import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { signupStart } from "../actions";

export const metadata = { title: "Create your company account" };

// AUTH-01 owner sign-up: name, email and company name; the account is created only after the 6-digit
// email code is verified, then the owner sets a password. Employees don't sign up here: HR adds them
// and the system emails an invitation (AUTH-04).
export default function SignupPage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Create your company account</h1>
      <p className="mt-1.5 text-sm text-slate-500">For business owners. You&apos;ll be the Owner of the company you create and can add more companies later.</p>
      <ActionForm action={signupStart} className="mt-6 space-y-4">
        <Field label="Your full name"><input className="input" name="name" required autoComplete="name" placeholder="Priya Sharma" /></Field>
        <Field label="Work email"><input className="input" name="email" type="email" required autoComplete="email" placeholder="you@company.com" /></Field>
        <Field label="Company name"><input className="input" name="company_name" required maxLength={120} autoComplete="organization" placeholder="Acme Industries Pvt Ltd" /></Field>
        <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="consent" required className="mt-0.5" />
          <span>I agree that personal data is processed to run attendance, payroll and work tools, as described in the <Link href="/privacy" className="font-medium text-brand-600 hover:underline">privacy notice</Link> (Digital Personal Data Protection Act, 2023).</span></label>
        <SubmitButton className="btn-primary w-full" pendingText="Sending code…">Continue</SubmitButton>
        <p className="text-xs text-slate-500">We&apos;ll email you a 6-digit code. After verifying it you choose a password.</p>
      </ActionForm>
      <div className="mt-8 space-y-1.5 border-t border-slate-100 pt-6 text-sm text-slate-500">
        <p>Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
        <p>Joining as an employee? Use the invitation your HR team emailed you, or <Link href="/activate" className="font-medium text-brand-600 hover:text-brand-700">activate your account</Link>.</p>
      </div>
    </>
  );
}
