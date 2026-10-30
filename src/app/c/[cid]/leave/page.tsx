import { redirect } from "next/navigation";
import { leaveEnabled } from "@/lib/rbac";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table, Tabs } from "@/components/ui";
import { fmtDate, label, todayIST } from "@/lib/format";
import { fullName } from "@/lib/employees";
import { applyLeave, bulkLeave, carryForward, saveLeaveType, setLeaveStatus, setOpening } from "./actions";

export const metadata = { title: "Leave" };

type Emp = { first_name: string; last_name: string | null; emp_code: string };

export default async function Leave({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { cid } = await params;
  const { tab = "mine" } = await searchParams;
  const ctx = await getCtx(cid);
  // Leave Management is outside Phase 1 (enabled only through platform_features)
  if (!leaveEnabled(ctx.perms)) redirect(`/c/${cid}/denied`);
  const { supabase, perms, employee } = ctx;
  const approver = perms.has("attendance.approve");
  const year = Number(todayIST().slice(0, 4));
  const base = `/c/${cid}/leave`;
  const tabs = [
    { key: "mine", label: "My leave", href: base },
    ...(approver ? [{ key: "approvals", label: "Approvals", href: `${base}?tab=approvals` }] : []),
    ...(perms.has("leave.manage") ? [{ key: "types", label: "Leave types & balances", href: `${base}?tab=types` }] : []),
  ];
  let body: React.ReactNode = null;

  if (tab === "mine") {
    if (!employee) body = <p className="text-sm text-slate-500">You don&apos;t have an employee record in this company.</p>;
    else {
      const [{ data: types }, { data: bal }, { data: reqs }] = await Promise.all([
        supabase.from("leave_types").select("id, code, name, paid").eq("company_id", cid).eq("active", true).order("code"),
        supabase.from("leave_balance_view").select("*").eq("employee_id", employee.id).eq("year", year),
        supabase.from("leave_requests").select("*, leave_types(code, name)").eq("employee_id", employee.id).order("from_date", { ascending: false }).limit(30),
      ]);
      const avail = (b: { opening: number; accrued: number; used: number; pending: number }) => Number(b.opening) + Number(b.accrued) - Number(b.used) - Number(b.pending);
      body = (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              {(bal ?? []).filter((b) => b.paid).map((b) => (
                <div key={b.leave_type_id} className="card p-4">
                  <div className="text-xs font-medium uppercase text-slate-500">{b.name}</div>
                  <div className="mt-1 text-2xl font-semibold">{avail(b)}</div>
                  <div className="text-xs text-slate-500">{Number(b.used)} used · {Number(b.pending)} pending</div>
                </div>
              ))}
            </div>
            <Card title="My requests" pad={false}>
              <Table head={["Type", "Dates", "Days", "Reason", "Status", ""]}>
                {(reqs ?? []).map((r) => (
                  <tr key={r.id}>
                    <td className="td">{(r.leave_types as { code: string }).code}</td>
                    <td className="td whitespace-nowrap">{fmtDate(r.from_date)}{r.to_date !== r.from_date && ` – ${fmtDate(r.to_date)}`}{r.half_day && " (half)"}</td>
                    <td className="td">{Number(r.days)}</td><td className="td max-w-xs truncate">{r.reason}</td><td className="td"><Badge value={r.status} /></td>
                    <td className="td text-right">{["pending", "approved"].includes(r.status) && r.from_date >= todayIST() && (
                      <form action={setLeaveStatus.bind(null, cid, r.id, "cancelled")}><button className="text-sm text-slate-500 hover:underline">Cancel</button></form>)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
          <Card title="Apply for leave">
            <ActionForm action={applyLeave.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <Field label="Leave type"><select className="input" name="leave_type_id" required>
                {(types ?? []).map((t) => {
                  const b = (bal ?? []).find((x) => x.leave_type_id === t.id);
                  return <option key={t.id} value={t.id}>{t.name}{t.paid && b ? ` — ${avail(b)} available` : ""}</option>;
                })}</select></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="From"><input className="input" type="date" name="from_date" required /></Field>
                <Field label="To"><input className="input" type="date" name="to_date" /></Field>
              </div>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="half_day" /> Half day (uses the From date)</label>
              <Field label="Reason"><textarea className="input" name="reason" rows={2} /></Field>
              <SubmitButton className="btn-primary w-full">Apply</SubmitButton>
              <p className="text-xs text-slate-500">Weekly offs and holidays inside the range are not counted.</p>
            </ActionForm>
          </Card>
        </div>
      );
    }
  }

  if (tab === "approvals" && approver) {
    const { data: reqs } = await supabase.from("leave_requests").select("*, leave_types(code), employees(first_name, last_name, emp_code)")
      .eq("company_id", cid).neq("employee_id", employee?.id ?? "").order("created_at", { ascending: false }).limit(100);
    const pending = (reqs ?? []).filter((r) => r.status === "pending").length;
    body = (
      <Card pad={false} title="Team requests" actions={pending > 0 && (
        <ActionForm id="bulk-leave" action={bulkLeave.bind(null, cid)} className="flex items-center gap-2" confirm="Apply this decision to all selected requests?">
          <span className="text-xs text-slate-500">Selected:</span>
          <select name="decision" className="input h-8 w-32 text-xs"><option value="approved">Approve</option><option value="rejected">Reject</option></select>
          <SubmitButton className="btn-primary btn-sm">Apply</SubmitButton>
        </ActionForm>
      )}>
        <Table head={["", "Employee", "Type", "Dates", "Days", "Reason", "Status", ""]} empty="No leave requests from your team.">
          {(reqs ?? []).map((r) => (
            <tr key={r.id}>
              <td className="td w-8">{r.status === "pending" && <input type="checkbox" name="ids" value={r.id} form="bulk-leave" aria-label="Select request" />}</td>
              <td className="td">{fullName(r.employees as Emp)}</td><td className="td">{(r.leave_types as { code: string }).code}</td>
              <td className="td whitespace-nowrap">{fmtDate(r.from_date)}{r.to_date !== r.from_date && ` – ${fmtDate(r.to_date)}`}</td>
              <td className="td">{Number(r.days)}</td><td className="td max-w-xs">{r.reason}</td><td className="td"><Badge value={r.status} /></td>
              <td className="td">{r.status === "pending" && <span className="flex justify-end gap-2">
                <form action={setLeaveStatus.bind(null, cid, r.id, "approved")}><button className="btn-primary btn-sm">Approve</button></form>
                <form action={setLeaveStatus.bind(null, cid, r.id, "rejected")}><button className="btn-secondary btn-sm">Reject</button></form></span>}</td>
            </tr>
          ))}
        </Table>
      </Card>
    );
  }

  if (tab === "types" && perms.has("leave.manage")) {
    const [{ data: types }, { data: people }] = await Promise.all([
      supabase.from("leave_types").select("*").eq("company_id", cid).order("code"),
      supabase.from("employee_directory").select("id, full_name, emp_code").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    ]);
    const typeForm = (t?: Record<string, string | number | boolean>) => (
      <ActionForm action={saveLeaveType.bind(null, cid)} className="grid gap-3 sm:grid-cols-4" resetOnSuccess={!t}>
        {t && <input type="hidden" name="id" value={String(t.id)} />}
        <Field label="Code"><input className="input" name="code" defaultValue={String(t?.code ?? "")} required /></Field>
        <Field label="Name"><input className="input" name="name" defaultValue={String(t?.name ?? "")} required /></Field>
        <Field label="Days per year"><input className="input" type="number" step="0.5" name="annual_quota" defaultValue={Number(t?.annual_quota ?? 0)} /></Field>
        <Field label="Accrual"><select className="input" name="accrual" defaultValue={String(t?.accrual ?? "yearly")}>
          <option value="yearly">Credited at year start</option><option value="monthly">Monthly (1/12 each month)</option><option value="none">None</option></select></Field>
        <Field label="Carry forward up to"><input className="input" type="number" step="0.5" name="carry_forward_max" defaultValue={Number(t?.carry_forward_max ?? 0)} /></Field>
        <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="paid" defaultChecked={t ? !!t.paid : true} /> Paid</label>
        <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="encashable" defaultChecked={!!t?.encashable} /> Encashable</label>
        <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="allow_negative" defaultChecked={!!t?.allow_negative} /> Allow negative</label>
        <div className="sm:col-span-4"><SubmitButton className={t ? "btn-secondary" : "btn-primary"}>{t ? "Save" : "Add leave type"}</SubmitButton></div>
      </ActionForm>
    );
    body = (
      <div className="space-y-6">
        <Card title="Leave types" pad={false}>
          <Table head={["Code", "Name", "Paid", "Per year", "Accrual", "Carry fwd", "Encash", ""]}>
            {(types ?? []).map((t) => (
              <tr key={t.id}><td className="td font-mono">{t.code}</td><td className="td">{t.name}</td><td className="td">{t.paid ? "Yes" : "LOP"}</td>
                <td className="td">{Number(t.annual_quota)}</td><td className="td">{label(t.accrual)}</td><td className="td">{Number(t.carry_forward_max)}</td>
                <td className="td">{t.encashable ? "Yes" : "—"}</td>
                <td className="td"><details><summary className="cursor-pointer text-sm text-brand-600">Edit</summary><div className="mt-3 w-[40rem] max-w-[80vw]">{typeForm(t)}</div></details></td></tr>
            ))}
          </Table>
        </Card>
        <Card title="Add leave type">{typeForm()}</Card>
        <Card title="Year-end carry-forward" description="Moves each employee's unused balance into next year's opening balance, up to the type's carry-forward limit. Run it once after the year closes; running again recalculates.">
          <ActionForm action={carryForward.bind(null, cid)} className="flex flex-wrap items-end gap-3" confirm="Carry forward balances to next year?">
            <Field label="From year"><input className="input w-32" type="number" name="year" defaultValue={year} /></Field>
            <SubmitButton className="btn-secondary">Carry forward</SubmitButton>
          </ActionForm>
        </Card>
        <Card title="Opening balance (manual adjustment)">
          <ActionForm action={setOpening.bind(null, cid)} className="grid gap-3 sm:grid-cols-5">
            <Field label="Employee" className="sm:col-span-2"><select className="input" name="employee_id" required>{(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.emp_code})</option>)}</select></Field>
            <Field label="Leave type"><select className="input" name="leave_type_id">{(types ?? []).map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}</select></Field>
            <Field label="Year"><input className="input" type="number" name="year" defaultValue={year} /></Field>
            <Field label="Opening days"><input className="input" type="number" step="0.5" name="opening" required /></Field>
            <div className="sm:col-span-5"><SubmitButton>Save</SubmitButton></div>
          </ActionForm>
        </Card>
      </div>
    );
  }

  return (
    <>
      <PageHeader title="Leave" />
      <Tabs tabs={tabs} active={tab} />
      {body}
    </>
  );
}
