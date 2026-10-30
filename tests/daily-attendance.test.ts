// calculate_daily_attendance() — BRD ATT-09, on the real migrations (PGlite).
// Run just this file:  pnpm test tests/daily-attendance.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addAdmin, asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let owner: string, cid: string, device: string;
const emps: Record<string, string> = {};
const DAY = "2026-10-21";   // a Wednesday: not a weekly off, no holiday

// as the device endpoint does: raw punch, not yet linked to an employee
const punch = (deviceUserId: string, localTime: string) =>
  db.query(`insert into punches_raw (company_id, device_id, device_user_id, punched_at, source)
            values ($1, $2, $3, ($4::timestamp at time zone 'Asia/Kolkata'), 'device')`, [cid, device, deviceUserId, `${DAY} ${localTime}`]);

const calculate = () => asOwnerUser(db, owner, async () =>
  (await db.query<{ emp_code: string; employee_name: string; status: string; late_minutes: number; worked_minutes: number }>(
    `select * from calculate_daily_attendance($1, $2)`, [cid, DAY])).rows);
const statusOf = async (name: string) => (await calculate()).find((r) => r.employee_name === name)!;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@acme.in");
  cid = (await asOwnerUser(db, owner, () => db.query<{ id: string }>(
    `insert into companies (owner_id, name, weekly_offs) values ($1, 'Acme', '{0}') returning id`, [owner]))).rows[0].id;
  owner = await addAdmin(db);   // devices and attendance: the Admin (BRD §5.3; the Super Admin, 0055)
  // the standard shift from the BRD example: 09:00–18:00, 0 minutes grace
  await db.query(`update shifts set start_time = '09:00', end_time = '18:00', grace_min = 0 where company_id = $1`, [cid]);
  device = (await asOwnerUser(db, owner, () => db.query<{ r: { device_id: string } }>(
    `select register_device($1, null, 'Main gate', 'ZK-1', 'ZKTeco', 'K40', null, 'push') as r`, [cid]))).rows[0].r.device_id;

  for (const [name, devUser] of [["Late Lata", "101"], ["Prompt Priya", "102"], ["Absent Arjun", "103"]]) {
    emps[name] = (await db.query<{ id: string }>(
      `insert into employees (company_id, first_name, last_name, email, date_of_joining) values ($1, $2, $3, $4, '2025-01-01') returning id`,
      [cid, name.split(" ")[0], name.split(" ")[1], `${devUser}@acme.in`])).rows[0].id;
    // EMP-06 mapping, inserted directly so the punches below arrive unmapped and the function must map them
    await db.query(`insert into device_user_map (company_id, device_id, device_user_id, employee_id) values ($1, $2, $3, $4)`,
      [cid, device, devUser, emps[name]]);
  }
});

describe("calculate_daily_attendance (ATT-09)", () => {
  it("injected 09:02 punch → Late (09:00 shift, 0 min grace)", async () => {
    await punch("101", "09:02:00");
    await punch("101", "18:10:00");
    const r = await statusOf("Late Lata");
    expect(r.status).toBe("late");
    expect(r.late_minutes).toBe(2);
  });

  it("maps device_user_id to the employee on the raw punches", async () => {
    const rows = (await db.query<{ employee_id: string | null }>(`select employee_id from punches_raw where device_user_id = '101'`)).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.employee_id === emps["Late Lata"])).toBe(true);
  });

  it("08:58 punch → Present", async () => {
    await punch("102", "08:58:00");
    await punch("102", "18:05:00");
    expect((await statusOf("Prompt Priya")).status).toBe("present");
  });

  it("no punch → Absent", async () => {
    expect((await statusOf("Absent Arjun")).status).toBe("absent");
  });

  it("returns every employee employed on the date, with worked minutes", async () => {
    const rows = await calculate();
    expect(rows.map((r) => r.employee_name).sort()).toEqual(["Absent Arjun", "Late Lata", "Prompt Priya"]);
    expect(rows.find((r) => r.employee_name === "Late Lata")!.worked_minutes).toBe(9 * 60 + 8 - 60);   // 09:02–18:10 less the 60-min break
  });

  it("with the default 10-minute grace, the same 09:02 punch is Present", async () => {
    await db.query(`update shifts set grace_min = 10 where company_id = $1`, [cid]);
    expect((await statusOf("Late Lata")).status).toBe("present");
    await db.query(`update shifts set grace_min = 0 where company_id = $1`, [cid]);
    expect((await statusOf("Late Lata")).status).toBe("late");
  });

  it("is only callable by HR / admin / owner of that company", async () => {
    const outsider = await createUser(db, "outsider@x.in");
    await expect(asUser(db, outsider, () => db.query(`select * from calculate_daily_attendance($1, $2)`, [cid, DAY]))).rejects.toThrow(/not allowed/);
  });
});
