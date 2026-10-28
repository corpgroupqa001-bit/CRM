import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDateTime, fmtMonth, money, todayIST } from "@/lib/format";
import { PayrollTabs, ViewOnlyNote } from "./tabs";
import { precheck, runPayroll } from "./actions";

export const metadata = { title: "Payroll" };

export default async function Payroll({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ month?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const canManage = ctx.perms.has("salaries.manage");   // HR: view only (approved BRD matrix)
  const today = todayIST();
  const prev = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1);
  const month = sp.month ?? `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, "0")}`;
  const [{ data: runs }, checks, { data: failures }] = await Promise.all([
    ctx.supabase.from("payroll_runs").select("*").eq("company_id", cid).order("month", { ascending: false }).order("version", { ascending: false }).limit(60),
    precheck(cid, `${month}-01`),
    // NFR-12: payroll runs that failed (nothing was saved), last 30 days
    ctx.supabase.from("system_failures").select("source, detail, at").eq("company_id", cid).eq("kind", "payroll")
      .gte("at", new Date(Date.now() - 30 * 864e5).toISOString()).order("at", { ascending: false }).limit(10),
  ]);
  const errors = checks.filter((c) => c.level === "error");

  return (
    <>
      <PageHeader title="Payroll" subtitle="Monthly payroll from locked attendance: run → review → approve → payslips and bank file."
        actions={<a className="btn-secondary" href={`/api/export/form16?company=${cid}&fy=${Number(today.slice(5, 7)) >= ctx.company.fy_start_month ? today.slice(0, 4) : Number(today.slice(0, 4)) - 1}`}>Form 16 Part B (this FY)</a>} />
      <PayrollTabs cid={cid} active="runs" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title={canManage ? "Run payroll" : "Pre-run checks"} className="lg:col-span-1">
          <form className="mb-4 flex items-end gap-2">
            <Field label="Month" className="flex-1"><input type="month" name="month" defaultValue={month} className="input" /></Field>
            <button className="btn-secondary">Check</button>
          </form>
          <div className="mb-4 space-y-1.5">
            <div className="text-xs font-semibold uppercase text-slate-500">Pre-run checks · {fmtMonth(`${month}-01`)}</div>
            {checks.length === 0 && <p className="text-sm text-emerald-700">✓ All checks passed.</p>}
            {checks.map((c, i) => (
              <p key={i} className={`rounded px-2 py-1 text-xs ${c.level === "error" ? "bg-rose-50 text-rose-700" : "bg-amber-50 text-amber-800"}`}>
                {c.level === "error" ? "✕" : "!"} {c.message}
                {c.code === "attendance_unlocked" && <> — <Link href={`/c/${cid}/attendance/lock`} className="underline">lock it</Link></>}
                {c.code === "missing_ctc" && <> — <Link href={`/c/${cid}/payroll/salaries`} className="underline">assign</Link></>}
                {c.code === "unmapped_punches" && <> — <Link href={`/c/${cid}/attendance/devices`} className="underline">map</Link></>}
              </p>
            ))}
          </div>
          {canManage ? (
            <ActionForm action={runPayroll.bind(null, cid)}>
              <input type="hidden" name="month" value={month} />
              <SubmitButton className="btn-primary w-full" disabled={errors.some((e) => e.code === "attendance_unlocked")} pendingText="Calculating…">
                Run payroll for {fmtMonth(`${month}-01`)}
              </SubmitButton>
            </ActionForm>
          ) : <ViewOnlyNote />}
        </Card>
        <Card title="Runs" pad={false} className="lg:col-span-2">
          <Table head={["Month", "Version", "Status", "Employees", "Gross", "Net pay", "Run at"]} empty="No payroll runs yet.">
            {(runs ?? []).map((r) => (
              <tr key={r.id} className={r.status === "superseded" ? "opacity-50" : ""}>
                <td className="td"><Link href={`/c/${cid}/payroll/${r.id}`} className="font-medium text-brand-700 hover:underline">{fmtMonth(r.month)}</Link></td>
                <td className="td">v{r.version}</td><td className="td"><Badge value={r.status} /></td><td className="td">{r.employee_count}</td>
                <td className="td">{money(r.total_gross)}</td><td className="td font-medium">{money(r.total_net)}</td><td className="td">{fmtDateTime(r.ran_at)}</td>
              </tr>
            ))}
          </Table>
        </Card>
        {!!failures?.length && (
          <Card title="Failed payroll runs (last 30 days)" description="Nothing was saved for these. HR, the Company Admin and the Owner were alerted." pad={false} className="lg:col-span-3">
            <Table head={["When", "Month", "Reason"]}>
              {failures.map((f, i) => <tr key={i}><td className="td whitespace-nowrap">{fmtDateTime(f.at)}</td><td className="td font-medium">{f.source}</td><td className="td text-sm text-rose-700">{f.detail}</td></tr>)}
            </Table>
          </Card>
        )}
      </div>
    </>
  );
}
