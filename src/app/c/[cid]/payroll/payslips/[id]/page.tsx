import { notFound } from "next/navigation";
import { getCtx, requirePerm } from "@/lib/context";
import { loadPayslip } from "@/lib/payslip-pdf";
import { Card, PageHeader, Table } from "@/components/ui";
import { fmtMonth, money, money2, num, rupeesInWords } from "@/lib/format";

export const metadata = { title: "Payslip" };

// SAL-20: the payslip shows how it was calculated. Salaries module only (employees have no payslip
// access until that is approved).
export default async function PayslipView({ params }: { params: Promise<{ cid: string; id: string }> }) {
  const { cid, id } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const { supabase } = ctx;
  const data = await loadPayslip(supabase, id);
  if (!data) notFound();
  const { slip, lines } = data;
  const e = slip.employees as { first_name: string; last_name: string | null; emp_code: string };
  return (
    <>
      <PageHeader title={`Payslip · ${fmtMonth(slip.month)}`} subtitle={`${e.first_name} ${e.last_name ?? ""} · ${e.emp_code}`}
        actions={<a href={`/api/payslip/${id}`} className="btn-primary">Download PDF</a>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="How it was calculated">
          <dl className="space-y-2 text-sm">
            {[
              ["Salary days", num(slip.salary_days)], ["Days in employment this month", num(slip.window_days)],
              ["Payable days", num(slip.payable_days)], ["LOP days", num(slip.lop_days)], ["Late marks", slip.late_marks],
              ["Proration", `${num(slip.payable_days)} ÷ ${num(slip.salary_days)} = ${(Number(slip.ratio) * 100).toFixed(2)}%`],
              ["Monthly gross", money(slip.monthly_gross)], ["Day value", money2(slip.day_value)], ["Approved OT hours", num(slip.ot_hours)],
            ].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-4"><dt className="text-slate-500">{k}</dt><dd className="font-medium">{v}</dd></div>)}
          </dl>
        </Card>
        <Card title="Earnings" pad={false}>
          <Table head={["Component", "Full month", "Earned"]}>
            {lines.filter((l) => l.kind === "earning").map((l) => <tr key={l.id}><td className="td">{l.name}</td>
              <td className="td">{l.full_amount != null ? money(l.full_amount) : ""}</td><td className="td">{money(l.amount)}</td></tr>)}
            <tr className="font-semibold"><td className="td">Total</td><td className="td"></td><td className="td">{money(slip.gross_payable)}</td></tr>
          </Table>
        </Card>
        <Card title="Deductions" pad={false}>
          <Table head={["Deduction", "Amount"]} empty="No deductions.">
            {lines.filter((l) => l.kind === "deduction").map((l) => <tr key={l.id}><td className="td">{l.name}</td><td className="td">{money(l.amount)}</td></tr>)}
          </Table>
          <div className="border-t border-slate-100 px-3 py-2.5 text-sm font-semibold">Total {money(slip.total_deductions)}</div>
        </Card>
      </div>
      <div className="card mt-6 bg-brand-50 p-5">
        <div className="text-xs font-semibold uppercase text-brand-700">Net pay</div>
        <div className="text-3xl font-bold text-brand-900">{money(slip.net_pay)}</div>
        <div className="text-sm text-brand-800">{rupeesInWords(Number(slip.net_pay))}</div>
        {Number(slip.recovery_carry) > 0 && <div className="mt-2 text-sm text-rose-700">{money(slip.recovery_carry)} could not be recovered this month and is carried forward.</div>}
      </div>
    </>
  );
}
