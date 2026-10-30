// On-site work only (decision of 30 Oct 2026, migration 0054): no work from home and no mobile punch.
// Attendance comes from the biometric device; past work-from-home history is kept.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {};
const E: Record<string, string> = {};
let cid: string;
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const OFF = /on site only/;

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "hr", "ravi"]) U[who] = await createUser(db, `${who}@w.in`);
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'W') returning id`, [U.owner]);
  for (const [who, role] of [["hr", "hr"], ["ravi", "employee"]] as const) {
    [{ id: E[who] }] = await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, email, date_of_joining)
      values ($1, $2, $3, $4, '2025-01-01') returning id`, [cid, U[who], who, `${who}@w.in`]);
    await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, U[who], role]);
  }
});

describe("no work from home and no mobile punch (0054)", () => {
  it("nobody can be made eligible to work from home or punch from a phone", async () => {
    await expect(sys(`update employees set wfh_eligible = true where id = $1`, [E.ravi])).rejects.toThrow(/employees_on_site_only/);
    await expect(sys(`update employees set mobile_attendance = true where id = $1`, [E.ravi])).rejects.toThrow(/employees_on_site_only/);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, wfh_eligible) values ($1, 'x', 'x@w.in', '2025-01-01', true)`, [cid]))
      .rejects.toThrow(/employees_on_site_only/);
  });

  it("asking for, assigning, checking in and mobile punching are all refused", async () => {
    await expect(as("ravi", `select request_wfh($1, current_date + 1, 'Plumber visit')`, [cid])).rejects.toThrow();
    expect(await as("hr", `select assign_wfh($1, current_date, current_date + 5, $2, null, null, null, null) n`, [cid, E.ravi])).toEqual([{ n: 0 }]);   // nobody is eligible
    await expect(as("ravi", `select wfh_check_in($1, null, 'phone', null, null)`, [cid])).rejects.toThrow();
    await expect(as("ravi", `select mobile_punch($1, 17.44, 78.34, null)`, [cid])).rejects.toThrow();
    for (const [t, cols, vals] of [
      ["wfh_days", "company_id, employee_id, date, status, source", `$1, $2, current_date, 'approved', 'hr'`],
      ["work_sessions", "company_id, employee_id, date, started_at", `$1, $2, current_date, now()`],
      ["punches_raw", "company_id, employee_id, device_user_id, punched_at, source", `$1, $2, '17', now(), 'mobile'`],
    ]) await expect(sys(`insert into ${t} (${cols}) values (${vals})`, [cid, E.ravi]), t).rejects.toThrow(OFF);
    expect(await sys(`select * from wfh_days`)).toHaveLength(0);
  });

  it("device punches still work", async () => {
    await sys(`insert into punches_raw (company_id, employee_id, device_user_id, punched_at, source) values ($1, $2, '17', now(), 'device')`, [cid, E.ravi]);
    expect(await sys(`select source from punches_raw where employee_id = $1`, [E.ravi])).toEqual([{ source: "device" }]);
  });

  it("a correction to 'work from home' is refused", async () => {
    await expect(as("ravi", `insert into regularisations (company_id, employee_id, date, kind, reason) values ($1, $2, current_date - 1, 'wfh', 'x')`, [cid, E.ravi]))
      .rejects.toThrow(/Work from home isn't enabled/);
  });
});
