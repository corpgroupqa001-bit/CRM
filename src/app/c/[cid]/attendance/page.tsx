import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
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

  return (
    <>
      <PageHeader title="Attendance" subtitle={lock ? "This month is locked" : undefined} />
      <AttendanceTabs cid={cid} active="daily" perms={perms} />
      <Card pad={false} title={
        <form className="flex flex-wrap gap-2">
          <input type="date" name="date" defaultValue={date} className="input w-44" />
          <select name="department" defaultValue={sp.department ?? ""} className="input w-44"><option value="">All departments</option>{(deps ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="branch" defaultValue={sp.branch ?? ""} className="input w-40"><option value="">All branches</option>{(branches ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <button className="btn-secondary">Show</button>
        </form>
      } actions={hr && !lock && (
        <ActionForm action={recompute.bind(null, cid)} className="flex items-center gap-2">
          <input type="hidden" name="from" value={date} />
          <SubmitButton className="btn-ghost text-xs" pendingText="Recalculating…">Recalculate day</SubmitButton>
        </ActionForm>
      )}>
        <Table head={["Employee", "Department", "Status", "In", "Out", "Worked", "OT", ...(hr ? ["Override"] : [])]}>
          {visible.map((p) => {
            const a = byEmp.get(p.id);
            return (
              <tr key={p.id}>
                <td className="td"><Link href={`/c/${cid}/attendance/me?employee=${p.id}`} className="font-medium hover:underline">{p.full_name}</Link> <span className="text-xs text-slate-500">{p.emp_code}</span></td>
                <td className="td">{p.department ?? "—"}</td>
                <td className="td">{a ? <span className="flex items-center gap-1"><Badge value={a.status} />{a.source !== "auto" && <span className="text-[10px] uppercase text-slate-400">{a.source}</span>}{a.late_conversion && <span className="text-[10px] text-amber-600">3rd late</span>}</span> : <span className="text-xs text-slate-400">no data</span>}</td>
                <td className="td">{fmtTime(a?.first_in)}</td><td className="td">{fmtTime(a?.last_out)}</td>
                <td className="td">{a ? minutesToHm(a.worked_minutes) : "—"}</td>
                <td className="td">{a?.ot_minutes ? minutesToHm(a.ot_minutes) : "—"}</td>
                {hr && <td className="td">{!lock && (
                  <ActionForm action={overrideStatus.bind(null, cid)} className="flex items-center gap-1">
                    <input type="hidden" name="employee_id" value={p.id} /><input type="hidden" name="date" value={date} />
                    <select name="status" defaultValue="" className="input w-32 h-8 text-xs" required>
                      <option value="" disabled>Set…</option><option value="auto">Auto (from punches)</option>
                      {STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>
                    <input name="remarks" placeholder="Reason" className="input w-28 h-8 text-xs" required />
                    <SubmitButton className="btn-secondary btn-sm">Save</SubmitButton>
                  </ActionForm>)}</td>}
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
