import { getCtx, requirePerm } from "@/lib/context";
import { Card, PageHeader, Table } from "@/components/ui";
import { ReportFilterBar } from "@/components/report-filter-bar";
import { PAYROLL_REPORTS, payrollReport, payrollReportKind } from "@/lib/payroll-report";
import { monthFilters } from "@/lib/report-filters";
import { PayrollTabs } from "../tabs";

export const metadata = { title: "Payroll reports" };

// X-03 payroll reports over a month range, by branch and department, from locked payroll runs. Government and
// bank files (PF ECR, ESI, PT, NEFT) stay whole-company, in each payroll run.
export default async function PayrollReports({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const f = monthFilters((k) => sp[k]);
  const kind = payrollReportKind(sp.type);
  const [t, { data: branches }, { data: departments }] = await Promise.all([
    payrollReport(ctx.supabase, cid, f, kind),
    ctx.supabase.from("branches").select("id, name").eq("company_id", cid).order("name"),
    ctx.supabase.from("departments").select("id, name").eq("company_id", cid).eq("active", true).order("name"),
  ]);
  return (
    <>
      <PageHeader title="Payroll reports" subtitle={t.title} />
      <PayrollTabs cid={cid} active="reports" />
      <div className="space-y-4">
        <ReportFilterBar f={f} unit="month" branches={branches ?? []} departments={departments ?? []}
          kind={{ name: "type", value: kind, options: PAYROLL_REPORTS }}
          download={{ href: "/api/export/payroll-report", extra: { company: cid, type: kind } }} />
        <Card pad={false}>
          <Table head={t.columns} empty={t.empty}>
            {t.rows.map((r, i) => <tr key={i}>{r.map((v, j) => (
              <td key={j} className={`td whitespace-nowrap ${typeof v === "number" ? "text-right tabular-nums" : ""} ${t.columns[j] === "Employee" ? "font-medium" : ""}`}>
                {typeof v === "number" ? v.toLocaleString("en-IN") : v === "" ? "—" : v}</td>))}</tr>)}
          </Table>
          <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">Only locked (final) payroll is included. PF ECR, ESI, PT and the bank file are whole-company files: download them from each payroll run.</p>
        </Card>
      </div>
    </>
  );
}
