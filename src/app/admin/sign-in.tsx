import Link from "next/link";
import AuthLayout from "@/app/(auth)/layout";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { PasswordInput } from "@/components/password-input";
import { adminSignIn } from "./actions";

/** Admin portal sign-in: platform Super Admin only, with its own session (separate from the company app). */
export function AdminSignIn({ expired = false }: { expired?: boolean }) {
  return (
    <AuthLayout>
      <span className="inline-flex rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Admin portal</span>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">Admin Sign In</h1>
      <p className="mt-1.5 text-sm text-slate-500">For the platform operator. This sign-in is separate from the company app, so an employee can stay signed in there in the same browser.</p>
      {expired && <p role="status" className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        You were signed out of the admin portal after 15 minutes without activity. Sign in again to continue.</p>}
      <ActionForm action={adminSignIn} className="mt-6 space-y-4">
        <Field label="Work email"><input className="input" name="email" type="email" required autoFocus autoComplete="username" placeholder="you@company.com" /></Field>
        <div>
          <div className="flex items-center justify-between"><span className="label">Password</span>
            <Link href="/forgot" className="mb-1.5 text-xs font-medium text-brand-600 hover:text-brand-700">Forgot password?</Link></div>
          <PasswordInput name="password" required autoComplete="current-password" />
        </div>
        <SubmitButton className="btn-primary w-full" pendingText="Signing in…">Sign in to admin</SubmitButton>
      </ActionForm>
      <div className="mt-8 space-y-2 border-t border-slate-100 pt-6 text-sm text-slate-500">
        <p>Owner, HR or employee? <Link href="/" className="font-medium text-brand-600 hover:text-brand-700">Sign in to your company</Link></p>
        <p>HR Manager? <Link href="/hr" className="font-medium text-brand-600 hover:text-brand-700">HR sign-in</Link></p>
      </div>
    </AuthLayout>
  );
}
