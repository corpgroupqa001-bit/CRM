import { getCtx, requirePerm } from "@/lib/context";
import { Card, PageHeader, Table } from "@/components/ui";
import { minutesToHm, todayIST } from "@/lib/format";
import { AttendanceTabs } from "../tabs";
import { PrintButton } from "@/components/print-button";
import { fmtDate, fmtTime } from "@/lib/format";

export const metadata = { title: "Attendance reports" };

const SHORT: Record<string, string> = { present: "P", late: "L", early_out: "E", half_day: "H", absent: "A", missed_punch: "M", on_leave: "LV", holiday: "HO", weekly_off: "WO", on_duty: "OD", wfh: "WH" };
const COLOR: Record<string, string> = { P: "text-emerald-700", L: "text-amber-700", E: "text-amber-700", H: "text-orange-700", A: "text-rose-700", M: "text-rose-700", LV: "text-sky-700", HO: "text-violet-700", WO: "text-slate-400", OD: "text-teal-700", WH: "text-teal-700" };

// ATT-16: monthly summary and muster; Excel export of the same data
export default async function Reports({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ month?: string; view?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.read_all", "attendance.read_team");
  const month = sp.month ?? todayIST().slice(0, 7);
  const from = `${month}-01`;
  const days = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const to = `${month}-${String(days).padStart(2, "0")}`;
  const [{ data: people }, { data: att }] = await Promise.all([
    ctx.supabase.from("employee_directory").select("id, full_name, emp_code, department").eq("company_id", cid).order("first_name"),
    ctx.supabase.from("daily_attendance").select("employee_id, date, status, late, late_minutes, first_in, worked_minutes, ot_minutes, ot_approved_minutes").eq("company_id", cid).gte("date", from).lte("date", to),
  ]);
  const by = new Map<string, NonNullable<typeof att>>();
  for (const a of att ?? []) by.set(a.employee_id, [...(by.get(a.employee_id) ?? []), a]);
  const rows = (people ?? []).filter((p) => by.has(p.id));
  const muster = sp.view === "muster";
  const names = new Map((people ?? []).map((p) => [p.id, p]));
  const lateRows = (att ?? []).filter((a) => a.late).sort((a, b) => a.date.localeCompare(b.date));
  const otRows = (att ?? []).filter((a) => a.ot_minutes > 0).sort((a, b) => a.date.localeCompare(b.date));

  return (
    <>
      <PageHeader title="Attendance reports" actions={<>
        <form className="flex gap-2"><input type="month" name="month" defaultValue={month} className="input w-44" />
          <select name="view" defaultValue={sp.view ?? "summary"} className="input w-40"><option value="summary">Monthly summary</option><option value="muster">Muster roll</option><option value="late">Late-comers</option><option value="overtime">Overtime</option></select>
          <button className="btn-secondary">Show</button></form>
        <a className="btn-secondary" href={`/api/export/attendance?company=${cid}&month=${month}`}>Excel</a>
        <PrintButton />
      </>} />
      <AttendanceTabs cid={cid} active="reports" perms={ctx.perms} />
      <Card pad={false}>
        {sp.view === "late" ? (
          <Table head={["Date", "Employee", "Department", "First in", "Late by", "Status"]} empty="No late marks this month.">
            {lateRows.map((a) => { const p = names.get(a.employee_id); return (
              <tr key={`${a.employee_id}-${a.date}`}><td className="td">{fmtDate(a.date)}</td><td className="td font-medium">{p?.full_name}</td><td className="td">{p?.department ?? "—"}</td>
                <td className="td">{fmtTime(a.first_in)}</td><td className="td tabular-nums">{a.late_minutes} min</td><td className="td">{a.status === "half_day" ? "Half-day (late rule)" : "Late"}</td></tr>); })}
          </Table>
        ) : sp.view === "overtime" ? (
          <Table head={["Date", "Employee", "Department", "Worked", "Overtime", "Approved"]} empty="No overtime this month.">
            {otRows.map((a) => { const p = names.get(a.employee_id); return (
              <tr key={`${a.employee_id}-${a.date}`}><td className="td">{fmtDate(a.date)}</td><td className="td font-medium">{p?.full_name}</td><td className="td">{p?.department ?? "—"}</td>
                <td className="td tabular-nums">{minutesToHm(a.worked_minutes)}</td><td className="td tabular-nums">{minutesToHm(a.ot_minutes)}</td><td className="td tabular-nums">{minutesToHm(a.ot_approved_minutes)}</td></tr>); })}
          </Table>
        ) : muster ? (
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead><tr className="bg-slate-50"><th className="th sticky left-0 bg-slate-50">Employee</th>
                {Array.from({ length: days }, (_, i) => <th key={i} className="px-1 py-2 text-center font-medium text-slate-500">{i + 1}</th>)}</tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((p) => {
                  const m = new Map(by.get(p.id)!.map((a) => [Number(a.date.slice(8, 10)), SHORT[a.status] ?? "?"]));
                  return <tr key={p.id}><td className="td sticky left-0 whitespace-nowrap bg-white">{p.full_name}</td>
                    {Array.from({ length: days }, (_, i) => { const s = m.get(i + 1) ?? ""; return <td key={i} className={`px-1 py-2 text-center font-semibold ${COLOR[s] ?? ""}`}>{s}</td>; })}</tr>;
                })}
              </tbody>
            </table>
            <p className="px-4 py-3 text-xs text-slate-500">P present · L late · E early out · H half-day · A absent · M missed punch · LV leave · HO holiday · WO weekly off · OD on duty · WH work from home</p>
          </div>
        ) : (
          <Table head={["Employee", "Department", "Present", "Half days", "Absent", "Leave", "Late marks", "Hours worked", "OT (approved)"]}>
            {rows.map((p) => {
              const a = by.get(p.id)!;
              const c = (s: string[]) => a.filter((x) => s.includes(x.status)).length;
              return (
                <tr key={p.id}><td className="td font-medium">{p.full_name} <span className="text-xs text-slate-500">{p.emp_code}</span></td><td className="td">{p.department ?? "—"}</td>
                  <td className="td">{c(["present", "late", "early_out", "on_duty", "wfh"])}</td><td className="td">{c(["half_day"])}</td>
                  <td className="td">{c(["absent", "missed_punch"])}</td><td className="td">{c(["on_leave"])}</td><td className="td">{a.filter((x) => x.late).length}</td>
                  <td className="td">{minutesToHm(a.reduce((s, x) => s + x.worked_minutes, 0))}</td>
                  <td className="td">{minutesToHm(a.reduce((s, x) => s + x.ot_minutes, 0))} ({minutesToHm(a.reduce((s, x) => s + x.ot_approved_minutes, 0))})</td></tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
