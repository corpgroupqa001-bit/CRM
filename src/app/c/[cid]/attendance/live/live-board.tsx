"use client";
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { Badge, Stat } from "@/components/ui";
import { fmtTime } from "@/lib/format";

type Person = { id: string; full_name: string; emp_code: string; department: string | null; branch: string | null };
type Att = { employee_id: string; status: string; first_in: string | null; last_out: string | null; date?: string };

const PRESENT = ["present", "late", "early_out", "half_day", "on_duty", "wfh"];

export function LiveBoard({ companyId, date, people, initial, restrictToVisible }: {
  companyId: string; date: string; people: Person[]; initial: Att[]; restrictToVisible: boolean;
}) {
  const [rows, setRows] = useState<Map<string, Att>>(() => new Map(initial.map((a) => [a.employee_id, a])));
  const [group, setGroup] = useState<"department" | "branch">("department");
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`att-${companyId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "daily_attendance", filter: `company_id=eq.${companyId}` }, (p) => {
        const a = p.new as Att;
        if (!a || a.date !== date) return;
        setRows((m) => new Map(m).set(a.employee_id, a));
        setFlash(a.employee_id);
        setTimeout(() => setFlash(null), 2500);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [companyId, date]);

  const list = restrictToVisible ? people.filter((p) => rows.has(p.id)) : people;
  const statusOf = (id: string) => rows.get(id)?.status ?? "absent";
  const count = (f: (s: string) => boolean) => list.filter((p) => f(statusOf(p.id))).length;

  const groups = useMemo(() => {
    const g = new Map<string, Person[]>();
    for (const p of list) {
      const k = (group === "department" ? p.department : p.branch) ?? "Unassigned";
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list, group]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <Stat label="Present" value={count((s) => PRESENT.includes(s))} tone="green" />
        <Stat label="Late" value={count((s) => s === "late")} tone="amber" />
        <Stat label="Absent" value={count((s) => s === "absent" || s === "missed_punch")} tone="red" />
        <Stat label="On leave" value={count((s) => s === "on_leave")} tone="brand" />
        <Stat label="Off today" value={count((s) => s === "holiday" || s === "weekly_off")} />
      </div>
      <div className="flex items-center gap-2 text-sm">
        Group by
        <select className="input w-40" value={group} onChange={(e) => setGroup(e.target.value as "department" | "branch")}>
          <option value="department">Department</option><option value="branch">Branch</option>
        </select>
        <span className="ml-auto flex items-center gap-1 text-xs text-emerald-600"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" /> live</span>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {groups.map(([name, ps]) => (
          <div key={name} className="card">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5 text-sm font-semibold">
              {name}<span className="text-xs font-normal text-slate-500">{ps.filter((p) => PRESENT.includes(statusOf(p.id))).length}/{ps.length} in</span>
            </div>
            <ul className="divide-y divide-slate-50">
              {ps.map((p) => {
                const a = rows.get(p.id);
                return (
                  <li key={p.id} className={`flex items-center justify-between px-4 py-2 text-sm transition-colors ${flash === p.id ? "bg-emerald-50" : ""}`}>
                    <span className="truncate">{p.full_name}</span>
                    <span className="flex items-center gap-2 text-xs text-slate-500">{a?.first_in && fmtTime(a.first_in)}<Badge value={a?.status ?? "absent"} /></span>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
