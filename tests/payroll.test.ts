// BRD §9 test scenarios, run against the real run_payroll() Postgres function.
// Monthly gross ₹30,000, 8-hour shift, salary days = calendar days, October 2026
// (31 days; Sundays 4/11/18/25 are weekly offs; 2 Oct is the holiday).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwnerUser, createDb, createUser } from "./db";

let db: PGlite;
let owner: string;
let approver: string;   // maker-checker: whoever runs payroll can't approve it
let company: string;
let structure: string;

const OCT = "2026-10-01";
const HOLIDAY = "2026-10-02";
const isSunday = (d: string) => new Date(d + "T00:00:00Z").getUTCDay() === 0;
const octDays = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return asOwnerUser(db, owner, async () => (await db.query<T>(sql, params)).rows);
}

async function addEmployee(code: string, doj: string, lwd: string | null = null) {
  const [e] = await q<{ id: string }>(
    `insert into employees (company_id, emp_code, first_name, email, date_of_joining, last_working_day, status)
     values ($1, $2, $2, $3, $4, $5, $6) returning id`,
    [company, code, `${code.toLowerCase()}@acme.in`, doj, lwd, lwd ? "notice" : "active"]);
  await q(`insert into employee_ctc (company_id, employee_id, structure_id, annual_ctc, effective_from)
           values ($1, $2, $3, 360000, $4)`, [company, e.id, structure, doj]);
  return e.id;
}

/** Mark each day: default is present on working days, weekly_off on Sundays, holiday on 2 Oct. */
async function markMonth(emp: string, overrides: Record<string, string> = {}, from = "2026-10-01", to = "2026-10-31") {
  for (const d of octDays) {
    if (d < from || d > to) continue;
    const status = overrides[d] ?? (d === HOLIDAY ? "holiday" : isSunday(d) ? "weekly_off" : "present");
    if (status === "skip") continue;
    await q(`select set_attendance_status($1, $2, $3, 'test setup')`, [emp, d, status]);
  }
}

async function runPayroll() {
  await q(`select lock_attendance_month($1, $2)`, [company, OCT]);
  const [r] = await q<{ run_payroll: string }>(`select run_payroll($1, $2)`, [company, OCT]);
  return r.run_payroll;
}

async function approve(run: string) {
  await asOwnerUser(db, approver, () => db.query(`select approve_payroll($1)`, [run]));
}

async function slip(run: string, emp: string) {
  const [p] = await q<Record<string, string>>(`select * from payslips where run_id = $1 and employee_id = $2`, [run, emp]);
  const lines = await q<{ code: string; amount: string }>(
    `select code, amount from payslip_lines where payslip_id = $1 order by sort`, [p.id]);
  const line = (code: string) => Number(lines.find((l) => l.code === code)?.amount ?? 0);
  return { ...p, n: (k: string) => Number(p[k]), line };
}

async function reset() {
  await q(`delete from attendance_locks where company_id = $1`, [company]);
  await q(`delete from payroll_runs where company_id = $1`, [company]);
  await q(`delete from daily_attendance where company_id = $1`, [company]);
  await q(`delete from leave_requests where company_id = $1`, [company]);
  await q(`delete from loans where company_id = $1`, [company]);
  await q(`delete from recovery_balances where company_id = $1`, [company]);
  await q(`delete from employee_ctc where company_id = $1`, [company]);
  await q(`delete from employees where company_id = $1`, [company]);
  await q(`update companies set salary_days_basis = 'calendar', sandwich_paid = true where id = $1`, [company]);
}

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "priya@acme.in");
  [{ id: company }] = await q<{ id: string }>(
    `insert into companies (owner_id, name, weekly_offs) values ($1, 'Acme', '{0}') returning id`, [owner]);
  approver = await createUser(db, "finance@acme.in");
  await q(`insert into company_members (company_id, user_id, role) values ($1, $2, 'finance')`, [company, approver]);
  [{ id: structure }] = await q<{ id: string }>(
    `select id from salary_structures where company_id = $1`, [company]);
  await q(`insert into holidays (company_id, date, name) values ($1, $2, 'Gandhi Jayanti')`, [company, HOLIDAY]);
  // turn off income tax for these scenarios (₹3.6 L a year is below the taxable limit anyway)
  await q(`update statutory_settings set tds_enabled = false where company_id = $1`, [company]);
});

