import Link from "next/link";
import { requireUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDateTime, label } from "@/lib/format";
import { PASSWORD_RULE } from "@/lib/auth/session";
import { TwoFactor } from "@/components/two-factor";
import { changeEmailStart, changePassword, logoutAll, requestDataAction } from "@/app/(auth)/actions";
import { PasswordInput } from "@/components/password-input";

export const metadata = { title: "Account & security" };

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ email_changed?: string }> }) {
  const { email_changed } = await searchParams;
  const user = await requireUser();
  const supabase = await createClient();
  const [{ data: history }, { data: memberships }, { data: requests }] = await Promise.all([
    supabase.from("login_history").select("*").eq("user_id", user.id).order("at", { ascending: false }).limit(20),
    supabase.from("company_members").select("company_id, companies(name)").eq("user_id", user.id).eq("active", true),
    supabase.from("data_requests").select("*").eq("user_id", user.id).order("created_at", { ascending: false }),
  ]);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-800">← Back to workspace</Link>
      <div className="mt-4"><PageHeader title="Account & security" subtitle={user.email} /></div>
      {email_changed && <p className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Your email address has been changed.</p>}
      <div className="space-y-6">
        <Card title="Password" description={PASSWORD_RULE}>
          <ActionForm action={changePassword} className="grid gap-4 sm:grid-cols-3" resetOnSuccess>
            <Field label="Current password"><PasswordInput name="current" required autoComplete="current-password" /></Field>
            <Field label="New password"><PasswordInput name="password" minLength={8} required autoComplete="new-password" /></Field>
            <Field label="Confirm new password"><PasswordInput name="confirm" minLength={8} required autoComplete="new-password" /></Field>
            <div className="sm:col-span-3"><SubmitButton>Change password</SubmitButton></div>
          </ActionForm>
        </Card>
        <Card title="Two-factor authentication" description="Ask for a code from an authenticator app at every sign-in. Strongly recommended for owners, admins and HR.">
          <TwoFactor />
        </Card>
        <Card title="Email address">
          <ActionForm action={changeEmailStart} className="flex flex-wrap items-end gap-3">
            <Field label="New email" className="min-w-64 flex-1"><input className="input" name="email" type="email" required /></Field>
            <SubmitButton className="btn-secondary">Change email</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Sessions" description="Signs you out everywhere, including this browser.">
          <form action={logoutAll}><button className="btn-danger">Log out of all devices</button></form>
        </Card>
        <Card title="Your personal data" description="Under India's Digital Personal Data Protection Act, 2023 you can get a copy of your data or ask for it to be erased.">
          <div className="space-y-4">
            <a href="/api/my-data" className="btn-secondary">Download my data (JSON)</a>
            {!!memberships?.length && (
              <ActionForm action={requestDataAction} className="grid gap-3 sm:grid-cols-3" resetOnSuccess>
                <input type="hidden" name="kind" value="delete" />
                <Field label="Company"><select className="input" name="company_id">{memberships.map((m) => <option key={m.company_id} value={m.company_id}>{(m.companies as unknown as { name: string }).name}</option>)}</select></Field>
                <Field label="Note (optional)" className="sm:col-span-2"><input className="input" name="note" placeholder="What should be deleted?" /></Field>
                <div className="sm:col-span-3"><SubmitButton className="btn-secondary">Request deletion</SubmitButton>
                  <p className="mt-2 text-xs text-slate-500">Attendance and payroll records must legally be kept for 8 years; everything else can be removed.</p></div>
              </ActionForm>
            )}
            {!!requests?.length && <ul className="space-y-1 text-xs text-slate-600">{requests.map((r) => <li key={r.id}>{fmtDateTime(r.created_at)} · {r.kind} request · <b className="capitalize">{r.status}</b></li>)}</ul>}
          </div>
        </Card>
        <Card title="Login history" pad={false}>
          <Table head={["When", "Method", "IP address", "Device"]}>
            {(history ?? []).map((h) => (
              <tr key={h.id}><td className="td whitespace-nowrap">{fmtDateTime(h.at)}</td><td className="td">{label(h.method)}</td><td className="td">{h.ip ?? "—"}</td>
                <td className="td max-w-xs truncate text-xs text-slate-500">{h.user_agent}</td></tr>
            ))}
          </Table>
        </Card>
      </div>
    </main>
  );
}
