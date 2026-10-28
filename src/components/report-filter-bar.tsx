import { Download } from "lucide-react";
import { Card } from "@/components/ui";
import { filterQuery, type ReportFilters } from "@/lib/report-filters";

type Option = { id: string; name: string };

/**
 * X-03 filter bar: report, branch, department and a date (or month) range, sent as a plain GET form so the
 * filters live in the URL. Downloads carry the same filters, so the file matches the screen.
 */
export function ReportFilterBar({ f, unit, kind, branches, departments, download }: {
  f: ReportFilters; unit: "day" | "month";
  kind: { name: string; value: string; options: Record<string, string> };
  branches: Option[]; departments: Option[];
  download?: { href: string; extra: Record<string, string> };
}) {
  const type = unit === "day" ? "date" : "month";
  return (
    <Card className="no-print">
      <form className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <label className="block lg:col-span-2"><span className="label">Report</span>
          <select name={kind.name} defaultValue={kind.value} className="input">
            {Object.entries(kind.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
        <label className="block"><span className="label">Branch</span>
          <select name="branch" defaultValue={f.branch ?? ""} className="input"><option value="">All branches</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label className="block"><span className="label">Department</span>
          <select name="department" defaultValue={f.department ?? ""} className="input"><option value="">All departments</option>
            {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
        <label className="block"><span className="label">From</span><input type={type} name="from" defaultValue={f.from} className="input" required /></label>
        <label className="block"><span className="label">To</span><input type={type} name="to" defaultValue={f.to} className="input" required /></label>
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2 lg:col-span-6">
          <button className="btn-primary">Show</button>
          {download && (["xlsx", "csv", "pdf"] as const).map((fmt) => (
            <a key={fmt} className="btn-secondary" href={`${download.href}?${filterQuery(f, { ...download.extra, format: fmt })}`}>
              <Download className="h-4 w-4" /> {fmt === "xlsx" ? "Excel" : fmt.toUpperCase()}</a>
          ))}
          <span className="text-xs text-slate-500">Downloads match the report below (click Show after changing filters). Branch and department are each person&apos;s current ones.</span>
        </div>
      </form>
    </Card>
  );
}
