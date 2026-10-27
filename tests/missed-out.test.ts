// ATT-36 (migration 0029): an in-punch without an out-punch becomes a missed punch once the shift is over
// plus the company grace; it is unpaid until regularised and the employee is told once.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createDb, createUser } from "./db";

let db: PGlite;
let cid: string, emp: string, user: string;
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const status = async (d: string) => (await sys<{ status: string }>(`select status from daily_attendance where employee_id = $1 and date = $2`, [emp, d]))[0]?.status;

beforeAll(async () => {
  db = await createDb();
  const owner = await createUser(db, "owner@m.in");
  user = await createUser(db, "ravi@m.in");
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name, weekly_offs) values ($1, 'M', '{0}') returning id`, [owner]);
  await sys(`update shifts set start_time = '09:00', end_time = '18:00', grace_min = 0 where company_id = $1`, [cid]);
  [{ id: emp }] = await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Ravi', 'ravi@m.in', '2025-01-01') returning id`, [cid, user]);
  await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee')`, [cid, user]);
});

describe("missed check-out (ATT-36)", () => {
  it("defaults to a 2-hour grace, configurable per company", async () => {
    expect((await sys<{ g: number }>(`select missed_out_grace_hours g from companies where id = $1`, [cid]))[0].g).toBe(2);
    await expect(sys(`update companies set missed_out_grace_hours = 13 where id = $1`, [cid])).rejects.toThrow(/check/);
  });

  it("a past day with only an in-punch is a missed punch, unpaid, and the employee is notified once", async () => {
    await sys(`insert into punches_raw (company_id, employee_id, punched_at, source) values ($1, $2, '2026-10-06 09:02+05:30', 'mobile')`, [cid, emp]);
    await sys(`select compute_attendance_day($1, '2026-10-06')`, [emp]);
    expect(await status("2026-10-06")).toBe("missed_punch");
    const [{ pay }] = await sys<{ pay: string }>(`select payable_map ->> 'missed_punch' pay from companies where id = $1`, [cid]);
    expect(Number(pay)).toBe(0);
    await sys(`select compute_attendance_day($1, '2026-10-06')`, [emp]);   // the per-minute job runs again
    const notes = await sys<{ title: string; body: string; link: string; kind: string }>(`select title, body, link, kind from notifications where user_id = $1`, [user]);
    expect(notes).toEqual([{ title: "Missed check-out", body: "06 Oct 2026: only one punch was recorded. Request a correction so the day is paid.", link: "/attendance/me", kind: "attendance" }]);
  });

  it("with both punches the day is computed normally and nobody is notified", async () => {
    await sys(`insert into punches_raw (company_id, employee_id, punched_at, source) values ($1, $2, '2026-10-07 09:00+05:30', 'mobile'), ($1, $2, '2026-10-07 18:05+05:30', 'mobile')`, [cid, emp]);
    await sys(`select compute_attendance_day($1, '2026-10-07')`, [emp]);
    expect(await status("2026-10-07")).toBe("present");
    expect(await sys(`select * from notifications where user_id = $1 and body like '07 Oct%'`, [user])).toHaveLength(0);
  });
});
