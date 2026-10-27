import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fmtDate, fmtTime, minutesToHm } from "@/lib/format";
import { allRows, daysBetween, inFilter, type ReportFilters } from "@/lib/report-filters";

// ATT-16 / ATT-34 attendance reports with the X-03 filters. The page and the Excel / CSV / PDF downloads
// are built from this one table, so they always match. Reads run as the signed-in user (RLS: a Manager
// only gets their team's attendance).

export type Cell = string | number;
export type ReportTable = { title: string; columns: string[]; rows: Cell[][]; empty: string; legend?: string };

export const ATTENDANCE_VIEWS = { summary: "Monthly summary", muster: "Muster roll", late: "Late-comers", overtime: "Overtime", wfh: "Work from home" } as const;
export type AttendanceView = keyof typeof ATTENDANCE_VIEWS;
export const attendanceView = (v: string | null | undefined): AttendanceView => (v && v in ATTENDANCE_VIEWS ? v as AttendanceView : "summary");

export const MUSTER_CODE: Record<string, string> = { present: "P", late: "L", early_out: "E", half_day: "H", absent: "A", missed_punch: "M", on_leave: "LV", holiday: "HO", weekly_off: "WO", on_duty: "OD", wfh: "WH" };
export const MUSTER_LEGEND = "P present · L late · E early out · H half-day · A absent · M missed punch · LV leave · HO holiday · WO weekly off · OD on duty · WH work from home";

type Person = { id: string; full_name: string; emp_code: string; department: string | null; branch: string | null; branch_id: string | null; department_id: string | null };
type Day = { employee_id: string; date: string; status: string; late: boolean; late_minutes: number; first_in: string | null; worked_minutes: number; ot_minutes: number; ot_approved_minutes: number };

const PRESENT = ["present", "late", "early_out", "on_duty", "wfh"];

