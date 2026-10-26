"use server";
import { revalidatePath } from "next/cache";
import { can, getCtx } from "@/lib/context";
import { fmtMonth, money } from "@/lib/format";

export type PayrollResult =
  | { ok: true; month: string; runId: string | null; employees: number; net: number; carried: number; message: string }
  | { ok: false; month: string; message: string; fix?: { label: string; href: string } };

/** The payroll month the dashboard runs: the previous calendar month (India time). */
function payrollMonth() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const d = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}

// SAL-27 from the dashboard: calculate_payroll_run(company, 'YYYY-MM') stores a new draft run
export async function runPayrollNow(cid: string): Promise<PayrollResult> {
  const ctx = await getCtx(cid);
  if (!can(ctx, "salaries.manage")) return { ok: false, month: payrollMonth(), message: "Only Finance / Payroll or an administrator can run payroll." };
  const { supabase } = ctx;
  const month = payrollMonth();
  const label = fmtMonth(`${month}-01`);
  const { data, error } = await supabase.rpc("calculate_payroll_run", { p_company_id: cid, p_month: month });
  if (error) {
    if (error.code === "PGRST202") {
      return { ok: false, month, message: "The payroll function isn't installed in the database yet. Apply migration 20261023000014_calculate_payroll_run.sql in Supabase." };
    }
    if (/Lock attendance/i.test(error.message)) {
      return { ok: false, month, message: `Attendance for ${label} isn't locked yet. Lock it first, then run payroll.`, fix: { label: "Lock attendance", href: `/c/${cid}/attendance/lock` } };
    }
    if (/is locked/i.test(error.message)) {
      return { ok: false, month, message: `Payroll for ${label} is already approved. Reopen it from the payroll run to recalculate.`, fix: { label: "Open payroll", href: `/c/${cid}/payroll` } };
    }
    if (error.code === "42501" || /not allowed/i.test(error.message)) return { ok: false, month, message: "Only HR or an admin can run payroll." };
    return { ok: false, month, message: error.message };
  }
  const rows = (data ?? []) as { run_id: string; net_pay: number; carried_forward: number }[];
  const net = rows.reduce((t, r) => t + Number(r.net_pay), 0);
  const carried = rows.reduce((t, r) => t + Number(r.carried_forward), 0);
  revalidatePath(`/c/${cid}`, "layout");
  return {
    ok: true, month, runId: rows[0]?.run_id ?? null, employees: rows.length, net, carried,
    message: rows.length
      ? `Payroll for ${label} calculated for ${rows.length} employee${rows.length === 1 ? "" : "s"} · net payout ${money(net)}${carried > 0 ? ` · ${money(carried)} carried forward` : ""}. Review and approve it before paying.`
      : `Payroll for ${label} ran, but no employee has a salary assigned for that month.`,
  };
}