describe("BRD §9 payroll scenarios", () => {
  it("1 · full month pays the full gross, and the ratio is capped at 1.0 with a fixed 30-day basis", async () => {
    await reset();
    const emp = await addEmployee("E001", "2025-01-01");
    await markMonth(emp);
    let s = await slip(await runPayroll(), emp);
    expect(s.n("payable_days")).toBe(31);
    expect(s.n("lop_days")).toBe(0);
    expect(s.n("earned_gross")).toBeCloseTo(30000, 6);
    expect(s.n("gross_payable")).toBe(30000);

    await q(`update companies set salary_days_basis = '30' where id = $1`, [company]);
    await q(`delete from attendance_locks where company_id = $1`, [company]);
    s = await slip(await runPayroll(), emp);
    expect(s.n("ratio")).toBe(1);                       // 31 / 30 would be 1.033 — capped
    expect(s.n("earned_gross")).toBeCloseTo(30000, 6);
  });

  it("2 · LOP, half-days and approved OT", async () => {
    await reset();
    const emp = await addEmployee("E002", "2025-01-01");
    const [cl] = await q<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'CL'`, [company]);
    // 21 present, 2 half-days, 1 paid leave, 1 holiday, 4 weekly offs, 2 absent
    await markMonth(emp, {
      "2026-10-05": "half_day", "2026-10-06": "half_day",
      "2026-10-07": "absent", "2026-10-08": "absent",
      "2026-10-09": "skip",
    });
    await q(`insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date)
             values ($1, $2, $3, '2026-10-09', '2026-10-09')`, [company, emp, cl.id]);
    await q(`update leave_requests set status = 'approved' where employee_id = $1`, [emp]);
    const [leaveDay] = await q<{ status: string }>(
      `select status from daily_attendance where employee_id = $1 and date = '2026-10-09'`, [emp]);
    expect(leaveDay.status).toBe("on_leave");
    // 6 hours of approved overtime
    await q(`update daily_attendance set ot_minutes = 360, ot_approved_minutes = 360
             where employee_id = $1 and date = '2026-10-12'`, [emp]);

    const s = await slip(await runPayroll(), emp);
    expect(s.n("payable_days")).toBe(28);
    expect(s.n("lop_days")).toBe(3);
    expect(Math.round(s.n("earned_gross"))).toBe(27097);   // 30,000 × 28 ÷ 31
    expect(s.n("day_value") / 8 * 2).toBeCloseTo(241.94, 2);
    expect(s.line("OT")).toBe(1452);
    // gross payable = rounded component lines + OT; per-line rounding gives ₹28,548 (BRD rounds the total: ₹28,549)
    expect(Math.abs(s.n("gross_payable") - 28549)).toBeLessThanOrEqual(1);
  });

  it("3 · mid-month joiner: days before joining are neither payable nor LOP", async () => {
    await reset();
    const emp = await addEmployee("E003", "2026-10-16");
    await markMonth(emp, {}, "2026-10-16");
    const s = await slip(await runPayroll(), emp);
    expect(s.n("payable_days")).toBe(16);
    expect(s.n("lop_days")).toBe(0);
    expect(Math.round(s.n("earned_gross"))).toBe(15484);
    // PF on the earned Basic (15,000 × 16/31 = 7,741.94 → 12% = 929)
    expect(s.line("PF")).toBe(929);
  });

  it("4 · exit with settlement: encashment added, advance recovered", async () => {
    await reset();
    const emp = await addEmployee("E004", "2025-01-01", "2026-10-10");
    const [el] = await q<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'EL'`, [company]);
    await q(`update leave_types set accrual = 'none' where id = $1`, [el.id]);
    await q(`insert into leave_balances (company_id, employee_id, leave_type_id, year, opening) values ($1, $2, $3, 2026, 2)`,
      [company, emp, el.id]);
    await q(`insert into loans (company_id, employee_id, kind, principal, emi, balance, start_month)
             values ($1, $2, 'advance', 5000, 5000, 5000, '2026-10-01')`, [company, emp]);
    await markMonth(emp, {}, "2026-10-01", "2026-10-10");

    const run = await runPayroll();
    const s = await slip(run, emp);
    expect(s.n("payable_days")).toBe(10);
    expect(s.n("lop_days")).toBe(0);
    expect(Math.round(s.n("earned_gross"))).toBe(9677);
    expect(s.line("ENCASH")).toBe(1935);
    expect(s.line("RECOVERY")).toBe(5000);
    expect(s.n("net_pay")).toBe(s.n("gross_payable") - s.n("total_deductions"));
    expect(s.n("recovery_carry")).toBe(0);

    await approve(run);
    const [loan] = await q<{ balance: string; status: string }>(`select balance, status from loans where employee_id = $1`, [emp]);
    expect(Number(loan.balance)).toBe(0);
    expect(loan.status).toBe("closed");
  });

  it("SAL-24 · negative net pay is capped at zero and the shortfall is carried forward", async () => {
    await reset();
    const emp = await addEmployee("E005", "2025-01-01", "2026-10-10");
    await q(`insert into loans (company_id, employee_id, kind, principal, emi, balance, start_month)
             values ($1, $2, 'advance', 15000, 15000, 15000, '2026-10-01')`, [company, emp]);
    await markMonth(emp, {}, "2026-10-01", "2026-10-10");
    const run = await runPayroll();
    const s = await slip(run, emp);
    expect(s.n("net_pay")).toBe(0);
    expect(s.n("recovery_carry")).toBeGreaterThan(0);
    expect(s.n("recovery_carry")).toBe(15000 - s.line("RECOVERY"));
    const [r] = await q<{ warnings: { code: string }[] }>(`select warnings from payroll_runs where id = $1`, [run]);
    expect(r.warnings.some((w) => w.code === "recovery_carry")).toBe(true);

    await approve(run);
    const [rb] = await q<{ amount: string }>(`select amount from recovery_balances where employee_id = $1`, [emp]);
    expect(Number(rb.amount)).toBe(s.n("recovery_carry"));
  });

  it("sandwich rule: an off day between two LOP days is unpaid when the company switches it off", async () => {
    await reset();
    const emp = await addEmployee("E006", "2025-01-01");
    // Sat 3 Oct absent, Sun 4 Oct weekly off, Mon 5 Oct absent
    await markMonth(emp, { "2026-10-03": "absent", "2026-10-05": "absent" });
    let s = await slip(await runPayroll(), emp);
    expect(s.n("payable_days")).toBe(29);

    await q(`update companies set sandwich_paid = false where id = $1`, [company]);
    await q(`delete from attendance_locks where company_id = $1`, [company]);
    s = await slip(await runPayroll(), emp);
    expect(s.n("payable_days")).toBe(28);
  });

  it("guards: payroll needs locked attendance, and reopening unlocks attendance", async () => {
    await reset();
    const emp = await addEmployee("E007", "2025-01-01");
    await markMonth(emp);
    await expect(q(`select run_payroll($1, $2)`, [company, OCT])).rejects.toThrow(/Lock attendance/);
    const run = await runPayroll();
    await expect(q(`select approve_payroll($1)`, [run])).rejects.toThrow(/someone else must approve/);
    await approve(run);
    await expect(q(`update payslips set net_pay = 1 where run_id = $1`, [run])).rejects.toThrow(/finalized/);
    await q(`update payslips set payment_status = 'paid' where run_id = $1`, [run]);
    await expect(q(`select run_payroll($1, $2)`, [company, OCT])).rejects.toThrow(/reopen/);
    await expect(q(`select unlock_attendance_month($1, $2, 'Late correction')`, [company, OCT])).rejects.toThrow(/reopen payroll instead/);
    await expect(asOwnerUser(db, approver, () => db.query(`select approve_payroll($1)`, [run]))).rejects.toThrow(/draft/);
    await expect(q(`select reopen_payroll($1, 'Wrong OT hours', '2026-09')`, [run])).rejects.toThrow(/Type 2026-10 to confirm/);
    await expect(asOwnerUser(db, approver, () => db.query(`select reopen_payroll($1, 'x', '2026-10')`, [run]))).rejects.toThrow(/owner or a company administrator/);
    await q(`select reopen_payroll($1, 'Wrong OT hours', '2026-10')`, [run]);
    const locks = await q(`select * from attendance_locks where company_id = $1`, [company]);
    expect(locks).toHaveLength(0);
  });
});
