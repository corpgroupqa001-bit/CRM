import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Avatar, Badge, Card, Field, PageHeader, Table, Tabs } from "@/components/ui";
import { fmtDate, fmtDateTime, label, money } from "@/lib/format";
import { fullName } from "@/lib/employees";
import {
  documentUrl, inviteEmployee, issueAsset, lifecycle, mapDevice, removeEmployee, returnAsset, saveStatutory, setEmployeePassword, toggleChecklist,
  transferCompany, unlockLogin, unmapDevice, updateEmployee,
} from "../actions";
import { lockStatus, PASSWORD_RULE } from "@/lib/auth/session";
import { lockoutLabel, lockTimeText } from "@/lib/auth/lockout";
import { JobFields, PersonalFields, StatutoryFields, jobOptions } from "../form-fields";
import { CompaniesTab } from "./companies-tab";

export const metadata = { title: "Employee" };

export default async function EmployeePage({ params, searchParams }: { params: Promise<{ cid: string; eid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { cid, eid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  const { supabase, perms, employee: me } = ctx;
  // Full record for HR / Admin, the person themself and their manager (RLS decides). Finance only
  // gets the pay-related view of other employees and so only sees the Statutory & bank tab.
  const { data: full } = await supabase.from("employees").select("*").eq("id", eid).eq("company_id", cid).maybeSingle();
  const payOnly = !full && perms.has("employees.pay_fields");
  const { data: payView } = payOnly
    ? await supabase.from("employee_pay_fields").select("*").eq("id", eid).eq("company_id", cid).maybeSingle()
    : { data: null };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const e = (full ?? payView) as ({ first_name: string; last_name: string | null } & Record<string, any>) | null;
  if (!e) notFound();
  const tab = payOnly ? "statutory" : sp.tab ?? "profile";
  const hr = perms.has("employees.update");        // HR Manager and Administrator: employee records
  const acct = perms.has("employees.account");     // HR / Payroll and administrators: invitations, login, activation
  const self = me?.id === eid;
  const base = `/c/${cid}/employees/${eid}`;
  const [{ data: dir }, { data: superAdmin }] = await Promise.all([
    supabase.from("employee_directory").select("department, designation, branch").eq("id", eid).maybeSingle(),
    supabase.rpc("is_super_admin"),
  ]);

  const tabs = payOnly ? [{ key: "statutory", label: "Statutory & bank", href: `${base}?tab=statutory` }] : [
    { key: "profile", label: "Profile", href: `${base}?tab=profile` },
    ...(hr ? [{ key: "job", label: "Job", href: `${base}?tab=job` }] : []),
    { key: "statutory", label: "Statutory & bank", href: `${base}?tab=statutory` },
    { key: "documents", label: "Documents", href: `${base}?tab=documents` },
    ...(perms.has("attendance.manage") ? [{ key: "devices", label: "Biometric IDs", href: `${base}?tab=devices` }] : []),
    ...(perms.has("salaries.read") ? [{ key: "salary", label: "Salary", href: `${base}?tab=salary` }] : []),
    ...(hr ? [
      { key: "lifecycle", label: "Lifecycle", href: `${base}?tab=lifecycle` },
      { key: "onboarding", label: "Onboarding", href: `${base}?tab=onboarding` },
      { key: "assets", label: "Assets", href: `${base}?tab=assets` },
    ] : []),
    // one person in several companies: assignments are managed by the platform Super Admin only
    ...(superAdmin ? [{ key: "companies", label: "Companies", href: `${base}?tab=companies` }] : []),
  ];

  let body: React.ReactNode = null;

  if (tab === "companies" && superAdmin) {
    body = <CompaniesTab ctx={ctx} eid={eid} userId={e.user_id ?? null} self={e.user_id === ctx.user.id} />;
  }

  if (tab === "profile") {
    body = (
      <Card title="Personal details">
        <ActionForm action={updateEmployee.bind(null, cid, eid, "personal")} className="grid gap-4 md:grid-cols-2">
          <PersonalFields e={e} selfOnly={!hr} />
          {(hr || self) && <div className="md:col-span-2"><SubmitButton>Save</SubmitButton>
            {!hr && <span className="ml-3 text-xs text-slate-500">You can update your contact details. Ask HR to change anything else.</span>}</div>}
        </ActionForm>
      </Card>
    );
  }

  if (tab === "job" && hr) {
    const o = await jobOptions(ctx);
    body = (
      <Card title="Job details">
        <ActionForm action={updateEmployee.bind(null, cid, eid, "job")} className="grid gap-4 md:grid-cols-3">
          <JobFields e={e} o={o} canSetRole={perms.has("employees.assign_role")} />
          <div className="md:col-span-3"><SubmitButton>Save</SubmitButton></div>
        </ActionForm>
      </Card>
    );
  }

  if (tab === "statutory") {
    const { data: reqs } = await supabase.from("employee_change_requests").select("*").eq("employee_id", eid).order("created_at", { ascending: false }).limit(5);
    body = (
      <div className="space-y-6">
        <Card title="Statutory and bank details">
          <ActionForm action={saveStatutory.bind(null, cid, eid)} className="grid gap-4 md:grid-cols-3">
            <StatutoryFields e={e} />
            {(hr || payOnly || self) && <div className="md:col-span-3"><SubmitButton>{hr || payOnly ? "Save" : "Request change"}</SubmitButton>
              <span className="ml-3 text-xs text-slate-500">{hr || payOnly ? "Blank fields keep their current value." : "Changes to PAN and bank details need HR approval."}</span></div>}
          </ActionForm>
        </Card>
        {!!reqs?.length && (
          <Card title="Change requests" pad={false}>
            <Table head={["Requested", "Change", "Status"]}>
              {reqs.map((r) => <tr key={r.id}><td className="td">{fmtDateTime(r.created_at)}</td><td className="td">{r.summary}</td><td className="td"><Badge value={r.status} /></td></tr>)}
            </Table>
          </Card>
        )}
      </div>
    );
  }

  if (tab === "documents") {
    const { data: docs } = await supabase.from("employee_documents").select("*").eq("employee_id", eid).order("created_at", { ascending: false });
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const { uploadDocument } = await import("../actions");
    body = (
      <div className="space-y-6">
        <Card title="Documents" pad={false}>
          <Table head={["Name", "Type", "Expiry", "Uploaded", ""]}>
            {(docs ?? []).map((d) => (
              <tr key={d.id}>
                <td className="td font-medium">{d.name}</td><td className="td">{label(d.doc_type)}</td>
                <td className={`td ${d.expiry_date && d.expiry_date <= soon ? "font-medium text-rose-600" : ""}`}>{fmtDate(d.expiry_date)}</td>
                <td className="td">{fmtDate(d.created_at)}</td>
                <td className="td text-right"><form action={documentUrl.bind(null, cid, d.storage_path)}><button className="text-sm text-brand-600 hover:underline">Download</button></form></td>
              </tr>
            ))}
          </Table>
        </Card>
        {(hr || self) && (
          <Card title="Upload document">
            <ActionForm action={uploadDocument.bind(null, cid, eid)} className="grid gap-4 md:grid-cols-4" resetOnSuccess>
              <Field label="File (≤ 50 MB)"><input className="input" name="file" type="file" required /></Field>
              <Field label="Name"><input className="input" name="name" placeholder="e.g. Offer letter" /></Field>
              <Field label="Type"><select className="input" name="doc_type">
                {["offer_letter", "id_proof", "address_proof", "certificate", "contract", "other"].map((t) => <option key={t} value={t}>{label(t)}</option>)}</select></Field>
              <Field label="Expiry date" hint="We'll remind HR 30 days before"><input className="input" name="expiry_date" type="date" /></Field>
              <div className="md:col-span-4"><SubmitButton>Upload</SubmitButton></div>
            </ActionForm>
          </Card>
        )}
      </div>
    );
  }

  if (tab === "devices" && perms.has("attendance.manage")) {
    const [{ data: maps }, { data: devices }] = await Promise.all([
      supabase.from("device_user_map").select("id, device_user_id, devices(name, serial_no)").eq("employee_id", eid),
      supabase.from("devices").select("id, name, serial_no").eq("company_id", cid).order("name"),
    ]);
    body = (
      <div className="space-y-6">
        <Card title="Biometric device IDs" pad={false}>
          <Table head={["Device", "Device user ID", ""]} empty="Not mapped to any device yet. Punches for unmapped IDs wait in the exceptions queue.">
            {(maps ?? []).map((m) => {
              const d = m.devices as unknown as { name: string; serial_no: string };
              return <tr key={m.id}><td className="td">{d?.name} <span className="text-xs text-slate-500">{d?.serial_no}</span></td><td className="td font-mono">{m.device_user_id}</td>
                <td className="td text-right"><form action={unmapDevice.bind(null, cid, eid, m.id)}><button className="text-sm text-rose-600">Remove</button></form></td></tr>;
            })}
          </Table>
        </Card>
        <Card title="Map to a device">
          {devices?.length ? (
            <ActionForm action={mapDevice.bind(null, cid, eid)} className="grid gap-4 md:grid-cols-3" resetOnSuccess>
              <Field label="Device"><select className="input" name="device_id">{devices.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.serial_no})</option>)}</select></Field>
              <Field label="User ID on the device"><input className="input" name="device_user_id" required /></Field>
              <div className="flex items-end"><SubmitButton>Map</SubmitButton></div>
            </ActionForm>
          ) : <p className="text-sm text-slate-500">Register a device first under <Link className="text-brand-600 hover:underline" href={`/c/${cid}/attendance/devices`}>Attendance → Devices</Link>.</p>}
        </Card>
      </div>
    );
  }

  if (tab === "salary" && perms.has("salaries.read")) {
    const { data: ctc } = await supabase.from("employee_ctc").select("*, salary_structures(name)").eq("employee_id", eid).order("effective_from", { ascending: false });
    body = (
      <Card title="Salary history" actions={perms.has("salaries.manage")
        ? <Link href={`/c/${cid}/payroll/salaries?employee=${eid}`} className="text-sm font-medium text-brand-600 hover:underline">Revise salary</Link>
        : <span className="text-xs text-slate-500">View only</span>} pad={false}>
        <Table head={["Effective from", "Annual gross", "Monthly", "Structure", "Note"]}>
          {(ctc ?? []).map((c) => <tr key={c.id}><td className="td">{fmtDate(c.effective_from)}</td><td className="td">{money(c.annual_ctc)}</td>
            <td className="td">{money(Number(c.annual_ctc) / 12)}</td><td className="td">{(c.salary_structures as { name: string } | null)?.name}</td><td className="td">{c.note}</td></tr>)}
        </Table>
      </Card>
    );
  }

  if (tab === "lifecycle" && hr) {
    const o = await jobOptions(ctx);
    const { data: myCompanies } = await supabase.from("company_members").select("role, companies(id, name)").eq("user_id", ctx.user.id).eq("active", true)
      .in("role", ["owner", "company_admin", "hr"]);
    const otherCompanies = (myCompanies ?? []).map((m) => m.companies as unknown as { id: string; name: string }).filter((c) => c.id !== cid);
    const { data: events } = await supabase.from("employee_events").select("*").eq("employee_id", eid).order("effective_date", { ascending: false });
    const act = lifecycle.bind(null, cid, eid);
    // AUTH-02 / AUTH-15: lockout state and recent sign-ins (login history is readable by the Owner and Company Admin)
    const [locked, { data: logins }] = e.user_id && acct
      ? await Promise.all([lockStatus(String(e.email).toLowerCase()),
          supabase.from("login_history").select("at, ip, user_agent, method").eq("user_id", e.user_id).order("at", { ascending: false }).limit(10)])
      : [null, { data: null }];
    const sel = (name: string, rows: { id: string; name?: string; full_name?: string }[], cur: string | null) => (
      <select className="input" name={name} defaultValue={cur ?? ""}><option value="">—</option>{rows.map((r) => <option key={r.id} value={r.id}>{r.full_name ?? r.name}</option>)}</select>);
    body = (
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Transfer">
          <ActionForm action={act} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="kind" value="transfer" />
            <Field label="Branch">{sel("branch_id", o.branches, e.branch_id)}</Field>
            <Field label="Department">{sel("department_id", o.departments, e.department_id)}</Field>
            <Field label="Reporting manager">{sel("reporting_manager_id", o.managers.filter((m) => m.id !== eid), e.reporting_manager_id)}</Field>
            <Field label="Effective"><input className="input" type="date" name="effective_date" required /></Field>
            <div className="sm:col-span-2"><SubmitButton className="btn-secondary">Record transfer</SubmitButton></div>
          </ActionForm>
        </Card>
        <Card title="Promotion">
          <ActionForm action={act} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="kind" value="promotion" />
            <Field label="New designation">{sel("designation_id", o.designations, e.designation_id)}</Field>
            <Field label="Effective"><input className="input" type="date" name="effective_date" required /></Field>
            <Field label="Note" className="sm:col-span-2"><input className="input" name="note" /></Field>
            <div className="sm:col-span-2"><SubmitButton className="btn-secondary">Record promotion</SubmitButton>
              {perms.has("salaries.manage") && <span className="ml-2 text-xs text-slate-500">Revise the salary from the Salary tab.</span>}</div>
          </ActionForm>
        </Card>
        <Card title="Resignation & exit">
          <ActionForm action={act} className="grid gap-3 sm:grid-cols-2" confirm="Record this resignation / exit?">
            <Field label="Action"><select className="input" name="kind"><option value="resignation">Resignation (serving notice)</option><option value="exit">Exit now</option></select></Field>
            <Field label="Resignation date"><input className="input" type="date" name="effective_date" /></Field>
            <Field label="Last working day"><input className="input" type="date" name="last_working_day" defaultValue={e.last_working_day ?? ""} /></Field>
            <Field label="Reason"><input className="input" name="note" /></Field>
            <div className="sm:col-span-2"><SubmitButton className="btn-secondary">Save</SubmitButton>
              <p className="mt-2 text-xs text-slate-500">The payroll run for the exit month adds leave encashment, gratuity (5+ years) and recovers advances — full and final settlement.</p></div>
          </ActionForm>
        </Card>
        {acct && <Card title="Access">
          <p className="mb-3 text-sm text-slate-600">Deactivating removes app access immediately and releases biometric IDs.</p>
          <ActionForm action={act} confirm={e.status === "inactive" ? "Reactivate this employee?" : "Deactivate this employee now?"}>
            <input type="hidden" name="kind" value={e.status === "inactive" ? "reactivated" : "deactivated"} />
            <SubmitButton className={e.status === "inactive" ? "btn-secondary" : "btn-danger"}>{e.status === "inactive" ? "Reactivate" : "Deactivate"}</SubmitButton>
          </ActionForm>
        </Card>}
        {perms.has("employees.delete") && e.user_id !== ctx.user.id && <Card title="Remove employee">
          <p className="mb-3 text-sm text-slate-600">Ends their access immediately and hides them from every list. Their attendance and payroll history is kept; a record created by mistake is deleted completely.</p>
          <ActionForm action={removeEmployee.bind(null, cid, eid)} className="space-y-2" confirm="Remove this employee? They lose access straight away.">
            <input name="note" className="input" placeholder="Reason (optional)" />
            <SubmitButton className="btn-danger">Remove employee</SubmitButton>
          </ActionForm>
        </Card>}
        {acct && <Card title="Login password" description={e.user_id ? "Set a new password if they're locked out." : "Not activated yet: setting a password creates their login now."}>
          <ActionForm action={setEmployeePassword.bind(null, cid, eid)} className="space-y-3" resetOnSuccess>
            <Field label="New password" hint={PASSWORD_RULE}><input className="input" name="password" type="text" autoComplete="off" minLength={8} required /></Field>
            <SubmitButton className="btn-secondary">{e.user_id ? "Set password" : "Create login"}</SubmitButton>
          </ActionForm>
        </Card>}
        {acct && e.user_id && <Card title="Sign-in" description={`Five wrong passwords in 15 minutes lock the login for ${lockoutLabel(ctx.company.lockout_minutes)} (Settings → Policies), or until someone here unlocks it.`}>
          <div className="flex flex-wrap items-center gap-3">
            <Badge value={locked ? "blocked" : "active"} text={locked ? `Locked until ${lockTimeText(locked)}` : "Not locked"} />
            {locked && <ActionForm action={unlockLogin.bind(null, cid, eid)} className="flex items-center gap-2"><SubmitButton className="btn-secondary btn-sm">Unlock now</SubmitButton></ActionForm>}
          </div>
          {logins && (
            <div className="mt-4">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">Recent sign-ins</div>
              {logins.length ? (
                <ul className="divide-y divide-slate-100 text-sm">
                  {logins.map((l, i) => <li key={i} className="flex flex-wrap justify-between gap-2 py-2"><span className="text-slate-700">{fmtDateTime(l.at)} · {label(l.method ?? "password")}</span>
                    <span className="max-w-full truncate text-xs text-slate-500" title={l.user_agent ?? ""}>{l.ip ?? "—"}</span></li>)}
                </ul>
              ) : <p className="text-sm text-slate-500">No sign-ins yet.</p>}
            </div>
          )}
        </Card>}
        {acct && otherCompanies.length > 0 && (
          <Card title="Transfer to another company">
            <ActionForm action={transferCompany.bind(null, cid, eid)} className="grid gap-3 sm:grid-cols-2" confirm="Transfer this employee? They exit here and join the other company.">
              <Field label="Company"><select className="input" name="target_company">{otherCompanies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Effective date"><input className="input" type="date" name="effective_date" required /></Field>
              <div className="sm:col-span-2"><SubmitButton className="btn-secondary">Transfer</SubmitButton></div>
            </ActionForm>
          </Card>
        )}
        <Card title="History" className="lg:col-span-2" pad={false}>
          <Table head={["Date", "Event", "Details"]}>
            {(events ?? []).map((ev) => <tr key={ev.id}><td className="td">{fmtDate(ev.effective_date)}</td><td className="td"><Badge value={ev.kind} /></td>
              <td className="td text-xs text-slate-500">{ev.details?.note ?? ""}</td></tr>)}
          </Table>
        </Card>
      </div>
    );
  }

  if (tab === "assets" && hr) {
    const { data: assets } = await supabase.from("assets").select("*").eq("employee_id", eid).order("issued_on", { ascending: false });
    body = (
      <div className="space-y-6">
        <Card title="Assets issued" pad={false}>
          <Table head={["Asset", "Serial no.", "Issued", "Returned", ""]} empty="No assets issued.">
            {(assets ?? []).map((a) => <tr key={a.id}><td className="td font-medium">{a.name}</td><td className="td font-mono text-xs">{a.serial_no ?? "—"}</td>
              <td className="td">{fmtDate(a.issued_on)}</td><td className="td">{a.returned_on ? fmtDate(a.returned_on) : <Badge value="active" text="With employee" />}</td>
              <td className="td text-right">{!a.returned_on && <form action={returnAsset.bind(null, cid, eid, a.id)}><button className="btn-secondary btn-sm">Mark returned</button></form>}</td></tr>)}
          </Table>
        </Card>
        <Card title="Issue an asset">
          <ActionForm action={issueAsset.bind(null, cid, eid)} className="grid gap-3 sm:grid-cols-4" resetOnSuccess>
            <Field label="Asset"><input className="input" name="name" placeholder="Laptop, ID card…" required /></Field>
            <Field label="Serial no."><input className="input" name="serial_no" /></Field>
            <Field label="Issued on"><input className="input" type="date" name="issued_on" /></Field>
            <div className="flex items-end"><SubmitButton>Record</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    );
  }

  if (tab === "onboarding" && hr) {
    const { data: items } = await supabase.from("onboarding_items").select("*").eq("employee_id", eid).order("item");
    body = (
      <Card title="Onboarding checklist">
        <ul className="space-y-2">
          {(items ?? []).map((i) => (
            <li key={i.id}>
              <form action={toggleChecklist.bind(null, cid, eid, i.id, !i.done)}>
                <button className="flex items-center gap-3 text-sm">
                  <span className={`inline-flex h-5 w-5 items-center justify-center rounded border ${i.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300"}`}>{i.done ? "✓" : ""}</span>
                  <span className={i.done ? "text-slate-400 line-through" : ""}>{i.item}</span>
                </button>
              </form>
            </li>
          ))}
        </ul>
      </Card>
    );
  }

  return (
    <>
      <PageHeader
        title={fullName(e)}
        subtitle={<span className="flex flex-wrap items-center gap-2">{e.emp_code} · {dir?.designation ?? "—"} · {dir?.department ?? "—"} · {dir?.branch ?? "—"} <Badge value={e.status} /></span>}
        actions={acct && !e.user_id && (
          <ActionForm action={inviteEmployee.bind(null, cid, eid)} className="flex items-center gap-2">
            <SubmitButton className="btn-secondary">{e.invited_at ? "Resend invite" : "Send invite"}</SubmitButton>
          </ActionForm>
        )}
      />
      <div className="mb-4 flex items-center gap-3"><Avatar name={fullName(e)} url={e.photo_url} size={48} />
        <div className="text-sm text-slate-600">{e.email}{e.phone ? ` · ${e.phone}` : ""}<br />Joined {fmtDate(e.date_of_joining)}{e.user_id ? " · App access active" : e.invited_at ? ` · Invited ${fmtDate(e.invited_at)}` : " · Not invited yet"}</div>
      </div>
      <Tabs tabs={tabs} active={tab} />
      {body}
    </>
  );
}
