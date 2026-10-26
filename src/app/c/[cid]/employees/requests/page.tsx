import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { fullName } from "@/lib/employees";
import { decideChangeRequest } from "../actions";

export const metadata = { title: "Change requests" };

// EMP-09: employee changes to bank / PAN wait for HR approval
export default async function Requests({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "employees.update");
  const { data } = await ctx.supabase.from("employee_change_requests").select("*, employees(id, first_name, last_name, emp_code)")
    .eq("company_id", cid).order("created_at", { ascending: false }).limit(100);
  return (
    <>
      <PageHeader title="Change requests" subtitle="Bank and PAN changes submitted by employees" />
      <Card pad={false}>
        <Table head={["Employee", "Field", "Requested change", "Submitted", "Status", ""]}>
          {(data ?? []).map((r) => {
            const e = r.employees as { id: string; first_name: string; last_name: string | null; emp_code: string };
            return (
              <tr key={r.id}>
                <td className="td"><Link href={`/c/${cid}/employees/${e.id}?tab=statutory`} className="font-medium hover:underline">{fullName(e)}</Link> <span className="text-xs text-slate-500">{e.emp_code}</span></td>
                <td className="td uppercase">{r.field}</td><td className="td">{r.summary}</td><td className="td">{fmtDateTime(r.created_at)}</td>
                <td className="td"><Badge value={r.status} /></td>
                <td className="td text-right">{r.status === "pending" && (
                  <span className="flex justify-end gap-2">
                    <form action={decideChangeRequest.bind(null, cid, r.id, true)}><button className="btn-primary btn-sm">Approve</button></form>
                    <form action={decideChangeRequest.bind(null, cid, r.id, false)}><button className="btn-secondary btn-sm">Reject</button></form>
                  </span>)}</td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
