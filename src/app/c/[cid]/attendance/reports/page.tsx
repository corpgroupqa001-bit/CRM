import { getCtx, requirePerm } from "@/lib/context";
import { Card, PageHeader, Table } from "@/components/ui";
import { AttendanceTabs } from "../tabs";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { ATTENDANCE_VIEWS, attendanceReport, attendanceView } from "@/lib/attendance-report";
import { dayFilters } from "@/lib/report-filters";

export const metadata = { title: "Attendance reports" };

const COLOR: Record<string, string> = { P: "text-emerald-700", L: "text-amber-700", E: "text-amber-700", H: "text-orange-700", A: "text-rose-700", M: "text-rose-700", LV: "text-sky-700", HO: "text-violet-700", WO: "text-slate-400", OD: "text-teal-700", WH: "text-teal-700" };

// ATT-16 / ATT-34 reports, filtered by branch, department and date range (X-03); Excel, CSV and PDF of the same table
export default async function Reports({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.read_all", "attendance.read_team");
  const f = dayFilters((k) => sp[k]);
  const view = attendanceView(sp.view);
  const [t, { data: branches }, { data: departments }] = await Promise.all([
    attendanceReport(ctx.supabase, cid, f, view),
    ctx.supabase.from("branches").select("id, name").eq("company_id", cid).order("name"),
    ctx.supabase.from("departments").select("id, name").eq("company_id", cid).eq("active", true).order("name"),
  ]);
  const muster = view === "muster";

  return (
    <>
      <PageHeader title="Attendance reports" subtitle={t.title} />
      <AttendanceTabs cid={cid} active="reports" perms={ctx.perms} />
      <div className="space-y-4">
        <ReportFilterBar f={f} unit="day" branches={branches ?? []} departments={departments ?? []}
          kind={{ name: "view", value: view, options: ATTENDANCE_VIEWS }}
          download={ctx.perms.has("attendance.read_all") ? { href: "/api/export/attendance", extra: { company: cid, view } } : undefined} />
        <Card pad={false}>
          {muster ? (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead><tr className="bg-slate-50">{t.columns.map((c, i) => (
                  <th key={c} className={i < 3 ? `th whitespace-nowrap ${i === 1 ? "sticky left-0 bg-slate-50" : ""}` : "px-1 py-2 text-center font-medium text-slate-500"}>{c}</th>))}</tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {t.rows.map((r) => (
                    <tr key={String(r[0])}>{r.map((v, i) => i < 3
                      ? <td key={i} className={`td whitespace-nowrap ${i === 1 ? "sticky left-0 bg-surface font-medium" : ""}`}>{v}</td>
                      : <td key={i} className={`px-1 py-2 text-center font-semibold ${COLOR[String(v)] ?? ""}`}>{v}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {!t.rows.length && <p className="px-4 py-6 text-center text-sm text-slate-500">{t.empty}</p>}
              <p className="px-4 py-3 text-xs text-slate-500">{t.legend}</p>
            </div>
          ) : (
            <Table head={t.columns} empty={t.empty}>
              {t.rows.map((r, i) => <tr key={i}>{r.map((v, j) => <td key={j} className={`td ${typeof v === "number" ? "tabular-nums" : ""} ${t.columns[j] === "Employee" ? "font-medium" : ""}`}>{v === "" ? "—" : v}</td>)}</tr>)}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
