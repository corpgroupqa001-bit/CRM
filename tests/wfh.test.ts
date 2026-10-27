// Work from home (BRD v2.0 ATT-20 to ATT-35, migration 0030) against the real migrations.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {};
const E: Record<string, string> = {};
let cid: string, dept: string, otherDept: string;
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const today = async () => (await sys<{ d: string }>(`select wfh_today($1)::text d`, [cid]))[0].d;
const status = async (who: string) => (await as<{ s: Record<string, unknown> }>(who, `select wfh_status($1) s`, [cid]))[0].s;

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "hr", "manager", "ravi", "sita", "field"]) U[who] = await createUser(db, `${who}@w.in`);
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name, weekly_offs) values ($1, 'W', '{}') returning id`, [U.owner]);
  await sys(`update shifts set start_time = '09:00', end_time = '18:00', grace_min = 0, full_day_hours = 8, half_day_hours = 4 where company_id = $1`, [cid]);
  [{ id: dept }] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'Engineering') returning id`, [cid]);
  [{ id: otherDept }] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'Shop floor') returning id`, [cid]);
  for (const [who, role, eligible, d] of [["hr", "hr", false, dept], ["manager", "manager", false, dept], ["ravi", "employee", true, dept], ["sita", "employee", true, dept], ["field", "employee", false, otherDept]] as const) {
    [{ id: E[who] }] = await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, email, date_of_joining, wfh_eligible, department_id)
      values ($1, $2, $3, $4, '2025-01-01', $5, $6) returning id`, [cid, U[who], who, `${who}@w.in`, eligible, d]);
    await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, U[who], role]);
  }
  await sys(`update employees set reporting_manager_id = $1 where id in ($2, $3)`, [E.manager, E.ravi, E.field]);
});

