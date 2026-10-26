import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDateTime, fmtMonth, todayIST } from "@/lib/format";
import { AttendanceTabs } from "../tabs";
import { lockMonth, recompute, unlockMonth } from "../actions";

export const metadata = { title: "Month lock" };

// ATT-15: HR locks a month before payroll; unlocking needs an admin and a reason
export default async function Lock({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.manage");
  const { supabase, perms } = ctx;
  const { data: locks } = await supabase.from("attendance_locks").select("*").eq("company_id", cid).order("month", { ascending: false });
  const today = todayIST();
  const months = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 - i, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  });
  const lockedAt = new Map((locks ?? []).map((l) => [l.month, l]));
  const lastDay = (m: string) => new Date(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0).toISOString().slice(0, 10);

  return (
    <>
      <PageHeader title="Month lock" subtitle="Payroll runs only on a locked month. Locking needs the exceptions queue to be empty." />
      <AttendanceTabs cid={cid} active="lock" perms={perms} />
      <Card pad={false}>
        <Table head={["Month", "Status", "Locked at", "Actions"]}>
          {months.map((m) => {
            const l = lockedAt.get(m);
            return (
              <tr key={m}>
                <td className="td font-medium">{fmtMonth(m)}</td>
                <td className="td"><Badge value={l ? "locked" : "draft"} text={l ? "Locked" : "Open"} /></td>
                <td className="td">{l ? fmtDateTime(l.locked_at) : "—"}</td>
                <td className="td">
                  {!l ? (
                    <div className="flex flex-wrap gap-2">
                      <ActionForm action={recompute.bind(null, cid)}>
                        <input type="hidden" name="from" value={m} /><input type="hidden" name="to" value={lastDay(m) < today ? lastDay(m) : today} />
                        <SubmitButton className="btn-secondary btn-sm" pendingText="Recalculating…">Recalculate</SubmitButton>
                      </ActionForm>
                      <ActionForm action={lockMonth.bind(null, cid)} confirm={`Lock attendance for ${fmtMonth(m)}?`}>
                        <input type="hidden" name="month" value={m} /><SubmitButton className="btn-primary btn-sm">Lock month</SubmitButton>
                      </ActionForm>
                    </div>
                  ) : perms.has("attendance.unlock") ? (
                    <ActionForm action={unlockMonth.bind(null, cid)} className="flex flex-wrap items-end gap-2">
                      <input type="hidden" name="month" value={m} />
                      <Field label=""><input name="reason" className="input w-56 h-8" placeholder="Reason for unlocking" required /></Field>
                      <SubmitButton className="btn-secondary btn-sm">Unlock</SubmitButton>
                    </ActionForm>
                  ) : <span className="text-xs text-slate-500">Ask an admin to unlock</span>}
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>
    </>
  );
}
