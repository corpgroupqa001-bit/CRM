import Link from "next/link";
import { Receipt } from "lucide-react";
import { getCtx } from "@/lib/context";
import { Badge, Card, Empty, PageHeader, Table } from "@/components/ui";
import { fmtMonth, money } from "@/lib/format";

export const metadata = { title: "My payslips" };

// SAL-12 / §5.3: every employee (managers included) reads their own payslips once payroll is approved.
// RLS on payslips returns only the signed-in employee's approved slips here.
export default async function MyPayslips({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  const { supabase, employee, company } = ctx;
  const { data: slips } = employee
    ? await supabase.from("payslips").select("id, month, net_pay, gross_payable, total_deductions, payment_status")
        .eq("company_id", cid).eq("employee_id", employee.id).order("month", { ascending: false })
    : { data: [] };
  return (
    <>
      <PageHeader title="My payslips" subtitle={company.payslip_password ? "PDFs are password-protected: your date of birth as DDMMYYYY, or your employee code if no date of birth is on record." : undefined} />
      {!employee ? (
        <Empty title="No employee record" icon={Receipt}>Your account isn&apos;t linked to an employee record in this company yet.</Empty>
      ) : !slips?.length ? (
        <Empty title="No payslips yet" icon={Receipt}>Your payslip appears here once your company approves the month&apos;s payroll.</Empty>
      ) : (
        <Card pad={false}>
          <Table head={["Month", "Gross", "Deductions", "Net pay", "Payment", ""]}>
            {slips.map((s) => (
              <tr key={s.id}>
                <td className="td font-medium text-slate-900"><Link href={`/c/${cid}/payroll/payslips/${s.id}`} className="hover:underline">{fmtMonth(s.month)}</Link></td>
                <td className="td tabular-nums">{money(s.gross_payable)}</td>
                <td className="td tabular-nums">{money(s.total_deductions)}</td>
                <td className="td font-semibold tabular-nums text-slate-900">{money(s.net_pay)}</td>
                <td className="td"><Badge value={s.payment_status} /></td>
                <td className="td text-right"><a href={`/api/payslip/${s.id}`} className="btn-secondary btn-sm">Download PDF</a></td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </>
  );
}