describe("ATT-20/21: requesting and assigning work-from-home days", () => {
  it("only eligible employees request; their manager approves; others can't", async () => {
    const d = await today();
    await expect(as("field", `select request_wfh($1, $2::date, 'Doctor visit')`, [cid, d])).rejects.toThrow(/isn't enabled/);
    const [{ id }] = await as<{ id: string }>("ravi", `select request_wfh($1, $2::date, 'Plumber at home') id`, [cid, d]);
    expect(await sys(`select title from notifications where user_id = $1`, [U.manager])).toEqual([{ title: "Work from home request" }]);
    await expect(as("sita", `select decide_wfh($1, true, null)`, [id])).rejects.toThrow(/not allowed/);
    await as("manager", `select decide_wfh($1, true, 'OK')`, [id]);
    expect(await sys(`select status from wfh_days where id = $1`, [id])).toEqual([{ status: "approved" }]);
    await expect(as("ravi", `select request_wfh($1, '2020-01-01', 'x')`, [cid])).rejects.toThrow(/today or a future date/);
  });

  it("HR assigns a range for a department: eligible people only, chosen weekdays, every other week", async () => {
    await expect(as("ravi", `select assign_wfh($1, '2027-01-04', '2027-01-31', null, $2, null, '{1,3}', true)`, [cid, dept])).rejects.toThrow(/not allowed/);
    const [{ n }] = await as<{ n: number }>("hr", `select assign_wfh($1, '2027-01-04', '2027-01-31', null, $2, null, '{1,3}', true) n`, [cid, dept]);
    // Mondays and Wednesdays in weeks 1 and 3 from 4 Jan 2027 (4, 6, 18, 20 Jan) for Ravi and Sita; HR and the manager aren't eligible
    expect(n).toBe(8);
    expect((await sys<{ date: string }>(`select date::text from wfh_days where employee_id = $1 and date >= '2027-01-01' order by date`, [E.sita])).map((r) => r.date))
      .toEqual(["2027-01-04", "2027-01-06", "2027-01-18", "2027-01-20"]);
    expect(await sys(`select * from wfh_days where employee_id = $1`, [E.field])).toHaveLength(0);
  });
});

describe("ATT-23/27/28/32/33: check-in, breaks, check-out on the server clock", () => {
  it("checks in only on an approved day, once at a time; a missing photo is accepted and flagged", async () => {
    await expect(as("sita", `select wfh_check_in($1, null, 'Chrome', null, null)`, [cid])).rejects.toThrow(/approved work-from-home day/);
    await as("ravi", `select wfh_check_in($1, null, 'Chrome on Android', 17.4, 78.4)`, [cid]);
    await expect(as("ravi", `select wfh_check_in($1, null, 'Chrome', null, null)`, [cid])).rejects.toThrow(/already checked in/);
    const [s] = await sys<{ photo_missing_in: boolean; lat: number | null; ended_at: string | null }>(`select photo_missing_in, lat, ended_at from work_sessions where employee_id = $1`, [E.ravi]);
    expect(s).toEqual({ photo_missing_in: true, lat: null, ended_at: null });   // GPS isn't captured unless the company turns it on (ATT-24)
    await expect(as("ravi", `select wfh_check_in($1, $2, 'x', null, null)`, [cid, `${cid}/${E.sita}/x.jpg`])).rejects.toThrow();
  });

  it("breaks pause the timer; several sessions add up; nothing can be written directly", async () => {
    await as("ravi", `select wfh_break($1, true)`, [cid]);
    expect((await status("ravi")).state).toBe("break");
    await expect(as("ravi", `select wfh_break($1, true)`, [cid])).rejects.toThrow(/already on a break/);
    await as("ravi", `select wfh_break($1, false)`, [cid]);
    await as("ravi", `select wfh_check_out($1, $2)`, [cid, `${cid}/${E.ravi}/out.jpg`]);
    await as("ravi", `select wfh_check_in($1, $2, 'x', null, null)`, [cid, `${cid}/${E.ravi}/in2.jpg`]);
    expect(Number((await status("ravi")).sessions)).toBe(2);
    await expect(as("ravi", `insert into work_sessions (company_id, employee_id, date, started_at) values ($1, $2, current_date, now() - interval '9 hours')`, [cid, E.ravi]))
      .rejects.toThrow(/row-level security/);
    await expect(as("ravi", `update work_sessions set started_at = now() - interval '9 hours' returning id`)).resolves.toHaveLength(0);
  });

  it("the BRD example: 09:05 check-in and a 40-minute break show 4 h 15 m worked at 14:00, break separate", async () => {
    // a closed session from 09:05 to 14:00 with a 40-minute break, measured by the same server function
    await sys(`insert into wfh_days (company_id, employee_id, date, status, source) values ($1, $2, '2026-10-20', 'approved', 'hr')`, [cid, E.sita]);
    const [{ id }] = await sys<{ id: string }>(`insert into work_sessions (company_id, employee_id, date, started_at, ended_at, end_reason)
      values ($1, $2, '2026-10-20', '2026-10-20 09:05+05:30', '2026-10-20 14:00+05:30', 'checkout') returning id`, [cid, E.sita]);
    await sys(`insert into work_breaks (company_id, session_id, employee_id, started_at, ended_at) values ($1, $2, $3, '2026-10-20 12:00+05:30', '2026-10-20 12:40+05:30')`, [cid, id, E.sita]);
    const [w] = await sys<{ worked: number; on_break: number }>(`select * from wfh_seconds($1, '2026-10-20')`, [E.sita]);
    expect(w).toEqual({ worked: (4 * 60 + 15) * 60, on_break: 40 * 60 });
    await sys(`select compute_attendance_day($1, '2026-10-20')`, [E.sita]);
    const [d] = await sys<{ status: string; late: boolean; worked_minutes: number }>(`select status, late, worked_minutes from daily_attendance where employee_id = $1 and date = '2026-10-20'`, [E.sita]);
    expect(d).toEqual({ status: "half_day", late: true, worked_minutes: 255 });   // 4 h 15 m: half-day threshold met, late after 09:00 + 0 grace
  });

  it("ATT-32: the status follows total worked hours across sessions", async () => {
    const [{ id }] = await sys<{ id: string }>(`insert into work_sessions (company_id, employee_id, date, started_at, ended_at, end_reason)
      values ($1, $2, '2026-10-20', '2026-10-20 15:00+05:30', '2026-10-20 19:00+05:30', 'checkout') returning id`, [cid, E.sita]);
    expect(id).toBeTruthy();
    await sys(`select compute_attendance_day($1, '2026-10-20')`, [E.sita]);
    expect(await sys(`select status, worked_minutes from daily_attendance where employee_id = $1 and date = '2026-10-20'`, [E.sita]))
      .toEqual([{ status: "wfh", worked_minutes: 495 }]);                                  // 8 h 15 m → a full payable day
  });
});

describe("ATT-31: forgotten check-out", () => {
  it("closes at the last recorded activity, raises the day and tells employee and manager", async () => {
    await as("ravi", `select wfh_check_out($1, null)`, [cid]);                               // today's session from the tests above
    await sys(`insert into wfh_days (company_id, employee_id, date, status, source) values ($1, $2, '2026-10-21', 'approved', 'hr')`, [cid, E.ravi]);
    const [{ id }] = await sys<{ id: string }>(`insert into work_sessions (company_id, employee_id, date, started_at)
      values ($1, $2, '2026-10-21', '2026-10-21 09:05+05:30') returning id`, [cid, E.ravi]);
    await sys(`insert into work_breaks (company_id, session_id, employee_id, started_at, ended_at) values ($1, $2, $3, '2026-10-21 13:00+05:30', '2026-10-21 13:30+05:30')`, [cid, id, E.ravi]);
    await sys(`delete from notifications`);
    expect(await sys<{ n: number }>(`select wfh_auto_close() n`)).toEqual([{ n: 1 }]);
    const [s] = await sys<{ ended: string; end_reason: string }>(`select to_char(ended_at at time zone 'Asia/Kolkata', 'HH24:MI') ended, end_reason from work_sessions where id = $1`, [id]);
    expect(s).toEqual({ ended: "13:30", end_reason: "auto" });                             // last activity: the end of the break
    expect((await sys<{ user_id: string }>(`select user_id from notifications order by user_id`)).map((r) => r.user_id).sort()).toEqual([U.ravi, U.manager].sort());
    expect(await sys(`select status from daily_attendance where employee_id = $1 and date = '2026-10-21'`, [E.ravi])).toEqual([{ status: "absent" }]);   // 3 h 55 m < half day
  });
});

describe("ATT-25/30: who sees work-from-home figures", () => {
  it("the manager and HR see the live board; employees see only their own", async () => {
    const mine = await as<{ full_name: string }>("manager", `select * from wfh_live($1)`, [cid]);
    expect(mine.map((r) => r.full_name)).toEqual(["ravi"]);                                  // today's approved WFH, own team
    expect((await as("hr", `select * from wfh_live($1)`, [cid])).length).toBeGreaterThanOrEqual(1);
    await expect(as("sita", `select * from wfh_live($1)`, [cid])).rejects.toThrow(/not allowed/);
    expect(await as("sita", `select * from work_sessions where employee_id = $1`, [E.ravi])).toHaveLength(0);
    expect((await as("manager", `select * from work_sessions where employee_id = $1`, [E.ravi])).length).toBeGreaterThan(0);
  });
});
