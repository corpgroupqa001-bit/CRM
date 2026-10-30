import Link from "next/link";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { emailVerificationOn } from "@/lib/auth/config";
import { loginOtpStart, loginPassword, switchAccount } from "../actions";
import { GoogleButton } from "@/components/google-button";
import { joinOptions } from "@/lib/join";
import { getUser } from "@/lib/context";
import { PasswordInput } from "@/components/password-input";
import { headers } from "next/headers";
import { otherOrigin } from "@/lib/origins";

export type Portal = "company" | "hr";

/**
 * The company sign-in (Owners, HR Managers, employees), used at "/", "/login" and "/hr".
 * portal "hr" only lets in someone who is HR Manager in the selected company; that is checked on the
 * server (loginPassword → my_access), not here. The admin portal (/admin) has its own sign-in and session.
 */
export async function CompanySignIn({ mode, next, pending, portal = "company", base = "/login" }:
  { mode?: string; next?: string; pending?: string; portal?: Portal; base?: string }) {
  const hr = portal === "hr";
  const codes = emailVerificationOn() && !hr;
  const otp = codes && mode === "otp";
  // the registered companies, read from the database (same list as sign-up)
  const { companies } = await joinOptions();
  // the company app keeps one session per browser: signing in here replaces whoever is signed in to it
  const current = await getUser();
  // a second address of the app keeps its own sign-in: two accounts at once in one browser
  const other = current ? otherOrigin((await headers()).get("host")) : null;
  const q = (m?: string) => `${base}?${new URLSearchParams({ ...(m ? { mode: m } : {}), ...(next ? { next } : {}) })}`;
  return (
    <>
      {hr && <span className="inline-flex rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700">HR portal</span>}
      <h1 className={`${hr ? "mt-3 " : ""}text-2xl font-semibold tracking-tight text-slate-900`}>{hr ? "HR Manager Sign In" : "Employee Sign In"}</h1>
      <p className="mt-1.5 text-sm text-slate-500">{hr ? "For HR Managers. Choose the company where you are HR Manager." : "Welcome back. Sign in to your company workspace."}</p>
      {current?.email && (
        // the company app keeps one signed-in account per browser: offer to continue, or to switch cleanly
        <div className="mt-6 rounded-xl border border-slate-200 p-4">
          <p className="text-sm text-slate-600">Signed in as <b className="break-all font-medium text-slate-900">{current.email}</b></p>
          <div className="mt-3 flex flex-col gap-2">
            {/* a full page load: "/" depends on who is signed in, so it must not come from the router cache */}
            <form action="/" method="get"><button className="btn-primary w-full justify-center">Continue</button></form>
            <form action={switchAccount.bind(null, (base === "/" || base === "/hr" ? base : "/login") as "/" | "/login" | "/hr")}>
              <button className="btn-secondary w-full justify-center">Sign in as another {hr ? "HR Manager" : "employee"}</button>
            </form>
          </div>
          {other && (
            <a href={`${other}${hr ? "/hr" : "/login"}`} target="_blank" rel="noopener" className="mt-2 flex w-full items-center justify-center rounded-lg border border-dashed border-brand-300 px-3 py-2 text-sm font-medium text-brand-700 hover:bg-brand-50">
              Sign in to another account in a new tab
            </a>
          )}
          <p className="mt-3 text-xs text-slate-500">
            {other
              ? <>&ldquo;Sign in as another&rdquo; replaces this account here. &ldquo;In a new tab&rdquo; opens the app at its second address ({new URL(other).host}), which keeps its own sign-in, so both accounts stay signed in.</>
              : <>Switching signs this account out of the company app in this browser. To keep both signed in, use a private window or another browser profile.</>}
          </p>
        </div>
      )}
      {pending && <p role="status" className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
        Request sent. Your company&apos;s Owner will check your details; you can sign in once you&apos;re approved.</p>}
      {!current && codes && (
        <div className="mt-6 grid grid-cols-2 rounded-lg bg-slate-100 p-1 text-sm font-medium">
          <Link href={q()} className={`rounded-md py-1.5 text-center transition ${!otp ? "bg-surface text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Password</Link>
          <Link href={q("otp")} className={`rounded-md py-1.5 text-center transition ${otp ? "bg-surface text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"}`}>Email code</Link>
        </div>
      )}
      {current ? null : otp ? (
        <ActionForm action={loginOtpStart} className="mt-6 space-y-4">
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Work email"><input className="input" name="email" type="email" required autoFocus autoComplete="email" placeholder="you@company.com" /></Field>
          <SubmitButton className="btn-primary w-full" pendingText="Sending code…">Email me a code</SubmitButton>
        </ActionForm>
      ) : (
        <ActionForm action={loginPassword} className="mt-6 space-y-4">
          {!hr && <GoogleButton next={next} />}
          <input type="hidden" name="next" value={next ?? ""} />
          <input type="hidden" name="portal" value={portal} />
          <Field label="Company">
            <select className="input" name="company" required defaultValue="" autoFocus>
              <option value="" disabled>Select your company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Work email"><input className="input" name="email" type="email" required autoComplete="email" placeholder="you@company.com" /></Field>
          <div>
            <div className="flex items-center justify-between"><span className="label">Password</span>
              <Link href="/forgot" className="mb-1.5 text-xs font-medium text-brand-600 hover:text-brand-700">Forgot password?</Link></div>
            <PasswordInput name="password" required autoComplete="current-password" />
          </div>
          <SubmitButton className="btn-primary w-full" pendingText="Signing in…">{hr ? "Sign in to HR" : "Sign in"}</SubmitButton>
        </ActionForm>
      )}
      <div className="mt-8 space-y-2 border-t border-slate-100 pt-6 text-sm text-slate-500">
        {hr ? (
          <p>Not an HR Manager? <Link href="/" className="font-medium text-brand-600 hover:text-brand-700">Employee sign-in</Link></p>
        ) : (
          <>
            <p>New here? <Link href="/signup" className="font-medium text-brand-600 hover:text-brand-700">Create an account</Link></p>
            <p>Invited by your employer? <Link href="/activate" className="font-medium text-brand-600 hover:text-brand-700">Activate your account</Link></p>
          </>
        )}
      </div>
    </>
  );
}
