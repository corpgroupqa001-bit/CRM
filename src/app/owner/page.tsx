import Link from "next/link";
import { requireUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { Badge, Card, Empty, PageHeader, Stat, Table } from "@/components/ui";
import { money, todayIST } from "@/lib/format";
import { createCompany, logout } from "@/app/(auth)/actions";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { setCompanyStatus } from "./actions";

export const metadata = { title: "All companies" };

type Search = { q?: string; status?: string; sort?: string; new?: string };

// COM-07 consolidated dashboard + COM-11 companies list
export default async function OwnerPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const user = await requireUser();
  const supabase = await createClient();
  const today = todayIST();

  const [{ data: members }, { data: profile }] = await Promise.all([
    supabase.from("company_members").select("company_id, role").eq("user_id", user.id).eq("active", true),
    supabase.from("profiles").select("last_company_id").eq("id", user.id).maybeSingle(),
  ]);
  // the logo opens the dashboard of the company used last (else the first one), as after sign-in
  const home = (members ?? []).find((m) => m.company_id === profile?.last_company_id) ?? members?.[0];
  const ids = (members ?? []).filter((m) => m.role === "owner").map((m) => m.company_id);

  const [{ data: companies }, { data: emps }, { data: att }, { data: branches }, { data: runs }, { data: tasks }] = await Promise.all([
    supabase.from("companies").select("id, name, logo_url, plan, status").in("id", ids),
    supabase.from("employees").select("company_id").in("company_id", ids).in("status", ["active", "notice"]),
    supabase.from("daily_attendance").select("company_id, status").in("company_id", ids).eq("date", today),
    supabase.from("branches").select("company_id").in("company_id", ids),
    supabase.from("payroll_runs").select("company_id, month, total_gross").in("company_id", ids).eq("status", "locked").order("month", { ascending: false }),
    supabase.from("tasks").select("company_id").in("company_id", ids).neq("status", "done"),
  ]);

  const count = <T extends { company_id: string }>(rows: T[] | null, id: string, f: (r: T) => boolean = () => true) =>
    (rows ?? []).filter((r) => r.company_id === id && f(r)).length;
  const PRESENT = ["present", "late", "early_out", "half_day", "on_duty", "wfh"];

  let rows = (companies ?? []).map((c) => {
    const headcount = count(emps, c.id);
    const present = count(att, c.id, (a) => PRESENT.includes(a.status));
    const lastRun = (runs ?? []).find((r) => r.company_id === c.id);
    return { ...c, headcount, present, pct: headcount ? Math.round((present / headcount) * 100) : 0,
      branches: count(branches, c.id), payroll: Number(lastRun?.total_gross ?? 0), openTasks: count(tasks, c.id) };
  });
  if (sp.q) rows = rows.filter((r) => r.name.toLowerCase().includes(sp.q!.toLowerCase()));
  if (sp.status) rows = rows.filter((r) => r.status === sp.status);
  rows.sort((a, b) => (sp.sort === "headcount" ? b.headcount - a.headcount : a.name.localeCompare(b.name)));

  const totals = rows.reduce((t, r) => ({ h: t.h + r.headcount, p: t.p + r.present, pay: t.pay + r.payroll, tasks: t.tasks + r.openTasks }), { h: 0, p: 0, pay: 0, tasks: 0 });

  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center justify-between border-b border-slate-200 bg-surface px-6">
        <Link href={home ? `/c/${home.company_id}/dashboard` : "/"} aria-label="Go to dashboard" className="flex items-center gap-2 font-semibold text-brand-900">
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-xs text-white">cg</span>corpgroup.com
        </Link>
        <div className="flex items-center gap-2">
          <Link href="/account" className="btn-ghost">Account</Link>
          <form action={logout}><button className="btn-ghost">Sign out</button></form>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        <PageHeader title="All companies" subtitle="Consolidated view across every company you own or administer."
          actions={<>{/* file download from an API route, not page navigation */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
          <a href="/api/export/companies" className="btn-secondary">Export</a><Link href="/owner?new=1" className="btn-primary">+ New company</Link></>} />
        {sp.new && (
          <Card title="Create a company" description="You become its Owner. Each company's employees, attendance and payroll stay separate." className="mb-6">
            <ActionForm action={createCompany} className="flex flex-wrap items-end gap-3 [&>p]:basis-full">
              <Field label="Company name" className="min-w-0 flex-[1_1_280px]"><input className="input" name="company_name" required maxLength={120} placeholder="Acme Logistics Pvt Ltd" autoFocus /></Field>
              <SubmitButton pendingText="Creating…">Create company</SubmitButton>
              <Link href="/owner" className="btn-ghost">Cancel</Link>
            </ActionForm>
          </Card>
        )}
        <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <Stat label="Headcount" value={totals.h} />
          <Stat label="Present today" value={`${totals.p} (${totals.h ? Math.round((totals.p / totals.h) * 100) : 0}%)`} tone="green" />
          <Stat label="Last payroll cost" value={money(totals.pay)} hint="Gross, latest locked month per company" />
          <Stat label="Open tasks" value={totals.tasks} />
        </div>
        <Card pad={false} title={
          <form className="flex flex-wrap gap-2">
            <input name="q" defaultValue={sp.q} placeholder="Search companies" className="input w-56" />
            <select name="status" defaultValue={sp.status ?? ""} className="input w-36">
              <option value="">All statuses</option><option value="active">Active</option><option value="archived">Archived</option>
            </select>
            <select name="sort" defaultValue={sp.sort ?? "name"} className="input w-40">
              <option value="name">Sort by name</option><option value="headcount">Sort by headcount</option>
            </select>
            <button className="btn-secondary">Apply</button>
          </form>
        }>
          {rows.length ? (
            <Table head={["Company", "Branches", "Active employees", "Present today", "Plan", "Status", ""]}>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="td">
                    <Link href={`/c/${r.id}/dashboard`} className="flex items-center gap-2 font-medium text-slate-900 hover:underline">
                      {r.logo_url
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img src={r.logo_url} alt="" className="h-7 w-7 rounded object-cover" />
                        : <span className="inline-flex h-7 w-7 items-center justify-center rounded bg-brand-100 text-xs font-bold text-brand-700">{r.name.slice(0, 2).toUpperCase()}</span>}
                      {r.name}
                    </Link>
                  </td>
                  <td className="td">{r.branches}</td>
                  <td className="td">{r.headcount}</td>
                  <td className="td">{r.pct}%</td>
                  <td className="td capitalize">{r.plan}</td>
                  <td className="td"><Badge value={r.status} /></td>
                  <td className="td text-right">
                    <form action={async () => { "use server"; await setCompanyStatus(r.id, r.status === "active" ? "archived" : "active"); }}>
                      <button className="text-sm text-slate-500 hover:text-slate-900">{r.status === "active" ? "Archive" : "Restore"}</button>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          ) : <div className="p-4"><Empty title="No companies" action={<Link href="/onboarding" className="btn-primary">Create a company</Link>} /></div>}
        </Card>
      </main>
    </div>
  );
}
