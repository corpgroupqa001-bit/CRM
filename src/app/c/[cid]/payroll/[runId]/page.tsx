import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx, requirePerm } from "@/lib/context";
import { PrintButton } from "@/components/print-button";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDateTime, fmtMonth, money, num } from "@/lib/format";
import { directory, fullName } from "@/lib/employees";
import { approveRun, emailPayslips, reopenRun, setHold, setPaymentStatus } from "../actions";
import { ViewOnlyNote } from "../tabs";

export const metadata = { title: "Payroll run" };

type Emp = { first_name: string; last_name: string | null; emp_code: string };

export default async function Run({ params }: { params: Promise<{ cid: string; runId: string }> }) {
  const { cid, runId } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const { supabase, perms, user, role } = ctx;
  const { data: run } = await supabase.from("payroll_runs").select("*").eq("id", runId).eq("company_id", cid).maybeSingle();
  if (!run) notFound();
  const [{ data: rawSlips }, dir] = await Promise.all([supabase.from("payslips").select("*").eq("run_id", runId), directory(supabase, cid)]);
  const slips = (rawSlips ?? []).map((p) => ({ ...p, employees: dir.get(p.employee_id) ?? { first_name: "—", last_name: null, emp_code: "" } }));
  const rows = (slips ?? []).sort((a, b) => (a.employees as Emp).emp_code.localeCompare((b.employees as Emp).emp_code));
  // Administrator or Finance approve, but never the person who ran this version (maker-checker);
  // reopening a finalized run is for the owner / company administrator only
  const canApprove = perms.has("salaries.approve");
  const canManage = perms.has("salaries.manage");     // HR: view only (approved BRD matrix)
  const ranIt = run.ran_by === user.id;
  const canReopen = role === "owner" || role === "company_admin";
  const dl = (report: string) => `/api/export/${report}?company=${cid}&run=${runId}`;
  const errors = (run.warnings as { level: string; message: string }[]).filter((w) => w.level === "error");

  return (
    <>
      <PageHeader title={`Payroll · ${fmtMonth(run.month)}`}
        subtitle={<span className="flex items-center gap-2">Version {run.version} · run {fmtDateTime(run.ran_at)} <Badge value={run.status} /></span>}
        actions={<><PrintButton /><Link href={`/c/${cid}/payroll`} className="btn-ghost">← All runs</Link></>} />
      <div className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
        <Stat label="Employees" value={run.employee_count} />
        <Stat label="Gross" value={money(run.total_gross)} />
        <Stat label="Deductions" value={money(run.total_deductions)} />
        <Stat label="Net payout" value={money(run.total_net)} tone="brand" />
      </div>

      {(run.warnings as { level: string; message: string }[]).length > 0 && (
        <Card title="Warnings" className="mb-6">
          <ul className="space-y-1 text-sm">{(run.warnings as { level: string; message: string }[]).map((w, i) =>
            <li key={i} className={w.level === "error" ? "text-rose-700" : "text-amber-700"}>{w.level === "error" ? "✕" : "!"} {w.message}</li>)}</ul>
        </Card>
      )}
      {(run.changes as unknown[]).length > 0 && (
        <Card title="Changes from the previous version" className="mb-6">
          <ul className="space-y-1 text-sm">{(run.changes as { employee_id: string; old_net: number; new_net: number }[]).map((c) => {
            const e = rows.find((r) => r.employee_id === c.employee_id)?.employees as Emp | undefined;
            return <li key={c.employee_id}>{e ? fullName(e) : c.employee_id}: {money(c.old_net)} → {money(c.new_net)}</li>;
          })}</ul>
        </Card>
      )}

      <div className="mb-6 grid gap-4 lg:grid-cols-3">
        <Card title="Approve">
          {run.status === "draft" ? (canApprove && !ranIt ? (
            <ActionForm action={approveRun.bind(null, cid, runId)} confirm="Approve and lock this payroll? Loan EMIs and recoveries will be applied.">
              <SubmitButton className="btn-primary w-full" disabled={errors.length > 0}>Approve & lock</SubmitButton>
              {errors.length > 0 && <p className="text-xs text-rose-600">Fix the errors and run again before approving.</p>}
            </ActionForm>
          ) : <p className="text-sm text-slate-600">{canApprove && ranIt
                ? "You ran this payroll, so another Administrator or Finance user must approve it."
                : "Waiting for an Administrator or Finance / Payroll to approve."}</p>)
            : run.status === "locked" ? <p className="text-sm text-emerald-700">Approved {fmtDateTime(run.approved_at)}. Finalized and read-only.</p>
            : <p className="text-sm text-slate-500">{run.status === "reopened" ? `Reopened: ${run.reopen_reason}` : "Superseded by a newer run."}</p>}
        </Card>
        <Card title="Downloads">
          <div className="flex flex-wrap gap-2 text-sm">
            <a className="btn-secondary btn-sm" href={dl("salary-register")}>Salary register</a>
            <a className="btn-secondary btn-sm" href={dl("bank-file")}>Bank NEFT file</a>
            <a className="btn-secondary btn-sm" href={dl("pf-ecr")}>PF ECR</a>
            <a className="btn-secondary btn-sm" href={dl("esi")}>ESI</a>
            <a className="btn-secondary btn-sm" href={dl("pt")}>PT</a>
            <a className="btn-secondary btn-sm" href={dl("tds")}>TDS summary</a>
            <a className="btn-secondary btn-sm" href={dl("ctc-vs-actual")}>CTC vs actual</a>
            <a className="btn-secondary btn-sm" href={dl("department-cost")}>Department cost</a>
            <a className="btn-secondary btn-sm" href={dl("journal")}>Accounting journal</a>
          </div>
        </Card>
        <Card title={run.status === "locked" ? "After payment" : "Reopen"}>
          {run.status === "locked" ? (
            <div className="space-y-3">
              {canManage ? <>
                <ActionForm action={emailPayslips.bind(null, cid, runId)}><SubmitButton className="btn-secondary w-full" pendingText="Sending…">Email payslips</SubmitButton></ActionForm>
                <ActionForm action={setPaymentStatus.bind(null, cid, runId)} className="flex gap-2">
                  <select name="status" className="input"><option value="paid">Mark all paid</option><option value="failed">Mark all failed</option><option value="pending">Mark all pending</option></select>
                  <SubmitButton className="btn-secondary">Apply</SubmitButton>
                </ActionForm>
              </> : !canReopen && <ViewOnlyNote />}
              {canReopen && (
                <details><summary className="cursor-pointer text-sm text-rose-600">Reopen payroll…</summary>
                  <ActionForm action={reopenRun.bind(null, cid, runId)} className="mt-2 space-y-2" confirm="Reopen finalized payroll? Loan EMIs and recoveries are reversed and attendance for the month is unlocked.">
                    <Field label="Reason"><input name="reason" className="input" required /></Field>
                    <Field label={`Type ${String(run.month).slice(0, 7)} to confirm`}><input name="confirm" className="input" required pattern={String(run.month).slice(0, 7)} autoComplete="off" /></Field>
                    <SubmitButton className="btn-danger">Reopen</SubmitButton>
                  </ActionForm></details>
              )}
            </div>
          ) : <p className="text-sm text-slate-500">To change a draft, correct attendance or inputs and run payroll again — a new version replaces this one.</p>}
        </Card>
      </div>

      <Card title="Salary register" pad={false}>
        <Table head={["Employee", "Payable / LOP", "OT h", "Monthly gross", "Earned gross", "Deductions", "Net pay", "Payment", ""]}>
          {rows.map((p) => {
            const e = p.employees as Emp;
            return (
              <tr key={p.id} className={p.held ? "bg-amber-50/50" : ""}>
                <td className="td"><Link href={`/c/${cid}/payroll/payslips/${p.id}`} className="font-medium hover:underline">{fullName(e)}</Link> <span className="text-xs text-slate-500">{e.emp_code}</span></td>
                <td className="td">{num(p.payable_days)} / {num(p.lop_days)}</td><td className="td">{num(p.ot_hours)}</td>
                <td className="td">{money(p.monthly_gross)}</td><td className="td">{money(p.gross_payable)}</td><td className="td">{money(p.total_deductions)}</td>
                <td className="td font-semibold">{money(p.net_pay)}{Number(p.recovery_carry) > 0 && <div className="text-xs font-normal text-rose-600">{money(p.recovery_carry)} carried</div>}</td>
                <td className="td"><Badge value={p.held ? "on_hold" : p.payment_status} /></td>
                <td className="td text-right">
                  {canManage && <form action={setHold.bind(null, cid, p.id, !p.held)}><button className="text-xs text-slate-500 hover:underline">{p.held ? "Release" : "Hold"}</button></form>}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
