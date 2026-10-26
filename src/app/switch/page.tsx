import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LockKeyhole } from "lucide-react";
import { requireUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { COMPANY_LOCK_COOKIE } from "@/lib/auth/company-lock";
import { unlockCompany } from "./actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Confirm it's you" };

// Shown when opening a company other than the one this sign-in unlocked (see middleware).
export default async function SwitchCompany({ searchParams }: { searchParams: Promise<{ to?: string; next?: string }> }) {
  const user = await requireUser();
  const { to, next } = await searchParams;
  if (!to) redirect("/");
  const supabase = await createClient();
  const { data: company } = await supabase.from("companies").select("name").eq("id", to).maybeSingle();
  // "back" returns to the company this session already has open (navigation only; the middleware checks the signature)
  const current = (await cookies()).get(COMPANY_LOCK_COOKIE)?.value.split(".")[1];
  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-white px-4 py-10">
      <div className="card w-full max-w-sm p-8">
        <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600"><LockKeyhole className="h-6 w-6" /></span>
        <h1 className="text-center text-xl font-semibold text-slate-900">Open {company?.name ?? "this company"}</h1>
        <p className="mt-2 text-center text-sm text-slate-600">For security, enter your password again to switch company.</p>
        <ActionForm action={unlockCompany} className="mt-6 space-y-4">
          <input type="hidden" name="to" value={to} />
          <input type="hidden" name="next" value={next ?? ""} />
          <Field label="Email"><input className="input" value={user.email ?? ""} disabled /></Field>
          <Field label="Password"><PasswordInput name="password" required autoFocus autoComplete="current-password" /></Field>
          <SubmitButton className="btn-primary w-full" pendingText="Checking…">Continue</SubmitButton>
        </ActionForm>
        <div className="mt-4 flex justify-between text-sm">
          {current && current !== to ? <Link href={`/c/${current}/dashboard`} className="text-slate-500 hover:text-slate-700">← Back</Link> : <span />}
          <Link href="/forgot" className="font-medium text-brand-600 hover:text-brand-700">Forgot password?</Link>
        </div>
      </div>
    </div>
  );
}
