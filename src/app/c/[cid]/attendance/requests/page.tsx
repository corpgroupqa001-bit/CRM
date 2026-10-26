import { leaveEnabled } from "@/lib/rbac";
import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDate, label, minutesToHm } from "@/lib/format";
import { fullName } from "@/lib/employees";
import { AttendanceTabs } from "../tabs";
import { approveOvertime, bulkRegularisations, decideRegularisation } from "../actions";

export const metadata = { title: "Approvals" };

type Emp = { first_name: string; last_name: string | null; emp_code: string };

export default async function Approvals({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.approve");
  const { supabase, employee } = ctx;
  const since = new Date(Date.now() - 45 * 86400000).toISOString().slice(0, 10);
  const [{ data: regs }, { data: ot }, { count: leave }] = await Promise.all([
    supabase.from("regularisations").select("*, employees(first_name, last_name, emp_code)").eq("company_id", cid).eq("status", "pending").order("date"),
    supabase.from("daily_attendance").select("id, date, ot_minutes, ot_approved_minutes, employee_id, employees(first_name, last_name, emp_code)")
      .eq("company_id", cid).gt("ot_minutes", 0).gte("date", since).order("date", { ascending: false }).limit(100),
    supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending"),
  ]);
  const others = <T extends { employee_id: string }>(rows: T[] | null) => (rows ?? []).filter((r) => r.employee_id !== employee?.id);

  return (
    <>
      <PageHeader title="Approvals" />
      <AttendanceTabs cid={cid} active="requests" perms={ctx.perms} />
      <div className="space-y-6">
        {leaveEnabled(ctx.perms) && (leave ?? 0) > 0 && <p className="text-sm"><Link href={`/c/${cid}/leave?tab=approvals`} className="font-medium text-brand-600 hover:underline">{leave} leave request(s) waiting →</Link></p>}
        <Card title="Attendance corrections" pad={false} actions={others(regs).length > 0 && (
          <ActionForm id="bulk-reg" action={bulkRegularisations.bind(null, cid)} className="flex items-center gap-2" confirm="Apply this decision to all selected corrections?">
            <span className="text-xs text-slate-500">Selected:</span>
            <select name="decision" className="input h-8 w-32 text-xs"><option value="approved">Approve</option><option value="rejected">Reject</option></select>
            <SubmitButton className="btn-primary btn-sm">Apply</SubmitButton>
          </ActionForm>
        )}>
          <Table head={["", "Employee", "Date", "Type", "Times", "Reason", ""]} empty="No pending corrections.">
            {others(regs).map((r) => (
              <tr key={r.id}>
                <td className="td w-8"><input type="checkbox" name="ids" value={r.id} form="bulk-reg" aria-label="Select correction" /></td>
                <td className="td">{fullName(r.employees as Emp)}</td><td className="td">{fmtDate(r.date)}</td><td className="td">{label(r.kind)}</td>
                <td className="td">{[r.in_time?.slice(0, 5), r.out_time?.slice(0, 5)].filter(Boolean).join(" – ") || "—"}</td>
                <td className="td max-w-xs">{r.reason}</td>
                <td className="td"><span className="flex justify-end gap-2">
                  <form action={decideRegularisation.bind(null, cid, r.id, "approved")}><button className="btn-primary btn-sm">Approve</button></form>
                  <form action={decideRegularisation.bind(null, cid, r.id, "rejected")}><button className="btn-secondary btn-sm">Reject</button></form>
                </span></td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Overtime (last 45 days)" pad={false}>
          <Table head={["Employee", "Date", "Worked OT", "Approved", ""]} empty="No overtime recorded.">
            {others(ot).map((a) => (
              <tr key={a.id}>
                <td className="td">{fullName(a.employees as unknown as Emp)}</td><td className="td">{fmtDate(a.date)}</td>
                <td className="td">{minutesToHm(a.ot_minutes)}</td>
                <td className="td">{a.ot_approved_minutes ? <Badge value="approved" text={minutesToHm(a.ot_approved_minutes)} /> : <Badge value="pending" />}</td>
                <td className="td">
                  <ActionForm action={approveOvertime.bind(null, cid)} className="flex items-center justify-end gap-2">
                    <input type="hidden" name="id" value={a.id} />
                    <input name="hours" type="number" step="0.25" min={0} max={a.ot_minutes / 60} defaultValue={(a.ot_minutes / 60).toFixed(2)} className="input w-24 h-8" />
                    <SubmitButton className="btn-secondary btn-sm">Approve hours</SubmitButton>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
