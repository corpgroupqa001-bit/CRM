import { getCtx, requirePerm } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table, Tabs } from "@/components/ui";
import { fmtDate, fmtDateTime, label } from "@/lib/format";
import { ASSIGNABLE_ROLES, ROLE_LABEL, type Role } from "@/lib/rbac";
import { addHoliday, addSchedule, deleteRow, saveDepartment, saveDesignation, setDesignationAccess, setOrgActive, deleteSchedule, resolveDataRequest, saveBranch, saveChatSettings, saveCompany, savePolicies, setMemberRole } from "./actions";

export const metadata = { title: "Settings" };

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export default async function Settings({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "settings.manage", "settings.org");
  const { supabase, company, perms } = ctx;
  const admin = perms.has("settings.manage");
  const base = `/c/${cid}/settings`;
  // Administrator: everything. HR Manager: departments, designations and holidays, plus the audit log.
  const allTabs = [
    { key: "company", label: "Company", href: `${base}?tab=company`, perm: "settings.manage" },
    { key: "branches", label: "Branches", href: `${base}?tab=branches`, perm: "settings.manage" },
    { key: "org", label: "Departments & designations", href: `${base}?tab=org`, perm: "settings.org" },
    { key: "calendar", label: "Holidays", href: `${base}?tab=calendar`, perm: "settings.org" },
    { key: "policies", label: "Policies", href: `${base}?tab=policies`, perm: "settings.manage" },
    { key: "members", label: "Users & roles", href: `${base}?tab=members`, perm: "employees.assign_role" },
    { key: "chat", label: "Chat", href: `${base}?tab=chat`, perm: "settings.manage" },
    { key: "reports", label: "Scheduled reports", href: `${base}?tab=reports`, perm: "settings.manage" },
    { key: "privacy", label: "Privacy requests", href: `${base}?tab=privacy`, perm: "settings.manage" },
    { key: "audit", label: "Audit log", href: `${base}?tab=audit`, perm: "audit.read" },
  ] as const;
  const tabs = allTabs.filter((t) => perms.has(t.perm));
  const requested = sp.tab ?? tabs[0]?.key;
  // a tab the role may not open falls back to the first allowed one (direct URLs included)
  const tab = tabs.some((t) => t.key === requested) ? requested : tabs[0]?.key;

  let body: React.ReactNode = null;

  if (tab === "company") {
    body = (
      <Card title="Company profile">
        <ActionForm action={saveCompany.bind(null, cid)} className="grid gap-4 md:grid-cols-2">
          <fieldset disabled={!admin} className="contents">
            <Field label="Company name"><input className="input" name="name" defaultValue={company.name} required /></Field>
            <Field label="Legal name"><input className="input" name="legal_name" defaultValue={company.legal_name ?? ""} /></Field>
            <Field label="Address" className="md:col-span-2"><textarea className="input" name="address" rows={2} defaultValue={company.address ?? ""} /></Field>
            <Field label="State" hint="Professional Tax slabs follow this state"><input className="input" name="state" defaultValue={company.state ?? ""} /></Field>
            <Field label="Employee code prefix" hint="EMP → EMP0001, EMP0002…"><input className="input" name="emp_code_prefix" defaultValue={company.emp_code_prefix} /></Field>
            <Field label="GSTIN"><input className="input" name="gstin" defaultValue={company.gstin ?? ""} /></Field>
            <Field label="PAN"><input className="input" name="pan" defaultValue={company.pan ?? ""} /></Field>
            <Field label="TAN"><input className="input" name="tan" defaultValue={company.tan ?? ""} /></Field>
            <Field label="PF registration no."><input className="input" name="pf_reg_no" defaultValue={company.pf_reg_no ?? ""} /></Field>
            <Field label="ESI registration no."><input className="input" name="esi_reg_no" defaultValue={company.esi_reg_no ?? ""} /></Field>
            <Field label="Logo" hint="PNG or JPG, up to 2 MB"><input className="input" name="logo" type="file" accept="image/*" /></Field>
            {admin && <div className="md:col-span-2"><SubmitButton>Save</SubmitButton></div>}
          </fieldset>
        </ActionForm>
      </Card>
    );
  }

  if (tab === "company") {
    const { count: active } = await supabase.from("employees").select("id", { count: "exact", head: true }).eq("company_id", cid).in("status", ["active", "notice"]);
    body = (
      <div className="space-y-6">
        <Card title="Subscription" description="Plan, seats and renewal for this company">
          <div className="grid gap-4 sm:grid-cols-4">
            <div><div className="text-xs text-slate-500">Plan</div><div className="mt-0.5 font-semibold capitalize">{company.plan}</div></div>
            <div><div className="text-xs text-slate-500">Active employees</div><div className="mt-0.5 font-semibold">{active ?? 0}{company.employee_limit ? ` / ${company.employee_limit}` : ""}</div></div>
            <div><div className="text-xs text-slate-500">Renewal</div><div className="mt-0.5 font-semibold">{company.renewal_date ? fmtDate(company.renewal_date) : "—"}</div></div>
            <div><div className="text-xs text-slate-500">Status</div><div className="mt-0.5"><Badge value={company.status} /></div></div>
          </div>
          <p className="mt-3 text-xs text-slate-500">Plans and seat limits are managed by the platform operator. Contact support to change your plan.</p>
        </Card>
        {body}
      </div>
    );
  }

  if (tab === "chat") {
    const c = company;
    // admins aren't members of every conversation, so the list is read with the service role (owner / admin only)
    const { data: convs } = admin
      ? await createAdminClient().from("conversations").select("id, kind, name, dm_key, last_message_at").eq("company_id", cid).order("last_message_at", { ascending: false }).limit(100)
      : { data: [] };
    const { data: dir } = await supabase.from("employee_directory").select("user_id, full_name").eq("company_id", cid);
    const n = new Map((dir ?? []).map((d) => [d.user_id, d.full_name]));
    body = (
      <div className="space-y-6">
        <Card title="Chat policy">
          <ActionForm action={saveChatSettings.bind(null, cid)} className="space-y-4">
            <fieldset disabled={!admin} className="space-y-4">
              <label className="flex items-start gap-2 text-sm"><input type="checkbox" name="chat_cross_dept" defaultChecked={c.chat_cross_dept} className="mt-0.5" />
                <span>Allow direct messages across departments<span className="block text-xs text-slate-500">When off, people can only start 1:1 chats inside their own department. HR and admins can always message anyone.</span></span></label>
              <Field label="Keep messages for (days)" hint="Older messages are deleted automatically every night. Minimum 30."><input className="input w-40" type="number" min={30} name="chat_retention_days" defaultValue={c.chat_retention_days} /></Field>
              {admin && <SubmitButton>Save</SubmitButton>}
            </fieldset>
          </ActionForm>
        </Card>
        {admin && (
          <Card title="Compliance export" description="Download any conversation as CSV. Every export is recorded in the audit log." pad={false}>
            <Table head={["Conversation", "Type", "Last message", ""]}>
              {(convs ?? []).map((cv) => {
                const label2 = cv.kind === "dm" ? cv.dm_key.split(":").map((u: string) => n.get(u) ?? "former member").join(" ↔ ") : cv.name;
                return <tr key={cv.id}><td className="td font-medium">{label2}</td><td className="td capitalize">{cv.kind}</td><td className="td">{fmtDateTime(cv.last_message_at)}</td>
                  <td className="td text-right"><a className="btn-secondary btn-sm" href={`/api/export/chat?company=${cid}&conversation=${cv.id}`}>Export CSV</a></td></tr>;
              })}
            </Table>
          </Card>
        )}
      </div>
    );
  }

  if (tab === "reports") {
    const { data: schedules } = await supabase.from("report_schedules").select("*").eq("company_id", cid).order("created_at");
    body = (
      <div className="space-y-6">
        <Card title="Scheduled reports" description="Excel reports emailed automatically. Needs a mail server (SMTP) to be configured." pad={false}>
          <Table head={["Report", "Frequency", "Recipients", "Last sent", ""]} empty="No scheduled reports.">
            {(schedules ?? []).map((r) => <tr key={r.id}><td className="td capitalize">{r.report}</td><td className="td capitalize">{r.frequency}</td>
              <td className="td text-xs">{r.recipients.join(", ")}</td><td className="td">{r.last_sent_at ? fmtDateTime(r.last_sent_at) : "Not yet"}</td>
              <td className="td text-right"><form action={deleteSchedule.bind(null, cid, r.id)}><button className="text-sm text-rose-600">Remove</button></form></td></tr>)}
          </Table>
        </Card>
        <Card title="Add a schedule">
          <ActionForm action={addSchedule.bind(null, cid)} className="grid gap-4 md:grid-cols-4" resetOnSuccess>
            <Field label="Report"><select className="input" name="report"><option value="attendance">Attendance (monthly muster)</option><option value="employees">Employee directory</option><option value="projects">Projects</option></select></Field>
            <Field label="Frequency"><select className="input" name="frequency"><option value="daily">Daily</option><option value="weekly">Weekly (Monday)</option><option value="monthly">Monthly (1st)</option></select></Field>
            <Field label="Recipients" className="md:col-span-2" hint="Comma separated"><input className="input" name="recipients" placeholder="owner@company.com, hr@company.com" required /></Field>
            <div className="md:col-span-4"><SubmitButton>Add schedule</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    );
  }

  if (tab === "privacy") {
    const { data: reqs } = await supabase.from("data_requests").select("*").eq("company_id", cid).order("created_at", { ascending: false });
    const { data: profs } = await supabase.from("profiles").select("id, full_name, email");
    const who = new Map((profs ?? []).map((p) => [p.id, p.full_name ?? p.email]));
    body = (
      <Card title="Personal data requests (DPDP Act, 2023)" description="Employees ask from Account & security. Exports are self-service; deletions need you to deactivate the person and remove their documents, keeping payroll and attendance for the 8-year legal retention." pad={false}>
        <Table head={["Requested", "Person", "Request", "Note", "Status", ""]} empty="No requests.">
          {(reqs ?? []).map((r) => <tr key={r.id}><td className="td">{fmtDateTime(r.created_at)}</td><td className="td">{who.get(r.user_id) ?? "—"}</td>
            <td className="td capitalize">{r.kind}</td><td className="td max-w-xs text-xs">{r.note}</td><td className="td"><Badge value={r.status === "open" ? "pending" : r.status === "done" ? "completed" : "rejected"} text={label(r.status)} /></td>
            <td className="td text-right">{r.status === "open" && admin && <span className="flex justify-end gap-2">
              <form action={resolveDataRequest.bind(null, cid, r.id, "done")}><button className="btn-primary btn-sm">Mark done</button></form>
              <form action={resolveDataRequest.bind(null, cid, r.id, "rejected")}><button className="btn-secondary btn-sm">Reject</button></form></span>}</td></tr>)}
        </Table>
      </Card>
    );
  }

  if (tab === "branches") {
    const { data: branches } = await supabase.from("branches").select("*").eq("company_id", cid).order("name");
    body = (
      <div className="space-y-6">
        <Card title="Branches / work locations" pad={false}>
          <Table head={["Name", "Address", "Location", "Geofence", ""]}>
            {(branches ?? []).map((b) => (
              <tr key={b.id}>
                <td className="td font-medium">{b.name}</td><td className="td">{b.address}</td>
                <td className="td text-xs">{b.lat != null ? `${b.lat}, ${b.lng}` : <span className="text-amber-600">Not set (needed for mobile punch)</span>}</td>
                <td className="td">{b.geofence_m} m</td>
                <td className="td text-right">{admin && <form action={deleteRow.bind(null, cid, "branches", b.id)}><button className="text-sm text-rose-600">Delete</button></form>}</td>
              </tr>
            ))}
          </Table>
        </Card>
        {admin && (
          <Card title="Add branch">
            <ActionForm action={saveBranch.bind(null, cid)} className="grid gap-4 md:grid-cols-3" resetOnSuccess>
              <Field label="Name"><input className="input" name="name" required /></Field>
              <Field label="State"><input className="input" name="state" /></Field>
              <Field label="Geofence radius (m)"><input className="input" name="geofence_m" type="number" defaultValue={200} min={20} /></Field>
              <Field label="Address" className="md:col-span-3"><input className="input" name="address" /></Field>
              <Field label="Latitude" hint="From Google Maps: right-click → copy coordinates"><input className="input" name="lat" type="number" step="any" /></Field>
              <Field label="Longitude"><input className="input" name="lng" type="number" step="any" /></Field>
              <div className="md:col-span-3"><SubmitButton>Add branch</SubmitButton></div>
            </ActionForm>
          </Card>
        )}
      </div>
    );
  }

  if (tab === "org") {
    const [{ data: depRows }, { data: desigRows }] = await Promise.all([
      supabase.from("departments").select("id, name, active").eq("company_id", cid).order("name"),
      supabase.from("designations").select("id, name, active, department_id, access_role").eq("company_id", cid).order("name"),
    ]);
    type Dep = { id: string; name: string; active: boolean };
    type Desig = Dep & { department_id: string | null; access_role: string | null };
    const deps = (depRows ?? []) as Dep[];
    const desigs = (desigRows ?? []) as Desig[];
    const activeDeps = deps.filter((d) => d.active);
    const toggle = (table: "departments" | "designations", r: Dep) => (
      <form action={setOrgActive.bind(null, cid, table, r.id, !r.active)}>
        <button className={`text-xs font-medium ${r.active ? "text-rose-600" : "text-brand-600"}`}>{r.active ? "Deactivate" : "Activate"}</button>
      </form>
    );
    const status = (r: Dep) => !r.active && <Badge value="inactive" text="Inactive" />;

    const departmentsCard = (
      <Card title="Departments" description="Candidates choose a department first, then one of its designations. Deactivating hides a department from sign-up and pickers; employees keep it.">
        <ul className="mb-4 divide-y divide-slate-100">
          {deps.map((d) => (
            <li key={d.id} className="flex items-center gap-2 py-2">
              <ActionForm action={saveDepartment.bind(null, cid)} className="flex flex-1 flex-wrap items-center gap-2 [&>p]:basis-full">
                <input type="hidden" name="id" value={d.id} />
                <input className="input h-8 flex-1 text-sm" name="name" defaultValue={d.name} required aria-label="Department name" />
                {status(d)}
                <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
              </ActionForm>
              {toggle("departments", d)}
            </li>
          ))}
        </ul>
        <ActionForm action={saveDepartment.bind(null, cid)} className="flex gap-2" resetOnSuccess>
          <input className="input" name="name" placeholder="e.g. Engineering / IT" required /><SubmitButton className="btn-secondary">Add</SubmitButton>
        </ActionForm>
      </Card>
    );

    // designations grouped under their department; ones without a department are never offered to candidates
    const groups = [
      ...deps.map((d) => ({ key: d.id, title: d.name, dep: d, rows: desigs.filter((g) => g.department_id === d.id) })),
      { key: "none", title: "No department", dep: null, rows: desigs.filter((g) => !g.department_id) },
    ].filter((g) => g.rows.length > 0);
    const designationsCard = (
      <Card title="Designations" className="md:col-span-2"
        description="Each designation belongs to one department, so a candidate in HR only sees HR roles. The same title can exist in two departments.">
        {groups.length === 0 && <p className="mb-4 text-sm text-slate-500">No designations yet. Add one below; candidates can&apos;t sign up until their department has at least one.</p>}
        <div className="mb-5 space-y-5">
          {groups.map((g) => (
            <div key={g.key}>
              <h4 className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {g.title}{g.dep && status(g.dep)}
                {!g.dep && <span className="font-normal normal-case text-amber-700">Not offered at sign-up until a department is chosen</span>}
                {g.dep && !g.dep.active && <span className="font-normal normal-case text-slate-500">Not offered while the department is inactive</span>}
              </h4>
              <ul className="divide-y divide-slate-100">
                {g.rows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 py-2">
                    <ActionForm action={saveDesignation.bind(null, cid)} className="flex flex-1 flex-wrap items-center gap-2 [&>p]:basis-full">
                      <input type="hidden" name="id" value={r.id} />
                      <input className="input h-8 min-w-40 flex-1 text-sm" name="name" defaultValue={r.name} required aria-label="Designation name" />
                      <select className="input h-8 w-48 text-sm" name="department_id" defaultValue={r.department_id ?? ""} required aria-label="Department">
                        <option value="" disabled>Choose department</option>
                        {deps.filter((d) => d.active || d.id === r.department_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      {status(r)}
                      <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
                    </ActionForm>
                    {toggle("designations", r)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <ActionForm action={saveDesignation.bind(null, cid)} className="flex flex-wrap gap-2 [&>p]:basis-full" resetOnSuccess>
          <select className="input w-56" name="department_id" required defaultValue="" aria-label="Department">
            <option value="" disabled>{activeDeps.length ? "Department" : "Add a department first"}</option>
            {activeDeps.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input className="input flex-1" name="name" placeholder="e.g. Software Engineer" required />
          <SubmitButton className="btn-secondary">Add designation</SubmitButton>
        </ActionForm>
      </Card>
    );
    // designation → access role (Administrators): what a candidate with this designation gets on approval
    const canMap = perms.has("employees.assign_role");
    const access = canMap && (
      <Card title="Access by designation" className="md:col-span-2"
        description="When a new candidate signs up with a designation, the administrator approving them starts from this role (and can change it). A designation never grants access without that approval.">
        <Table head={["Designation", "Department", "Access role on approval"]} empty="Add designations above first.">
          {desigs.filter((d) => d.active).map((d) => (
            <tr key={d.id}><td className="td font-medium">{d.name}</td>
              <td className="td text-slate-500">{deps.find((x) => x.id === d.department_id)?.name ?? "—"}</td>
              <td className="td"><ActionForm action={setDesignationAccess.bind(null, cid, d.id)} className="flex flex-wrap items-center gap-2 [&>p]:basis-full">
                <select name="access_role" defaultValue={d.access_role ?? ""} className="input h-8 w-48 text-sm">
                  <option value="">Not set (administrator chooses)</option>
                  {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
                <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
              </ActionForm></td></tr>
          ))}
        </Table>
      </Card>
    );
    body = <div className="grid gap-6 md:grid-cols-2">{departmentsCard}{designationsCard}{access}</div>;
  }

  if (tab === "calendar") {
    const [{ data: hols }, { data: branches }] = await Promise.all([
      supabase.from("holidays").select("*, branches(name)").eq("company_id", cid).order("date"),
      supabase.from("branches").select("id, name").eq("company_id", cid),
    ]);
    body = (
      <div className="space-y-6">
        <Card title="Holiday list" pad={false}>
          <Table head={["Date", "Holiday", "Branch", ""]}>
            {(hols ?? []).map((h) => (
              <tr key={h.id}><td className="td">{fmtDate(h.date)}</td><td className="td">{h.name}</td>
                <td className="td">{(h.branches as { name: string } | null)?.name ?? "All branches"}</td>
                <td className="td text-right"><form action={deleteRow.bind(null, cid, "holidays", h.id)}><button className="text-sm text-rose-600">Delete</button></form></td></tr>
            ))}
          </Table>
        </Card>
        <Card title="Add holiday">
          <ActionForm action={addHoliday.bind(null, cid)} className="grid gap-4 md:grid-cols-4" resetOnSuccess>
            <Field label="Date"><input className="input" name="date" type="date" required /></Field>
            <Field label="Name"><input className="input" name="name" required /></Field>
            <Field label="Branch"><select className="input" name="branch_id"><option value="">All branches</option>{(branches ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
            <div className="flex items-end"><SubmitButton>Add</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    );
  }

  if (tab === "policies") {
    const m = company.payable_map;
    body = (
      <Card title="Attendance & payroll policies">
        <ActionForm action={savePolicies.bind(null, cid)} className="space-y-6">
          <fieldset disabled={!admin} className="space-y-6">
            <div>
              <div className="label">Weekly offs</div>
              <div className="flex flex-wrap gap-3">{DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="weekly_offs" value={i} defaultChecked={company.weekly_offs.includes(i)} /> {d}</label>
              ))}</div>
            </div>
            <div className="grid gap-4 md:grid-cols-3">
              <Field label="Financial year starts in"><select className="input" name="fy_start_month" defaultValue={company.fy_start_month}>
                {Array.from({ length: 12 }, (_, i) => <option key={i} value={i + 1}>{new Date(2026, i, 1).toLocaleString("en-IN", { month: "long" })}</option>)}</select></Field>
              <Field label="Salary days basis" hint="The proration ratio is always capped at 1.0">
                <select className="input" name="salary_days_basis" defaultValue={company.salary_days_basis}>
                  <option value="calendar">Calendar days in the month</option><option value="30">Fixed 30</option><option value="26">Fixed 26</option></select></Field>
              <Field label="Overtime multiplier"><input className="input" name="ot_multiplier" type="number" step="0.25" min={1} defaultValue={company.ot_multiplier} /></Field>
              <Field label="Late marks that make a half-day" hint="0 turns the rule off"><input className="input" name="late_marks_to_half_day" type="number" min={0} defaultValue={company.late_marks_to_half_day} /></Field>
              <label className="flex items-center gap-2 pt-6 text-sm md:col-span-2"><input type="checkbox" name="sandwich_paid" defaultChecked={company.sandwich_paid} />
                Pay a weekly off / holiday that falls between two LOP days (sandwich rule)</label>
              <label className="flex items-start gap-2 text-sm md:col-span-3"><input type="checkbox" name="payslip_password" defaultChecked={company.payslip_password} className="mt-0.5" />
                <span>Password-protect payslip PDFs <span className="block text-xs text-slate-500">The password is the employee&apos;s date of birth as DDMMYYYY, or their employee code if no date of birth is recorded.</span></span></label>
            </div>
            <div>
              <div className="label">Payable value of each daily status (1 = full day, 0.5 = half, 0 = LOP)</div>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                {Object.keys(m).map((s) => (
                  <Field key={s} label={label(s)}><select className="input" name={`map_${s}`} defaultValue={String(m[s])}>
                    <option value="1">1</option><option value="0.5">0.5</option><option value="0">0</option></select></Field>
                ))}
              </div>
              <p className="mt-2 text-xs text-slate-500">Paid leave counts as 1 and LOP leave as 0, from each leave type. Shifts are managed under Attendance → Shifts.</p>
            </div>
            {admin && <SubmitButton>Save policies</SubmitButton>}
          </fieldset>
        </ActionForm>
      </Card>
    );
  }

  if (tab === "members") {
    const { data: members } = await supabase.from("company_members").select("id, user_id, role, active, created_at").eq("company_id", cid);
    const { data: dir } = await supabase.from("employee_directory").select("user_id, full_name, email").eq("company_id", cid);
    const byUser = new Map((dir ?? []).map((d) => [d.user_id, d]));
    body = (
      <Card title="Users & roles" pad={false}>
        <Table head={["User", "Role", "Access", ""]}>
          {(members ?? []).map((m) => {
            const d = byUser.get(m.user_id);
            return (
              <tr key={m.id}>
                <td className="td"><div className="font-medium">{d?.full_name ?? "—"}</div><div className="text-xs text-slate-500">{d?.email}</div></td>
                <td className="td" colSpan={3}>
                  {m.role === "owner" || !admin ? <span className="flex gap-3">{ROLE_LABEL[m.role as Role]} <Badge value={m.active ? "active" : "inactive"} /></span> : (
                    <ActionForm action={setMemberRole.bind(null, cid)} className="flex flex-wrap items-center gap-2">
                      <input type="hidden" name="id" value={m.id} />
                      <select name="role" defaultValue={m.role} className="input w-44">
                        {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <select name="active" defaultValue={String(m.active)} className="input w-32"><option value="true">Active</option><option value="false">Disabled</option></select>
                      <SubmitButton className="btn-secondary">Update</SubmitButton>
                    </ActionForm>
                  )}
                </td>
              </tr>
            );
          })}
        </Table>
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">New users join by invitation from the employee record (Employees → open employee → Send invite).</p>
      </Card>
    );
  }

  if (tab === "audit") {
    const { data: logs } = await supabase.from("audit_log").select("*").eq("company_id", cid).order("at", { ascending: false }).limit(200);
    const { data: dir } = await supabase.from("profiles").select("id, full_name, email");
    const who = new Map((dir ?? []).map((d) => [d.id, d.full_name ?? d.email]));
    body = (
      <Card title="Audit log (latest 200)" pad={false}>
        <Table head={["When", "Who", "Table", "Action", "Change", "IP"]}>
          {(logs ?? []).map((l) => {
            const changed = l.old_data && l.new_data
              ? Object.keys(l.new_data).filter((k) => k !== "updated_at" && JSON.stringify(l.old_data[k]) !== JSON.stringify(l.new_data[k]))
                  .map((k) => `${k}: ${JSON.stringify(l.old_data[k])} → ${JSON.stringify(l.new_data[k])}`).join("; ")
              : l.action === "unlock" || l.action === "reopen" ? `reason: ${l.new_data?.reason}` : "";
            return (
              <tr key={l.id}><td className="td whitespace-nowrap">{fmtDateTime(l.at)}</td><td className="td">{l.user_id ? who.get(l.user_id) ?? "user" : "system"}</td>
                <td className="td">{l.table_name}</td><td className="td">{l.action}</td>
                <td className="td max-w-md truncate text-xs text-slate-500" title={changed}>{changed}</td><td className="td text-xs">{l.ip}</td></tr>
            );
          })}
        </Table>
      </Card>
    );
  }

  return (
    <>
      <PageHeader title="Settings" subtitle={company.name} />
      <Tabs tabs={tabs} active={tab} />
      {body}
    </>
  );
}
