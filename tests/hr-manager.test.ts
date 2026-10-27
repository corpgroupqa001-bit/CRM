// HR Manager against the approved BRD matrix: attendance corrections need a reason and are audited
// (0025); per BRD v2.0 §5.3 HR / Payroll prepares payroll and manages tasks and leave; everything is per company.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {};
let cid: string, other: string, emp: string;
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "hr", "emp", "otherHr"]) U[who] = await createUser(db, `${who}@corp.in`);
  cid = (await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [U.owner]))[0].id;
  other = (await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [U.owner]))[0].id;
  await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'hr'), ($1, $3, 'employee'), ($4, $5, 'hr')`, [cid, U.hr, U.emp, other, U.otherHr]);
  emp = (await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Ravi', 'emp@corp.in', '2025-01-01') returning id`, [cid, U.emp]))[0].id;
  await sys(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Hema', 'hr@corp.in', '2025-01-01')`, [cid, U.hr]);
});

describe("attendance corrections (0025)", () => {
  it("HR can't correct attendance without a reason", async () => {
    await expect(as("hr", `select set_attendance_status($1, '2026-10-05', 'present', null)`, [emp])).rejects.toThrow(/reason/);
    await expect(as("hr", `select set_attendance_status($1, '2026-10-05', 'present', '   ')`, [emp])).rejects.toThrow(/reason/);
    await expect(as("hr", `select set_attendance_status($1, '2026-10-05', 'auto', '')`, [emp])).rejects.toThrow(/reason/);
  });

  it("a correction with a reason is saved and audited, including a day that had no record", async () => {
    await as("hr", `select set_attendance_status($1, '2026-10-06', 'on_duty', 'Client visit, approved by manager')`, [emp]);
    expect(await sys(`select status, source, remarks from daily_attendance where employee_id = $1 and date = '2026-10-06'`, [emp]))
      .toEqual([{ status: "on_duty", source: "manual", remarks: "Client visit, approved by manager" }]);
    const [a] = await sys<{ user_id: string; new_data: Record<string, string>; old_data: Record<string, unknown> }>(
      `select user_id, new_data, old_data from audit_log where action = 'attendance_correction' order by at desc limit 1`);
    expect(a.user_id).toBe(U.hr);
    expect(a.new_data).toMatchObject({ employee_id: emp, date: "2026-10-06", status: "on_duty", reason: "Client visit, approved by manager" });
    expect(a.old_data).toEqual({ status: null });
  });

  it("returning a day to automatic also needs a reason and is audited", async () => {
    await as("hr", `select set_attendance_status($1, '2026-10-06', 'auto', 'Entered by mistake')`, [emp]);
    const rows = await sys<{ new_data: Record<string, string>; old_data: Record<string, string> }>(
      `select new_data, old_data from audit_log where action = 'attendance_correction' order by at desc limit 1`);
    expect(rows[0]).toMatchObject({ new_data: { status: "auto", reason: "Entered by mistake" }, old_data: { status: "on_duty" } });
  });

  it("the employee is notified of each correction, with the reason (0026)", async () => {
    await sys(`delete from notifications`);
    await as("hr", `select set_attendance_status($1, '2026-10-08', 'present', 'Forgot to punch in')`, [emp]);
    await as("hr", `select set_attendance_status($1, '2026-10-08', 'half_day', 'Left at 1 pm')`, [emp]);
    await as("hr", `select set_attendance_status($1, '2026-10-08', 'auto', 'Entered by mistake')`, [emp]);
    const rows = await sys<{ user_id: string; company_id: string; title: string; body: string; link: string; kind: string }>(
      `select user_id, company_id, title, body, link, kind from notifications order by created_at, id`);
    expect(rows.map((r) => r.body)).toEqual([
      "08 Oct 2026: marked Present. Reason: Forgot to punch in",
      "08 Oct 2026: marked Half Day (was Present). Reason: Left at 1 pm",
      "08 Oct 2026: set back to automatic (was Half Day). Reason: Entered by mistake",
    ]);
    expect(rows[0]).toMatchObject({ user_id: U.emp, company_id: cid, title: "Attendance corrected", link: "/attendance/me", kind: "attendance" });
  });

  it("no notification when HR corrects their own day", async () => {
    await sys(`delete from notifications`);
    const [mine] = await sys<{ id: string }>(`select id from employees where user_id = $1`, [U.hr]);
    await as("hr", `select set_attendance_status($1, '2026-10-09', 'present', 'Card reader down')`, [mine.id]);
    expect(await sys(`select id from notifications`)).toHaveLength(0);
  });

  it("employees and HR of another company can't correct attendance here", async () => {
    await expect(as("emp", `select set_attendance_status($1, '2026-10-07', 'present', 'me')`, [emp])).rejects.toThrow(/not allowed/);
    await expect(as("otherHr", `select set_attendance_status($1, '2026-10-07', 'present', 'x')`, [emp])).rejects.toThrow(/not allowed/);
  });
});

describe("HR / Payroll against BRD v2.0 §5.3", () => {
  it("prepares payroll: creates salary structures and CTC (Salaries CRUD, prepare)", async () => {
    await as("hr", `insert into salary_structures (company_id, name) values ($1, 'HR made')`, [cid]);
    const [s] = await sys<{ id: string }>(`select id from salary_structures where company_id = $1 limit 1`, [cid]);
    await as("hr", `insert into employee_ctc (company_id, employee_id, structure_id, annual_ctc, effective_from) values ($1, $2, $3, 600000, '2026-10-01')`, [cid, emp, s.id]);
    await expect(as("hr", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/Lock attendance/);   // allowed; attendance isn't locked
  });

  it("employees can't see salaries at all", async () => {
    expect(await as("emp", `select id from salary_structures where company_id = $1`, [cid])).toHaveLength(0);
    expect(await as("emp", `select id from employee_ctc where company_id = $1`, [cid])).toHaveLength(0);
  });

  it("creates and manages tasks (Tasks CRUD)", async () => {
    const [{ id }] = await as<{ id: string }>("hr", `insert into tasks (company_id, title, created_by) values ($1, 'Collect documents', $2) returning id`, [cid, U.hr]);
    expect((await as<{ id: string }>("hr", `update tasks set priority = 'high' where id = $1 returning id`, [id]))).toHaveLength(1);
  });

  it("manages leave (Leave CRUD)", async () => {
    const [lt] = await sys<{ id: string }>(`select id from leave_types where company_id = $1 limit 1`, [cid]);
    await as("hr", `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date) values ($1, $2, $3, '2026-11-02', '2026-11-02')`, [cid, emp, lt.id]);
    expect(await as("hr", `select id from leave_requests where employee_id = $1`, [emp])).toHaveLength(1);
  });

  it("HR rights in one company give nothing in another", async () => {
    expect(await as("otherHr", `select id from employees where company_id = $1`, [cid])).toHaveLength(0);
    expect(await as("otherHr", `select id from salary_structures where company_id = $1`, [cid])).toHaveLength(0);
  });
});
