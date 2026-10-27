// X-03 report filters: branch, department and a date range, read from the URL by the report pages and the
// export route alike, so a download always matches what is on screen. The company is the one being viewed.
import { todayIST } from "@/lib/format";

export type ReportFilters = { from: string; to: string; branch: string | null; department: string | null };
type Get = (k: string) => string | null | undefined;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const MAX_DAYS = 366;

const lastDay = (month: string) => `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, "0")}`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const id = (v: string | null | undefined) => (v && UUID.test(v) ? v : null);

/** Attendance: a day range, this month by default (an older ?month=YYYY-MM link still works); at most a year. */
export function dayFilters(get: Get): ReportFilters {
  const month = get("month");
  const m = month && MONTH.test(month) ? month : todayIST().slice(0, 7);
  let from = get("from") ?? "", to = get("to") ?? "";
  if (!DAY.test(from)) from = `${m}-01`;
  if (!DAY.test(to)) to = lastDay(from.slice(0, 7));
  if (to < from) [from, to] = [to, from];
  if (addDays(from, MAX_DAYS - 1) < to) to = addDays(from, MAX_DAYS - 1);
  return { from, to, branch: id(get("branch")), department: id(get("department")) };
}

/** Payroll: a month range (payroll is monthly), the last three months by default; at most two years. */
export function monthFilters(get: Get): ReportFilters {
  const now = todayIST().slice(0, 7);
  const back = (mo: string, n: number) => { const d = new Date(Date.UTC(Number(mo.slice(0, 4)), Number(mo.slice(5, 7)) - 1 - n, 1)); return d.toISOString().slice(0, 7); };
  let from = get("from") ?? "", to = get("to") ?? "";
  if (!MONTH.test(from)) from = back(now, 2);
  if (!MONTH.test(to)) to = now;
  if (to < from) [from, to] = [to, from];
  if (back(to, 23) > from) from = back(to, 23);
  return { from, to, branch: id(get("branch")), department: id(get("department")) };
}

/** the filters as a query string, for links (downloads, switching report) */
export function filterQuery(f: ReportFilters, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ from: f.from, to: f.to, ...extra });
  if (f.branch) q.set("branch", f.branch);
  if (f.department) q.set("department", f.department);
  return q.toString();
}

/** a person matches when they're in the chosen branch and department (their current ones) */
export const inFilter = (p: { branch_id: string | null; department_id: string | null }, f: ReportFilters) =>
  (!f.branch || p.branch_id === f.branch) && (!f.department || p.department_id === f.department);

/** "Branch: Pune · Department: Sales" for report headers; "All branches · All departments" when not filtered */
export function filterLabel(f: ReportFilters, branches: { id: string; name: string }[], departments: { id: string; name: string }[]) {
  const b = f.branch ? `Branch: ${branches.find((x) => x.id === f.branch)?.name ?? "—"}` : "All branches";
  const d = f.department ? `Department: ${departments.find((x) => x.id === f.department)?.name ?? "—"}` : "All departments";
  return `${b} · ${d}`;
}

/** every date from → to, inclusive */
export function daysBetween(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Supabase returns at most 1,000 rows per request: read a query page by page. */
export async function allRows<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>, size = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; ; i += size) {
    const { data, error } = await page(i, i + size - 1);
    if (error) throw error;
    out.push(...(data ?? []));
    if (!data || data.length < size) return out;
  }
}
