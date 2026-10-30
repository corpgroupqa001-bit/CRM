import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUser, needsSecondFactor } from "@/lib/auth/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { attempt, must, numOrNull, str, type ActionState } from "@/lib/actions";
import { SessionGuard } from "@/components/session-guard";
import { AdminSignIn } from "./sign-in";
import { adminSignOut } from "./actions";
import { AdminIdle } from "./idle";
import { ThemeToggle } from "@/components/theme-toggle";
import { ADMIN_IDLE_SECONDS } from "@/lib/auth/admin-idle";

export const metadata = { title: "Platform admin" };

// BRD §4 Super Admin (platform operator): every tenant, its owner and its plan. The Super Admin is the only
// admin: there is no administrator role inside a company, and a company's owner never changes (decision of 30 Oct).
// Access is a row in platform_admins (granted by the operator in SQL, never automatically) and
// every action is checked on the server (is_super_admin() with the signed-in user's session) before it
// runs. Creating a company uses the server-only service client after that check
// (the key never reaches the browser) and is written to the audit log. "Open" enters a company in
// the company app, where the Super Admin acts as an administrator in every company (decision of 30 Oct,
// 0052 and 0055, with the BRD Admin rights); every visit and write is audited.
//
// The portal has its own session (lib/supabase/scopes.ts: cookie on path /admin), separate from the
// company session, so a Super Admin and an employee can be signed in at once in one browser.

/** the admin portal's session: signed in, two-factor done, and the platform Super Admin */
async function adminSession() {
  const supabase = await createClient("admin");
  const user = await currentUser(supabase);
  if (!user) return { supabase, user: null, superAdmin: false };
  if (needsSecondFactor(user)) redirect("/admin/mfa");
  const { data } = await supabase.rpc("is_super_admin");
  return { supabase, user, superAdmin: !!data };
}

/** for every action on this page: refuse unless the admin session is a Super Admin's */
async function requireSuperAdmin() {
  const s = await adminSession();
  if (!s.user || !s.superAdmin) throw new Error("Your admin session has ended. Sign in to the admin portal again.");
  return s as { supabase: typeof s.supabase; user: NonNullable<typeof s.user>; superAdmin: true };
}

/** the owner account for a company: an existing account, looked up by email */
async function accountByEmail(email: string | null | undefined) {
  const e = email?.trim().toLowerCase();
  if (!e) throw new Error("Enter the owner's email.");
  const { data } = await createAdminClient().from("profiles").select("id, email, full_name").eq("email", e).maybeSingle();
  if (!data) throw new Error(`No account with email ${e}. They need to create an account first (Sign up).`);
  return data as { id: string; email: string; full_name: string | null };
}

/** the owner also has an employee record in the company, as when a company is set up */
async function ensureOwnerEmployee(cid: string, owner: { id: string; email: string; full_name: string | null }) {
  const admin = createAdminClient();
  const { data: has } = await admin.from("employees").select("id").eq("company_id", cid).eq("user_id", owner.id).maybeSingle();
  if (has) return;
  const [first, ...rest] = (owner.full_name?.trim() || owner.email.split("@")[0]).split(" ");
  must(await admin.from("employees").insert({ company_id: cid, user_id: owner.id, first_name: first, last_name: rest.join(" ") || null,
    email: owner.email, date_of_joining: new Date().toISOString().slice(0, 10) }));
}

async function audit(cid: string, actor: string, action: string, data: Record<string, unknown>) {
  await createAdminClient().from("audit_log").insert({ company_id: cid, user_id: actor, table_name: "companies", record_id: cid,
    action, new_data: data, via_super_admin: true });
}

// companies are created only here, by the Super Admin, for an existing account (which may be your own)
async function createCompany(_: ActionState, fd: FormData): Promise<ActionState> {
  "use server";
  return attempt(async () => {
    const { user } = await requireSuperAdmin();
    const name = str(fd, "name")?.trim();
    if (!name) throw new Error("Enter the company name.");
    const owner = await accountByEmail(str(fd, "owner_email"));
    const admin = createAdminClient();
    const { data: dup } = await admin.from("companies").select("id").ilike("name", name).maybeSingle();
    if (dup) throw new Error(`A company called ${name} already exists.`);
    // the owner membership and the company defaults are added by database triggers
    const c = must(await admin.from("companies").insert({ owner_id: owner.id, name, legal_name: name }).select("id").single());
    await ensureOwnerEmployee(c.id, owner);
    await audit(c.id, user.id, "super_admin_create_company", { name, owner_email: owner.email });
    revalidatePath("/admin");
    return `${name} created, owned by ${owner.email}. It appears in their company switcher after a page reload.`;
  });
}

async function savePlan(_: ActionState, fd: FormData): Promise<ActionState> {
  "use server";
  return attempt(async () => {
    const { supabase } = await requireSuperAdmin();
    must(await supabase.rpc("sa_update_company", {
      p_company: str(fd, "id"), p_plan: str(fd, "plan") ?? "pilot", p_employee_limit: numOrNull(fd, "employee_limit"),
      p_renewal: str(fd, "renewal_date"), p_status: str(fd, "status") ?? "active",
    }));
    revalidatePath("/admin");
    return "Saved.";
  });
}

