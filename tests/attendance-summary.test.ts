// Dashboard "Company today" counts and the 14-day trend (src/lib/attendance-summary.ts)
import { describe, expect, it } from "vitest";
import { dayCounts, fetchAll, presentShare, type SummaryEmployee, type SummaryRow } from "@/lib/attendance-summary";

const emp = (id: string, o: Partial<SummaryEmployee> = {}): SummaryEmployee =>
  ({ id, branch_id: "hq", date_of_joining: "2025-01-01", last_working_day: null, status: "active", ...o });
const WED = "2026-10-21", SUN = "2026-10-25";

describe("dayCounts", () => {
  const people = [emp("a"), emp("b"), emp("c"), emp("d"), emp("e"), emp("new", { date_of_joining: "2026-10-22" }), emp("gone", { last_working_day: "2026-10-10", status: "exited" })];
  const rows: SummaryRow[] = [
    { employee_id: "a", date: WED, status: "present" },
    { employee_id: "b", date: WED, status: "late" },
    { employee_id: "c", date: WED, status: "on_leave" },
    { employee_id: "d", date: WED, status: "missed_punch" },
  ];

  it("counts present (incl. late), late, leave, and absent — no record on a working day is absent", () => {
    expect(dayCounts(WED, people, rows, [0], [])).toEqual({ date: WED, employed: 5, present: 2, late: 1, absent: 2, onLeave: 1, off: 0 });
  });

  it("ignores people not yet joined or already gone", () => {
    expect(dayCounts(WED, people, rows, [0], []).employed).toBe(5);
  });

  it("treats a weekly off with no record as off, not absent", () => {
    expect(dayCounts(SUN, people, [], [0], [])).toMatchObject({ employed: 6, absent: 0, off: 6 });   // "new" joined on the 22nd
  });

  it("applies holidays to all branches or only the listed branch", () => {
    const mixed = [emp("x", { branch_id: "hq" }), emp("y", { branch_id: "pune" })];
    expect(dayCounts(WED, mixed, [], [0], [{ date: WED, branch_id: null }])).toMatchObject({ off: 2, absent: 0 });
    expect(dayCounts(WED, mixed, [], [0], [{ date: WED, branch_id: "pune" }])).toMatchObject({ off: 1, absent: 1 });
  });

  it("a punch on an off day still counts as present", () => {
    expect(dayCounts(SUN, [emp("a")], [{ employee_id: "a", date: SUN, status: "present" }], [0], [])).toMatchObject({ present: 1, off: 0 });
  });
});

describe("presentShare", () => {
  it("is present ÷ expected at work, and null when everyone is off", () => {
    expect(presentShare({ date: WED, employed: 5, present: 2, late: 1, absent: 2, onLeave: 1, off: 0 })).toBe(40);
    expect(presentShare({ date: SUN, employed: 5, present: 0, late: 0, absent: 0, onLeave: 0, off: 5 })).toBeNull();
  });
});

describe("fetchAll", () => {
  it("pages past the 1,000-row limit", async () => {
    const data = Array.from({ length: 2345 }, (_, i) => i);
    const calls: [number, number][] = [];
    const all = await fetchAll<number>(async (f, t) => { calls.push([f, t]); return { data: data.slice(f, t + 1), error: null }; });
    expect(all).toHaveLength(2345);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
  it("throws on a query error", async () => {
    await expect(fetchAll(async () => ({ data: null, error: new Error("boom") }))).rejects.toThrow("boom");
  });
});
