// Dashboard attendance numbers from real employees + daily_attendance rows.
// An employee employed on a working day with no attendance record counts as absent (they haven't
// punched); weekly offs and holidays count as "off" and are left out of the attendance share.

export const PRESENT_STATUSES = ["present", "late", "early_out", "half_day", "on_duty", "wfh"];
const ABSENT_STATUSES = ["absent", "missed_punch"];
const OFF_STATUSES = ["holiday", "weekly_off"];

export type SummaryEmployee = { id: string; branch_id: string | null; date_of_joining: string; last_working_day: string | null; status: string };
export type SummaryRow = { employee_id: string; date: string; status: string };
export type SummaryHoliday = { date: string; branch_id: string | null };

export type DayCounts = { date: string; employed: number; present: number; late: number; absent: number; onLeave: number; off: number };

const employedOn = (e: SummaryEmployee, d: string) =>
  e.date_of_joining <= d && (!e.last_working_day || e.last_working_day >= d) && e.status !== "inactive";

export function dayCounts(date: string, employees: SummaryEmployee[], rows: SummaryRow[], weeklyOffs: number[], holidays: SummaryHoliday[]): DayCounts {
  const byEmp = new Map(rows.filter((r) => r.date === date).map((r) => [r.employee_id, r.status]));
  const weeklyOff = weeklyOffs.includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  const out: DayCounts = { date, employed: 0, present: 0, late: 0, absent: 0, onLeave: 0, off: 0 };
  for (const e of employees) {
    if (!employedOn(e, date)) continue;
    out.employed++;
    const holiday = holidays.some((h) => h.date === date && (!h.branch_id || h.branch_id === e.branch_id));
    const status = byEmp.get(e.id) ?? (weeklyOff || holiday ? "weekly_off" : "absent");
    if (PRESENT_STATUSES.includes(status)) { out.present++; if (status === "late") out.late++; }
    else if (status === "on_leave") out.onLeave++;
    else if (OFF_STATUSES.includes(status)) out.off++;
    else if (ABSENT_STATUSES.includes(status)) out.absent++;
  }
  return out;
}

/** share of employees present among those expected at work (off days excluded); null when nobody was expected */
export const presentShare = (d: DayCounts) => {
  const expected = d.employed - d.off;
  return expected > 0 ? Math.round((d.present / expected) * 100) : null;
};

/** Supabase returns at most 1,000 rows per request: page through everything. */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: unknown }>, size = 1000): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += size) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw error;
    all.push(...((data ?? []) as T[]));
    if (!data || data.length < size) return all;
  }
}
