// X-03 report filters: branch, department and date range read from the URL (src/lib/report-filters.ts)
import { describe, expect, it } from "vitest";
import { allRows, daysBetween, dayFilters, filterLabel, filterQuery, inFilter, monthFilters } from "../src/lib/report-filters";
import { todayIST } from "../src/lib/format";

const q = (o: Record<string, string>) => (k: string) => o[k];
const B = "11111111-1111-4111-8111-111111111111", D = "22222222-2222-4222-8222-222222222222";

describe("attendance: a day range", () => {
  it("defaults to this month", () => {
    const m = todayIST().slice(0, 7);
    const f = dayFilters(q({}));
    expect(f.from).toBe(`${m}-01`);
    expect(f.to.slice(0, 7)).toBe(m);
    expect(f.branch).toBeNull();
  });
  it("an old ?month= link still opens that whole month", () => {
    expect(dayFilters(q({ month: "2026-02" }))).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("keeps a valid range, swaps a backwards one, and caps it at a year", () => {
    expect(dayFilters(q({ from: "2026-10-01", to: "2026-10-15" }))).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
    expect(dayFilters(q({ from: "2026-10-15", to: "2026-10-01" }))).toMatchObject({ from: "2026-10-01", to: "2026-10-15" });
    expect(dayFilters(q({ from: "2024-01-01", to: "2026-12-31" }))).toMatchObject({ from: "2024-01-01", to: "2024-12-31" });
  });
  it("ignores branch and department values that aren't ids", () => {
    expect(dayFilters(q({ branch: "x' or 1=1", department: D }))).toMatchObject({ branch: null, department: D });
  });
});

describe("payroll: a month range", () => {
  it("keeps a valid range and caps it at two years", () => {
    expect(monthFilters(q({ from: "2026-04", to: "2026-09" }))).toMatchObject({ from: "2026-04", to: "2026-09" });
    expect(monthFilters(q({ from: "2020-01", to: "2026-09" }))).toMatchObject({ from: "2024-10", to: "2026-09" });
  });
  it("defaults to the last three months", () => {
    const f = monthFilters(q({}));
    expect(f.to).toBe(todayIST().slice(0, 7));
    expect(daysBetween(`${f.from}-01`, `${f.to}-01`).filter((d) => d.endsWith("-01"))).toHaveLength(3);
  });
});

describe("helpers", () => {
  it("matches people on branch and department", () => {
    const f = { from: "", to: "", branch: B, department: null };
    expect(inFilter({ branch_id: B, department_id: D }, f)).toBe(true);
    expect(inFilter({ branch_id: null, department_id: D }, f)).toBe(false);
    expect(inFilter({ branch_id: null, department_id: null }, { ...f, branch: null })).toBe(true);
  });
  it("puts the filters in download links and report headers", () => {
    const f = { from: "2026-10-01", to: "2026-10-15", branch: B, department: null };
    expect(filterQuery(f, { view: "late" })).toBe(`from=2026-10-01&to=2026-10-15&view=late&branch=${B}`);
    expect(filterLabel(f, [{ id: B, name: "Pune" }], [])).toBe("Branch: Pune · All departments");
  });
  it("lists every day across a month end", () => {
    expect(daysBetween("2026-01-30", "2026-02-02")).toEqual(["2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02"]);
  });
  it("reads past the 1,000-row limit page by page", async () => {
    const data = Array.from({ length: 2345 }, (_, i) => i);
    const calls: [number, number][] = [];
    const rows = await allRows<number>(async (a, b) => { calls.push([a, b]); return { data: data.slice(a, b + 1), error: null }; });
    expect(rows).toHaveLength(2345);
    expect(calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });
});