export async function attendanceReport(supabase: SupabaseClient, cid: string, f: ReportFilters, view: AttendanceView): Promise<ReportTable> {
  const [people, days, wfhDays, autoClosed] = await Promise.all([
    allRows<Person>((a, b) => supabase.from("employee_directory").select("id, full_name, emp_code, department, branch, branch_id, department_id")
      .eq("company_id", cid).order("first_name").order("id").range(a, b)),
    allRows<Day>((a, b) => supabase.from("daily_attendance").select("employee_id, date, status, late, late_minutes, first_in, worked_minutes, ot_minutes, ot_approved_minutes")
      .eq("company_id", cid).gte("date", f.from).lte("date", f.to).order("date").order("employee_id").range(a, b)),
    view === "wfh" ? allRows<{ employee_id: string; date: string }>((a, b) => supabase.from("wfh_days").select("employee_id, date")
      .eq("company_id", cid).eq("status", "approved").gte("date", f.from).lte("date", f.to).order("date").order("employee_id").range(a, b)) : [],
    view === "wfh" ? allRows<{ employee_id: string; date: string }>((a, b) => supabase.from("work_sessions").select("employee_id, date")
      .eq("company_id", cid).eq("end_reason", "auto").gte("date", f.from).lte("date", f.to).order("date").order("employee_id").range(a, b)) : [],
  ]);
  const chosen = people.filter((p) => inFilter(p, f));
  const who = new Map(chosen.map((p) => [p.id, p]));
  const att = days.filter((d) => who.has(d.employee_id));
  const by = new Map<string, Day[]>();
  for (const a of att) by.set(a.employee_id, [...(by.get(a.employee_id) ?? []), a]);
  const withData = chosen.filter((p) => by.has(p.id));
  const title = `${ATTENDANCE_VIEWS[view]} · ${fmtDate(f.from)} to ${fmtDate(f.to)}`;

  if (view === "muster") {
    const dates = daysBetween(f.from, f.to);
    const oneMonth = f.from.slice(0, 7) === f.to.slice(0, 7);
    return {
      title, legend: MUSTER_LEGEND, empty: "No attendance for these filters.",
      columns: ["Code", "Employee", "Department", ...dates.map((d) => oneMonth ? String(Number(d.slice(8))) : `${Number(d.slice(8))}/${Number(d.slice(5, 7))}`)],
      rows: withData.map((p) => {
        const m = new Map(by.get(p.id)!.map((a) => [a.date, MUSTER_CODE[a.status] ?? "?"]));
        return [p.emp_code, p.full_name, p.department ?? "", ...dates.map((d) => m.get(d) ?? "")];
      }),
    };
  }
  if (view === "late") {
    return {
      title, empty: "No late marks for these filters.",
      columns: ["Date", "Code", "Employee", "Department", "Branch", "First in", "Late by (min)", "Status"],
      rows: att.filter((a) => a.late).map((a) => { const p = who.get(a.employee_id)!; return [fmtDate(a.date), p.emp_code, p.full_name, p.department ?? "", p.branch ?? "",
        fmtTime(a.first_in), a.late_minutes, a.status === "half_day" ? "Half-day (late rule)" : "Late"]; }),
    };
  }
  if (view === "overtime") {
    return {
      title, empty: "No overtime for these filters.",
      columns: ["Date", "Code", "Employee", "Department", "Branch", "Worked", "Overtime", "Approved"],
      rows: att.filter((a) => a.ot_minutes > 0).map((a) => { const p = who.get(a.employee_id)!; return [fmtDate(a.date), p.emp_code, p.full_name, p.department ?? "", p.branch ?? "",
        minutesToHm(a.worked_minutes), minutesToHm(a.ot_minutes), minutesToHm(a.ot_approved_minutes)]; }),
    };
  }
  if (view === "wfh") {
    // ATT-34: days worked from home, average worked hours, late check-ins, days closed by auto-checkout
    const attBy = new Map(att.map((a) => [`${a.employee_id}|${a.date}`, a]));
    const per = new Map<string, { days: number; minutes: number; late: number; auto: number }>();
    for (const d of wfhDays) {
      if (!who.has(d.employee_id)) continue;
      const r = per.get(d.employee_id) ?? { days: 0, minutes: 0, late: 0, auto: 0 };
      const a = attBy.get(`${d.employee_id}|${d.date}`);
      r.days++; r.minutes += a?.worked_minutes ?? 0; if (a?.late) r.late++;
      per.set(d.employee_id, r);
    }
    for (const s of autoClosed) { const r = per.get(s.employee_id); if (r) r.auto++; }
    return {
      title, empty: "Nobody worked from home for these filters.",
      columns: ["Code", "Employee", "Department", "Branch", "Days from home", "Average worked", "Late check-ins", "Closed automatically"],
      rows: [...per.entries()].map(([id, r]) => { const p = who.get(id)!; return [p.emp_code, p.full_name, p.department ?? "", p.branch ?? "",
        r.days, minutesToHm(Math.round(r.minutes / Math.max(1, r.days))), r.late, r.auto]; }),
    };
  }
  return {
    title, empty: "No attendance for these filters.",
    columns: ["Code", "Employee", "Department", "Branch", "Present", "Half days", "Absent", "Leave", "Late marks", "Hours worked", "OT", "OT approved"],
    rows: withData.map((p) => {
      const a = by.get(p.id)!;
      const c = (s: string[]) => a.filter((x) => s.includes(x.status)).length;
      return [p.emp_code, p.full_name, p.department ?? "", p.branch ?? "", c(PRESENT), c(["half_day"]), c(["absent", "missed_punch"]), c(["on_leave"]),
        a.filter((x) => x.late).length, minutesToHm(a.reduce((s, x) => s + x.worked_minutes, 0)),
        minutesToHm(a.reduce((s, x) => s + x.ot_minutes, 0)), minutesToHm(a.reduce((s, x) => s + x.ot_approved_minutes, 0))];
    }),
  };
}
