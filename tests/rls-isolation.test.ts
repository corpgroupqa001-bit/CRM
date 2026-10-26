// NFR-04: automated cross-tenant leakage tests, run as the `authenticated` role so RLS applies.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let ownerA: string, ownerB: string, staffA: string, managerA: string;
let companyA: string, companyB: string;
let empA: string, empB: string, empStaffA: string;

const sys = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asOwnerUser(db, uid, async () => (await db.query<T>(sql, p)).rows);
const as = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, p)).rows);

beforeAll(async () => {
  db = await createDb();
  ownerA = await createUser(db, "a@one.in");
  ownerB = await createUser(db, "b@two.in");
  staffA = await createUser(db, "staff@one.in");
  managerA = await createUser(db, "mgr@one.in");

  [{ id: companyA }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'One') returning id`, [ownerA])).rows;
  [{ id: companyB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Two') returning id`, [ownerB])).rows;

  const mk = (uid: string, cid: string, name: string, user: string | null, mgr: string | null = null) =>
    sys<{ id: string }>(uid, `insert into employees (company_id, first_name, email, date_of_joining, user_id, reporting_manager_id)
      values ($1, $2, $3, '2025-01-01', $4, $5) returning id`, [cid, name, `${name}@x.in`, user, mgr]).then((r) => r[0].id);
  const mgrEmp = await mk(ownerA, companyA, "mgr", managerA);
  empStaffA = await mk(ownerA, companyA, "staff", staffA, mgrEmp);
  empA = await mk(ownerA, companyA, "other", null);
  empB = await mk(ownerB, companyB, "bee", null);
  await sys(ownerA, `insert into company_members (company_id, user_id, role) values ($1, $2, 'employee'), ($1, $3, 'manager')`,
    [companyA, staffA, managerA]);
});

describe("tenant isolation", () => {
  it("an owner sees only their own company", async () => {
    const rows = await as<{ id: string }>(ownerA, `select id from companies`);
    expect(rows.map((r) => r.id)).toEqual([companyA]);
  });

  it("cannot read another company's employees, attendance, payroll or settings", async () => {
    expect(await as(ownerA, `select * from employees where company_id = $1`, [companyB])).toHaveLength(0);
    expect(await as(ownerA, `select * from employee_directory where company_id = $1`, [companyB])).toHaveLength(0);
    expect(await as(ownerA, `select * from statutory_settings where company_id = $1`, [companyB])).toHaveLength(0);
    expect(await as(ownerA, `select * from salary_structures where company_id = $1`, [companyB])).toHaveLength(0);
    expect(await as(ownerA, `select * from conversations where company_id = $1`, [companyB])).toHaveLength(0);
  });

  it("cannot write into another company", async () => {
    await expect(as(ownerA, `insert into employees (company_id, first_name, email, date_of_joining)
      values ($1, 'x', 'x@x.in', '2025-01-01')`, [companyB])).rejects.toThrow(/row-level security/);
    const upd = await as(ownerA, `update employees set first_name = 'hacked' where id = $1 returning id`, [empB]);
    expect(upd).toHaveLength(0);
    await expect(as(ownerA, `select run_payroll($1, '2026-10-01')`, [companyB])).rejects.toThrow(/not allowed/);
    await expect(as(ownerA, `select lock_attendance_month($1, '2026-10-01')`, [companyB])).rejects.toThrow(/not allowed/);
  });

  it("cannot call device ingestion or internal jobs as an app user", async () => {
    await expect(as(ownerA, `select ingest_punches('x', '{}', 'x')`)).rejects.toThrow(/permission denied/);
    await expect(as(ownerA, `select attendance_tick()`)).rejects.toThrow(/permission denied/);
  });

  it("OTP and device secrets are not readable by app users", async () => {
    expect(await as(ownerA, `select * from otp_codes`)).toHaveLength(0);
    expect(await as(ownerA, `select * from device_secrets`)).toHaveLength(0);
  });
});

describe("role permissions inside a company (§4 matrix)", () => {
  it("an employee sees only their own employee record, but the whole directory", async () => {
    const own = await as<{ id: string }>(staffA, `select id from employees`);
    expect(own.map((r) => r.id)).toEqual([empStaffA]);
    const dir = await as(staffA, `select * from employee_directory`);
    expect(dir).toHaveLength(3);
  });

  it("a manager sees their direct reports", async () => {
    const rows = await as<{ id: string }>(managerA, `select id from employees order by first_name`);
    expect(rows.map((r) => r.id)).toContain(empStaffA);
    expect(rows.map((r) => r.id)).not.toContain(empA);
  });

  it("an employee may edit contact fields but not job or bank fields", async () => {
    await as(staffA, `update employees set phone = '98480 22338' where id = $1`, [empStaffA]);
    await expect(as(staffA, `update employees set ifsc = 'HDFC0000001' where id = $1`, [empStaffA])).rejects.toThrow(/can't change these fields/);
  });

  it("an employee cannot see salary structures or run payroll", async () => {
    expect(await as(staffA, `select * from salary_structures`)).toHaveLength(0);
    await expect(as(staffA, `select run_payroll($1, '2026-10-01')`, [companyA])).rejects.toThrow(/not allowed/);
  });

  it("only a manager or HR can approve leave (when the Leave feature is enabled)", async () => {
    await db.query(`update platform_features set enabled = true where feature = 'leave'`);
    const [lt] = await sys<{ id: string }>(ownerA, `select id from leave_types where company_id = $1 and code = 'CL'`, [companyA]);
    const [lr] = await as<{ id: string }>(staffA, `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date)
      values ($1, $2, $3, '2026-11-02', '2026-11-02') returning id`, [companyA, empStaffA, lt.id]);
    await expect(as(staffA, `update leave_requests set status = 'approved' where id = $1`, [lr.id])).rejects.toThrow(/manager or HR/);
    await as(managerA, `update leave_requests set status = 'approved' where id = $1`, [lr.id]);
    const [r] = await sys<{ status: string }>(ownerA, `select status from leave_requests where id = $1`, [lr.id]);
    expect(r.status).toBe("approved");
    await db.query(`update platform_features set enabled = false where feature = 'leave'`);
  });

  it("chat messages are visible only to conversation members", async () => {
    const [{ open_dm: dm }] = await as<{ open_dm: string }>(staffA, `select open_dm($1, $2)`, [companyA, managerA]);
    await as(staffA, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'hi')`, [dm, companyA]);
    expect(await as(managerA, `select * from messages where conversation_id = $1`, [dm])).toHaveLength(1);
    expect(await as(ownerA, `select * from messages where conversation_id = $1`, [dm])).toHaveLength(0);
    await expect(as(ownerB, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'x')`, [dm, companyA]))
      .rejects.toThrow(/row-level security/);
  });

  it("tasks: an employee sees tasks they created or are assigned to", async () => {
    const [t] = await as<{ id: string }>(ownerA, `insert into tasks (company_id, title, created_by) values ($1, 'Secret', $2) returning id`, [companyA, ownerA]);
    expect(await as(staffA, `select * from tasks where id = $1`, [t.id])).toHaveLength(0);
    await as(ownerA, `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [t.id, empStaffA, companyA]);
    expect(await as(staffA, `select * from tasks where id = $1`, [t.id])).toHaveLength(1);
    const notes = await as(staffA, `select * from notifications where title = 'New task assigned'`);
    expect(notes).toHaveLength(1);
  });
});
