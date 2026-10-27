// calculate_payroll_run() — BRD SAL-27, BRD §9 Scenario 2, on the real migrations (PGlite).
// Run just this file:  pnpm test tests/payroll-run.test.ts
//
// Scenario 2: monthly gross ₹30,000, 8-hour shift, salary days = calendar days, October 2026 (31 days)
//   21 present + 2 half-days + 1 paid leave + 1 holiday + 4 weekly offs + 2 absent = 28 payable / 3 LOP
//   earned gross = 30,000 × 28 ÷ 31 = ₹27,097; 6 h approved OT at ₹241.94/h = ₹1,452
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addMember, asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let owner: string, cid: string, structure: string;

type Row = { emp_code: string; salary_days: string; payable_days: string; lop_days: string; ratio: string; monthly_gross: string;
  earned_gross: string; overtime: string; gross_payable: string; statutory_deductions: string; other_deductions: string;
  net_pay: string; carried_forward: string };

const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => asOwnerUser(db, owner, async () => (await db.query<T>(sql, p)).rows);
const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
const sunday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay() === 0;

async function employee(code: string, lwd: string | null = null) {
  const [e] = await q<{ id: string }>(`insert into employees (company_id, emp_code, first_name, email, date_of_joining, last_working_day, status)
    values ($1, $2, $2, $3, '2025-01-01', $4, $5) returning id`, [cid, code, `${code.toLowerCase()}@acme.in`, lwd, lwd ? "notice" : "active"]);
  await q(`insert into employee_ctc (company_id, employee_id, structure_id, annual_ctc, effective_from) values ($1, $2, $3, 360000, '2025-01-01')`,
    [cid, e.id, structure]);
  return e.id;
}

/** default: present on working days, weekly off on Sundays, holiday on 2 Oct; "skip" leaves the day to leave / nothing */
async function mark(emp: string, overrides: Record<string, string>, last = "2026-10-31") {
  for (const d of days.filter((x) => x <= last)) {
    const s = overrides[d] ?? (d === "2026-10-02" ? "holiday" : sunday(d) ? "weekly_off" : "present");
    if (s !== "skip") await q(`select set_attendance_status($1, $2, $3, 'test setup')`, [emp, d, s]);
  }
}

const run = (month = "2026-10") => q<Row>(`select * from calculate_payroll_run($1, $2)`, [cid, month]);

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@acme.in");
  [{ id: cid }] = await q<{ id: string }>(`insert into companies (owner_id, name, weekly_offs) values ($1, 'Acme', '{0}') returning id`, [owner]);
  owner = await addMember(db, cid, "hr@acme.in", "hr");   // HR / Payroll prepares payroll (SAL-09)
  [{ id: structure }] = await q<{ id: string }>(`select id from salary_structures where company_id = $1`, [cid]);
  await q(`insert into holidays (company_id, date, name) values ($1, '2026-10-02', 'Gandhi Jayanti')`, [cid]);

  // Scenario 2 employee
  const emp = await employee("S2");
  await mark(emp, {
    "2026-10-05": "half_day", "2026-10-06": "half_day", "2026-10-07": "absent", "2026-10-08": "absent", "2026-10-09": "skip",
  });
  const [cl] = await q<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'CL'`, [cid]);
  await q(`insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date) values ($1, $2, $3, '2026-10-09', '2026-10-09')`, [cid, emp, cl.id]);
  await q(`update leave_requests set status = 'approved' where employee_id = $1`, [emp]);
  await q(`update daily_attendance set ot_minutes = 360, ot_approved_minutes = 360 where employee_id = $1 and date = '2026-10-12'`, [emp]);

  // SAL-24 employee: leaves on 10 Oct with a ₹15,000 advance outstanding. Earned Leave accrues monthly
  // and is encashed on exit (SAL-11), which would cover the advance, so switch accrual off for this test.
  await q(`update leave_types set accrual = 'none' where company_id = $1 and code = 'EL'`, [cid]);
  const leaver = await employee("X1", "2026-10-10");
  await mark(leaver, {}, "2026-10-10");
  await q(`insert into loans (company_id, employee_id, kind, principal, emi, balance, start_month) values ($1, $2, 'advance', 15000, 15000, 15000, '2026-10-01')`, [cid, leaver]);
});

describe("calculate_payroll_run (SAL-27)", () => {
  it("refuses to run before the month's attendance is locked (SAL-22)", async () => {
    await expect(run()).rejects.toThrow(/Lock attendance/);
    await q(`select lock_attendance_month($1, '2026-10-01')`, [cid]);
  });

  it("BRD Scenario 2: 28 payable days, ratio capped below 1, earned gross ₹27,097", async () => {
    const r = (await run()).find((x) => x.emp_code === "S2")!;
    // step 1 — payable days from attendance
    expect(Number(r.salary_days)).toBe(31);
    expect(Number(r.payable_days)).toBe(28);
    expect(Number(r.lop_days)).toBe(3);
    // step 2 — proration ratio
    expect(Number(r.ratio)).toBeCloseTo(28 / 31, 6);
    // step 3 — prorated earnings
    expect(Number(r.monthly_gross)).toBe(30000);
    expect(Number(r.earned_gross)).toBe(27097);
    expect(Number(r.overtime)).toBe(1452);                      // 6 h × ₹241.94
    expect(Number(r.gross_payable)).toBe(27096 + 1452);         // per-line rounding: 13,548 + 5,419 + 1,445 + 6,684 + OT
    // step 4 — statutory: PF 12% of earned Basic (₹13,548.39 → ₹1,626) + PT ₹200 (gross above ₹20,000); no ESI above ₹21,000
    expect(Number(r.statutory_deductions)).toBe(1626 + 200);
    expect(Number(r.net_pay)).toBe(28548 - 1826);
    expect(Number(r.carried_forward)).toBe(0);
  });

  it("negative net pay is capped at zero and the shortfall is carried forward (SAL-24)", async () => {
    const r = (await run()).find((x) => x.emp_code === "X1")!;
    expect(Number(r.earned_gross)).toBe(9677);                  // 30,000 × 10 ÷ 31
    expect(Number(r.net_pay)).toBe(0);
    expect(Number(r.carried_forward)).toBeGreaterThan(0);
    expect(Number(r.other_deductions) + Number(r.carried_forward)).toBe(15000);
    expect(Number(r.gross_payable) - Number(r.statutory_deductions) - Number(r.other_deductions)).toBe(0);
  });

  it("each call stores a new draft version of the month (SAL-28)", async () => {
    const versions = await q<{ version: number; status: string }>(`select version, status from payroll_runs where company_id = $1 order by version`, [cid]);
    expect(versions.map((v) => v.status)).toEqual(["superseded", "draft"]);
  });

  it("validates the month format", async () => {
    await expect(run("Oct 2026")).rejects.toThrow(/YYYY-MM/);
    await expect(run("2026-13")).rejects.toThrow(/YYYY-MM/);
  });

  it("only HR / admin / owner of the company can run it", async () => {
    const outsider = await createUser(db, "outsider@x.in");
    await expect(asUser(db, outsider, () => db.query(`select * from calculate_payroll_run($1, '2026-10')`, [cid]))).rejects.toThrow(/not allowed/);
  });
});
