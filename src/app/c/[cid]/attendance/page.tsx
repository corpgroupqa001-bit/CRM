import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { Sheet } from "@/components/sheet";
import { fmtTime, label, minutesToHm, todayIST } from "@/lib/format";
import { AttendanceTabs } from "./tabs";
import { overrideStatus, recompute } from "./actions";

export const metadata = { title: "Attendance" };

const STATUSES = ["present", "absent", "half_day", "late", "early_out", "on_duty", "wfh", "holiday", "weekly_off", "missed_punch"];

export default async function DailyAttendance({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ date?: string; department?: string; branch?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.read_all", "attendance.read_team");
  const { supabase, perms } = ctx;
  const date = sp.date ?? todayIST();
  const hr = perms.has("attendance.manage");

  let emps = supabase.from("employee_directory").select("id, full_name, emp_code, department, branch, department_id, branch_id")
    .eq("company_id", cid).in("status", ["active", "notice"]).order("first_name");
  if (sp.department) emps = emps.eq("department_id", sp.department);
  if (sp.branch) emps = emps.eq("branch_id", sp.branch);
  const [{ data: people }, { data: att }, { data: deps }, { data: branches }, { data: lock }] = await Promise.all([
    emps,
    supabase.from("daily_attendance").select("*").eq("company_id", cid).eq("date", date),
    supabase.from("departments").select("id, name").eq("company_id", cid),
    supabase.from("branches").select("id, name").eq("company_id", cid),
    supabase.from("attendance_locks").select("month").eq("company_id", cid).eq("month", date.slice(0, 7) + "-01").maybeSingle(),
  ]);
  const byEmp = new Map((att ?? []).map((a) => [a.employee_id, a]));
  // managers only see rows they can read (RLS); hide colleagues without visible attendance unless HR
  const visible = hr ? people ?? [] : (people ?? []).filter((p) => byEmp.has(p.id));

  const count = (st: string[]) => visible.filter((p) => st.includes(byEmp.get(p.id)?.status ?? "")).length;
  const summary = [
    { n: count(["present", "on_duty", "wfh"]), label: "present", cls: "bg-emerald-50 text-emerald-700" },
    { n: count(["late", "early_out", "half_day"]), label: "late / short", cls: "bg-amber-50 text-amber-800" },
    { n: count(["absent", "missed_punch"]), label: "absent", cls: "bg-rose-50 text-rose-700" },
  ];
  const dayLabel = new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
  const correct = (p: { id: string; full_name: string }, status?: string) => (
    <Sheet trigger="Correct" title="Correct attendance" description={`${p.full_name} · ${dayLabel}`}>
      <ActionForm action={overrideStatus.bind(null, cid)}>
        <input type="hidden" name="employee_id" value={p.id} /><input type="hidden" name="date" value={date} />
        {status && <div className="flex items-center gap-2 text-[13px] text-slate-600">Now <Badge value={status} /></div>}
        <Field label="New status">
          <select name="status" defaultValue="" className="input" required>
            <option value="" disabled>Choose…</option><option value="auto">Back to automatic (from punches)</option>
            {STATUSES.map((st) => <option key={st} value={st}>{label(st)}</option>)}</select>
        </Field>
        <Field label="Reason" hint="Required. Saved in the audit log and sent to the employee.">
          <textarea name="remarks" rows={3} className="input" placeholder="Why is this day being corrected?" required />
        </Field>
        <SubmitButton className="btn-primary w-full" pendingText="Saving…">Save correction</SubmitButton>
      </ActionForm>
    </Sheet>
  );

  return (
    <>
      <PageHeader title="Attendance" subtitle={lock ? "This month is locked" : undefined} />
      <AttendanceTabs cid={cid} active="daily" perms={perms} />
      <Card pad={false} title={
        <form className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <input type="date" name="date" defaultValue={date} className="input sm:w-44" aria-label="Date" />
          <select name="department" defaultValue={sp.department ?? ""} className="input sm:w-48" aria-label="Department"><option value="">All departments</option>{(deps ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="branch" defaultValue={sp.branch ?? ""} className="input sm:w-44" aria-label="Branch"><option value="">All branches</option>{(branches ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <button className="btn-secondary">Show</button>
        </form>
      } actions={
        <div className="flex flex-wrap items-center gap-2">
          {summary.map((x) => <span key={x.label} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${x.cls}`}>{x.n} {x.label}</span>)}
          {hr && !lock && (
            <ActionForm action={recompute.bind(null, cid)} className="flex items-center gap-2">
              <input type="hidden" name="from" value={date} />
              <SubmitButton className="btn-ghost btn-sm" pendingText="Recalculating…">Recalculate day</SubmitButton>
            </ActionForm>
          )}
        </div>
      }>
        <div className="hidden md:block">
          <Table head={["Employee", "Department", "Status", "In", "Out", "Worked", "OT", ...(hr && !lock ? [<span key="c" className="sr-only">Correction</span>] : [])]}>
            {visible.map((p) => {
              const a = byEmp.get(p.id);
              return (
                <tr key={p.id}>
                  <td className="td"><Link href={`/c/${cid}/attendance/me?employee=${p.id}`} className="font-medium text-slate-900 hover:underline">{p.full_name}</Link> <span className="text-xs text-slate-500">{p.emp_code}</span></td>
                  <td className="td">{p.department ?? "—"}</td>
                  <td className="td">{a ? <span className="flex items-center gap-1.5"><Badge value={a.status} />{a.source !== "auto" && <span className="text-[10px] font-medium uppercase text-slate-500">{a.source}</span>}{a.late_conversion && <span className="text-[10px] text-amber-700">3rd late</span>}</span> : <span className="text-xs text-slate-500">no data</span>}</td>
                  <td className="td tabular-nums">{fmtTime(a?.first_in)}</td><td className="td tabular-nums">{fmtTime(a?.last_out)}</td>
                  <td className="td tabular-nums">{a ? minutesToHm(a.worked_minutes) : "—"}</td>
                  <td className="td tabular-nums">{a?.ot_minutes ? minutesToHm(a.ot_minutes) : "—"}</td>
                  {hr && !lock && <td className="td text-right">{correct(p, a?.status)}</td>}
                </tr>
              );
            })}
          </Table>
        </div>
        <ul className="divide-y divide-slate-100 md:hidden">
          {visible.map((p) => {
            const a = byEmp.get(p.id);
            return (
              <li key={p.id} className="space-y-3 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/c/${cid}/attendance/me?employee=${p.id}`} className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{p.full_name}</span>
                    <span className="block text-xs text-slate-500">{p.emp_code}{p.department ? ` · ${p.department}` : ""}</span>
                  </Link>
                  {a ? <Badge value={a.status} /> : <span className="text-xs text-slate-500">no data</span>}
                </div>
                <dl className="grid grid-cols-3 gap-2 text-xs text-slate-500">
                  <div><dt>In</dt><dd className="text-sm font-semibold tabular-nums text-slate-900">{fmtTime(a?.first_in)}</dd></div>
                  <div><dt>Out</dt><dd className="text-sm font-semibold tabular-nums text-slate-900">{fmtTime(a?.last_out)}</dd></div>
                  <div><dt>Worked</dt><dd className="text-sm font-semibold tabular-nums text-slate-900">{a ? minutesToHm(a.worked_minutes) : "—"}</dd></div>
                </dl>
                {hr && !lock && <div className="[&>button]:w-full [&>button]:h-10">{correct(p, a?.status)}</div>}
              </li>
            );
          })}
          {!visible.length && <li className="px-4 py-12 text-center text-sm text-slate-500">Nothing here yet.</li>}
        </ul>
      </Card>
    </>
  );
}
