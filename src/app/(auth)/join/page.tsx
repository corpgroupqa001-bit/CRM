import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { PasswordInput } from "@/components/password-input";
import { emailVerificationOn } from "@/lib/auth/config";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { joinStart } from "../actions";

export const metadata = { title: "Join your company" };

type Lookup = { company_id: string; company: string; projects: { id: string; name: string }[] } | null;

// AUTH-19 / AUTH-18 (revised BRD, 30 Oct; 0056): an employee opens their company's sign-up link (/join?code=…)
// or types the code, then gives name, email and mobile and ticks the projects they want to join. Nobody can
// see a company, or its projects, without its code. The request waits for the Owner or the Admin.
export default async function JoinPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = ((await searchParams).code ?? "").trim().toUpperCase();
  const found = code ? ((await createAdminClient().rpc("join_code_lookup", { p_code: code })).data as Lookup) : null;
  const codes = emailVerificationOn();

  if (!found) {
    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Join your company</h1>
        <p className="mt-1.5 text-sm text-slate-500">Enter the sign-up code your company shared with you, or open the sign-up link they sent.</p>
        {code && <p role="alert" className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">That code is not valid. Ask your company for the current link or code.</p>}
        <form className="mt-6 space-y-4">
          <Field label="Company code"><input className="input uppercase tracking-widest" name="code" required maxLength={12} defaultValue={code} autoFocus autoComplete="off" placeholder="e.g. DEMO7K2P" /></Field>
          <button className="btn-primary w-full">Continue</button>
        </form>
        <p className="mt-8 border-t border-slate-100 pt-6 text-sm text-slate-500">Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
      </>
    );
  }

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Join {found.company}</h1>
      <p className="mt-1.5 text-sm text-slate-500">Your request goes to the company&apos;s Owner and Admin. You can sign in once they approve it.</p>
      <ActionForm action={joinStart} className="mt-6 space-y-4">
        <input type="hidden" name="code" value={code} />
        <Field label="Your full name"><input className="input" name="name" required autoComplete="name" placeholder="Ravi Kumar" /></Field>
        <Field label="Work email"><input className="input" name="email" type="email" required autoComplete="email" /></Field>
        <Field label="Mobile number"><input className="input" name="phone" type="tel" required autoComplete="tel" inputMode="tel" pattern="\+?[0-9][0-9 \(\)\-]{6,19}" title="Digits only, e.g. 98480 22338" placeholder="98480 22338" /></Field>
        {found.projects.length > 0 && (
          <fieldset>
            <legend className="label">Projects you work on</legend>
            <p className="mb-2 text-xs text-slate-500">Each one is approved separately. You can ask for more later.</p>
            <div className="space-y-2">{found.projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" name="project" value={p.id} /> {p.name}</label>
            ))}</div>
          </fieldset>
        )}
        {!codes && <>
          <Field label="Password" hint={PASSWORD_RULE}><PasswordInput name="password" minLength={8} required autoComplete="new-password" /></Field>
          <Field label="Confirm password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
        </>}
        <label className="flex items-start gap-2 text-xs text-slate-600"><input type="checkbox" name="consent" required className="mt-0.5" />
          <span>I agree that personal data is processed to run attendance, payroll and work tools, as described in the <Link href="/privacy" className="font-medium text-brand-600 hover:underline">privacy notice</Link> (Digital Personal Data Protection Act, 2023).</span></label>
        <SubmitButton className="btn-primary w-full" pendingText={codes ? "Sending code…" : "Sending request…"}>{codes ? "Continue" : "Send my request"}</SubmitButton>
        {codes && <p className="text-xs text-slate-500">We&apos;ll email you a 6-digit code. After verifying it you choose a password.</p>}
      </ActionForm>
      <p className="mt-8 border-t border-slate-100 pt-6 text-sm text-slate-500">Already have an account? <Link href="/login" className="font-medium text-brand-600 hover:text-brand-700">Sign in</Link></p>
    </>
  );
}
