import { getCtx, requirePerm } from "@/lib/context";
import { PageHeader } from "@/components/ui";
import { todayIST } from "@/lib/format";
import { AttendanceTabs } from "../tabs";
import { LiveBoard } from "./live-board";
import { WfhLive, type WfhLiveRow } from "./wfh-live";

export const metadata = { title: "Live attendance" };

// ATT-14 live dashboard: present, absent, late, on leave right now, by branch and department
export default async function Live({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.read_all", "attendance.read_team");
  const today = todayIST();
  const [{ data: people }, { data: att }, { data: wfh }] = await Promise.all([
    ctx.supabase.from("employee_directory").select("id, full_name, emp_code, department, branch").eq("company_id", cid).in("status", ["active", "notice"]),
    ctx.supabase.from("daily_attendance").select("employee_id, status, first_in, last_out").eq("company_id", cid).eq("date", today),
    ctx.supabase.rpc("wfh_live", { p_company: cid }),
  ]);
  return (
    <>
      <PageHeader title="Live attendance" subtitle="Updates within a minute of each punch" />
      <AttendanceTabs cid={cid} active="live" perms={ctx.perms} />
      <LiveBoard companyId={cid} date={today} people={people ?? []} initial={att ?? []} restrictToVisible={ctx.role === "manager"} />
      <WfhLive companyId={cid} initial={(wfh ?? []) as WfhLiveRow[]} />
    </>
  );
}