type Row = { id: string; name: string; status: string; plan: string; employee_limit: number | null; renewal_date: string | null;
  created_at: string; owner_email: string | null; active_employees: number; admins: { user_id: string; email: string; role: string; active: boolean }[] };

export default async function PlatformAdmin({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { supabase, user: me, superAdmin } = await adminSession();
  if (!me) return <AdminSignIn expired={(await searchParams).expired === "1"} />;
  if (!superAdmin) {
    // a session that was a Super Admin's when it signed in, but the role has since been removed
    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-50 px-5">
        <div className="card max-w-md p-8 text-center">
          <h1 className="text-xl font-semibold text-slate-900">No access</h1>
          <p className="mt-2 text-sm text-slate-600"><b className="font-medium">{me.email}</b> is not a platform Super Admin.</p>
          <form action={adminSignOut} className="mt-6"><button className="btn-secondary">Sign out of the admin portal</button></form>
        </div>
      </main>
    );
  }
  const { data } = await supabase.rpc("sa_companies");
  const companies = (data ?? []) as Row[];
  const total = companies.reduce((t, c) => t + Number(c.active_employees), 0);
  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <SessionGuard userId={me.id} scope="admin" signInPath="/admin" />
      <AdminIdle idleSeconds={ADMIN_IDLE_SECONDS} />
      <div className="sticky top-0 z-10 -mx-4 flex items-center justify-between gap-3 border-b border-slate-200 bg-surface/90 px-4 py-2.5 backdrop-blur sm:-mx-6 sm:px-6">
        <span className="text-sm text-slate-500">Admin portal · signed in as <b className="font-medium text-slate-700">{me.email}</b>
          <span className="ml-2 hidden text-xs text-slate-500 sm:inline">Signs out after 15 minutes idle or when the browser closes</span></span>
        <span className="flex items-center gap-1"><ThemeToggle /><form action={adminSignOut}><button className="btn-secondary btn-sm">Sign out of admin</button></form></span>
      </div>
      <div className="mt-4"><PageHeader title="Platform admin" subtitle="All tenants on corpgroup.com: owners, plans and seats" /></div>
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Companies" value={companies.length} />
        <Stat label="Active" value={companies.filter((c) => c.status === "active").length} tone="green" />
        <Stat label="Employees" value={total} />
        <Stat label="Owners" value={new Set(companies.map((c) => c.owner_email)).size} />
      </div>
      <Card title="Add a company" className="mb-6" description="The owner must already have an account. Sign-up alone never creates a company.">
        <ActionForm action={createCompany} className="flex flex-wrap items-end gap-2 [&>p]:basis-full" resetOnSuccess>
          <input name="name" placeholder="Company name" className="input w-60" required />
          <input name="owner_email" type="email" placeholder="owner@company.com" defaultValue={me.email ?? ""} className="input w-64" required />
          <SubmitButton className="btn-primary">Create company</SubmitButton>
        </ActionForm>
      </Card>
      <Card pad={false} title="Tenants">
        <Table head={["Company", "Owner", "Employees", "Plan · seats · renewal · status"]}>
          {companies.map((c) => {
            const over = c.employee_limit && Number(c.active_employees) > c.employee_limit;
            return (
              <tr key={c.id} className="align-top">
                <td className="td font-medium text-slate-900">{c.name}<div className="text-xs font-normal text-slate-500">since {fmtDate(c.created_at)}</div>
                  <a href={`/c/${c.id}/dashboard`} className="text-xs font-medium text-brand-600 hover:underline" title="Opens the company as its Admin">Open →</a></td>
                <td className="td text-xs">{c.owner_email ?? "—"}</td>
                <td className={`td tabular-nums ${over ? "font-semibold text-rose-600" : ""}`}>{c.active_employees}{c.employee_limit ? ` / ${c.employee_limit}` : ""}</td>
                <td className="td">
                  <ActionForm action={savePlan} className="flex flex-wrap items-center gap-2 [&>p]:basis-full">
                    <input type="hidden" name="id" value={c.id} />
                    <select name="plan" defaultValue={c.plan} className="input h-8 w-28 text-xs"><option value="pilot">Pilot</option><option value="starter">Starter</option><option value="growth">Growth</option><option value="enterprise">Enterprise</option></select>
                    <input name="employee_limit" type="number" min={1} defaultValue={c.employee_limit ?? ""} placeholder="Seats" className="input h-8 w-20 text-xs" />
                    <input name="renewal_date" type="date" defaultValue={c.renewal_date ?? ""} className="input h-8 w-36 text-xs" />
                    <select name="status" defaultValue={c.status} className="input h-8 w-28 text-xs"><option value="active">Active</option><option value="archived">Archived</option></select>
                    <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
                  </ActionForm>
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
      <p className="mt-4 text-xs text-slate-500">
        A company&apos;s owner is set when it is created and never changes; there are no company administrators.
        Super admins are granted only by the platform operator (see README → Super Admin). Opening a company is recorded in its audit log.
        &ldquo;Open&rdquo; goes to the company app, which has its own sign-in: the admin portal&apos;s session is separate. There you are the company&apos;s Admin (BRD §5.3): settings, policies, devices, roles, employees, attendance, leave and approving payroll (never a run you prepared). Everything you change is in that company&apos;s audit log.
      </p>
    </main>
  );
}
