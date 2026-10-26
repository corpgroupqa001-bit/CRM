import { getCtx, requirePerm } from "@/lib/context";
import { Card, PageHeader } from "@/components/ui";
import { IMPORT_COLUMNS } from "@/lib/employees";
import { ImportForm } from "./import-form";

export const metadata = { title: "Import employees" };

export default async function ImportPage({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  requirePerm(await getCtx(cid), "employees.create");
  return (
    <>
      <PageHeader title="Bulk import employees" subtitle="Upload an Excel or CSV file. Every row is validated before anything is saved."
        actions={<a className="btn-secondary" href={`/api/export/employee-template?company=${cid}`}>Download template</a>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Upload" className="lg:col-span-2"><ImportForm cid={cid} /></Card>
        <Card title="Columns">
          <ul className="space-y-1 font-mono text-xs text-slate-600">{IMPORT_COLUMNS.map((c) => <li key={c}>{c}</li>)}</ul>
          <p className="mt-3 text-xs text-slate-500">Required: first_name, email, date_of_joining (YYYY-MM-DD). Department, designation and branch must match names in Settings. employment_type: full_time, contract or intern.</p>
        </Card>
      </div>
    </>
  );
}
