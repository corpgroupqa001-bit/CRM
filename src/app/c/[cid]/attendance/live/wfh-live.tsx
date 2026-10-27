"use client";
import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Card, Table } from "@/components/ui";

export type WfhLiveRow = {
  employee_id: string; full_name: string; department: string | null; state: "in" | "break" | "out" | "not_started";
  worked_seconds: number; break_seconds: number; checked_in_at: string | null; photo_missing: boolean;
};

const hm = (s: number) => `${Math.floor(Math.max(0, s) / 3600)}h ${String(Math.floor((Math.max(0, s) % 3600) / 60)).padStart(2, "0")}m`;
const STATE: Record<WfhLiveRow["state"], [string, string]> = {
  in: ["Working", "bg-emerald-50 text-emerald-700"], break: ["On break", "bg-amber-50 text-amber-800"],
  out: ["Checked out", "bg-slate-100 text-slate-600"], not_started: ["Not checked in", "bg-rose-50 text-rose-700"],
};

/** ATT-30: work-from-home staff and their hours so far, from the server (wfh_live), kept current. */
export function WfhLive({ companyId, initial }: { companyId: string; initial: WfhLiveRow[] }) {
  const [rows, setRows] = useState(initial);
  const [base, setBase] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(async () => {
    const { data } = await createClient().rpc("wfh_live", { p_company: companyId });
    if (data) { setRows(data as WfhLiveRow[]); setBase(Date.now()); }
  }, [companyId]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    const supabase = createClient();
    const ch = supabase.channel(`wfh-live-${companyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "work_sessions", filter: `company_id=eq.${companyId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "work_breaks", filter: `company_id=eq.${companyId}` }, refresh)
      .subscribe();
    return () => { clearInterval(t); supabase.removeChannel(ch); };
  }, [companyId, refresh]);
  const elapsed = (now - base) / 1000;
  return (
    <Card title="Working from home today" description="Hours so far, breaks excluded, updated live" pad={false} className="mt-6">
      <Table head={["Employee", "Department", "Status", "Worked so far", "Break", "First check-in"]} empty="Nobody is working from home today.">
        {rows.map((r) => {
          const [text, cls] = STATE[r.state];
          return (
            <tr key={r.employee_id}>
              <td className="td font-medium text-slate-900">{r.full_name}{r.photo_missing && <span className="ml-2 text-xs font-medium text-amber-700">photo missing</span>}</td>
              <td className="td">{r.department ?? "—"}</td>
              <td className="td"><span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{text}</span></td>
              <td className="td tabular-nums">{hm(r.worked_seconds + (r.state === "in" ? elapsed : 0))}</td>
              <td className="td tabular-nums">{hm(r.break_seconds + (r.state === "break" ? elapsed : 0))}</td>
              <td className="td tabular-nums">{r.checked_in_at ? new Date(r.checked_in_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—"}</td>
            </tr>
          );
        })}
      </Table>
    </Card>
  );
}
