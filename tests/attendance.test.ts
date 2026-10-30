import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { addAdmin, asOwnerUser, createDb, createUser } from "./db";

let db: PGlite;
let owner: string;
let company: string;
let device: { device_id: string; hmac_secret: string; api_key: string };

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  asOwnerUser(db, owner, async () => (await db.query<T>(sql, params)).rows);
// the device endpoint runs with the service role, i.e. with no end-user identity
const svc = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

const sign = (body: string, secret = device.hmac_secret) => createHmac("sha256", secret).update(body).digest("hex");
const ingest = (body: object, sig?: string) => {
  const raw = JSON.stringify(body);
  return svc<{ ingest_punches: Record<string, number> }>(
    `select ingest_punches('SN-001', $1, $2)`, [raw, sig ?? sign(raw)]).then((r) => r[0].ingest_punches);
};
const day = (emp: string, d: string) =>
  q<Record<string, string>>(`select * from daily_attendance where employee_id = $1 and date = $2`, [emp, d]).then((r) => r[0]);

/** a date two days ahead in IST, so the shift is still "in progress" for the live-status check */
const futureDate = () => {
  let t = Date.now() + 2 * 86400000 + 5.5 * 3600000;
  while (new Date(new Date(t).toISOString().slice(0, 10) + "T00:00:00Z").getUTCDay() === 0) t += 86400000;  // skip the Sunday weekly off
  return new Date(t).toISOString().slice(0, 10);
};

let emp: string;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@acme.in");
  [{ id: company }] = await q<{ id: string }>(
    `insert into companies (owner_id, name, weekly_offs) values ($1, 'Acme', '{0}') returning id`, [owner]);
  owner = await addAdmin(db);   // devices and attendance: the Admin (BRD §5.3; the Super Admin, 0055)
  await q(`update shifts set grace_min = 0 where company_id = $1`, [company]);   // 09:00–18:00, 0 min grace
  [{ id: emp }] = await q<{ id: string }>(
    `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Ravi', 'ravi@acme.in', '2025-01-01') returning id`,
    [company]);
  const [r] = await q<{ register_device: typeof device }>(
    `select register_device($1, null, 'Front door', 'SN-001', 'ZKTeco', 'K40', null, 'push')`, [company]);
  device = r.register_device;
});

describe("device ingestion (ATT-02/04/05/06/07)", () => {
  it("rejects a bad signature and an unknown device", async () => {
    await expect(ingest({ punches: [] }, "deadbeef")).rejects.toThrow(/bad signature/);
    await expect(svc(`select ingest_punches('NOPE', '{}', 'x')`)).rejects.toThrow(/unknown device/);
  });

  it("accepts a per-device API key instead of a signature", async () => {
    const r = await svc<{ ingest_punches: { received: number } }>(
      `select ingest_punches('SN-001', '{"punches":[]}', null, $1)`, [device.api_key]);
    expect(r[0].ingest_punches.received).toBe(0);
  });

  it("queues unmapped device users, then maps them and back-fills their punches", async () => {
    const r = await ingest({ punches: [{ device_user_id: "17", timestamp: "2026-10-01 09:00:00" }] });
    expect(r).toMatchObject({ accepted: 1, unmapped: 1 });
    const queued = await q(`select * from punches_raw where employee_id is null`);
    expect(queued).toHaveLength(1);
    const [m] = await q<{ map_device_user: number }>(`select map_device_user($1, '17', $2)`, [device.device_id, emp]);
    expect(m.map_device_user).toBe(1);
    expect(await q(`select * from punches_raw where employee_id is null`)).toHaveLength(0);
  });

  it("ignores duplicate punches (idempotent) and keeps raw punches immutable", async () => {
    const body = { punches: [{ device_user_id: "17", timestamp: "2026-10-01 18:05:00" }] };
    expect(await ingest(body)).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(await ingest(body)).toMatchObject({ accepted: 0, duplicates: 1 });
    await expect(q(`update punches_raw set punched_at = now()`)).rejects.toThrow(/immutable/);
    await expect(q(`delete from punches_raw`)).rejects.toThrow(/immutable/);
  });

  it("computes the day from first-in / last-out", async () => {
    const a = await day(emp, "2026-10-01");
    expect(a.status).toBe("present");
    expect(Number(a.worked_minutes)).toBe(9 * 60 + 5 - 60);   // 09:00–18:05 less 60 min break
    const [d] = await q<{ status: string }>(`select status from devices where id = $1`, [device.device_id]);
    expect(d.status).toBe("online");
  });

  it("BRD acceptance: a 09:02 punch with 0 min grace is Late on the live view", async () => {
    const d = futureDate();
    await ingest({ punches: [{ device_user_id: "17", timestamp: `${d} 09:02:00` }] });
    const a = await day(emp, d);
    expect(a.status).toBe("late");
    expect(Number(a.late_minutes)).toBe(2);
  });

  it("a single punch on a finished day is a missed punch; regularisation fixes it and keeps the original", async () => {
    await ingest({ punches: [{ device_user_id: "17", timestamp: "2026-10-05 09:00:00" }] });
    expect((await day(emp, "2026-10-05")).status).toBe("missed_punch");
    const [reg] = await q<{ id: string }>(
      `insert into regularisations (company_id, employee_id, date, out_time, reason)
       values ($1, $2, '2026-10-05', '18:00', 'Forgot to punch out') returning id`, [company, emp]);
    await q(`update regularisations set status = 'approved' where id = $1`, [reg.id]);
    const a = await day(emp, "2026-10-05");
    expect(a.status).toBe("present");
    expect(a.source).toBe("regularised");
    const raw = await q(`select source from punches_raw where employee_id = $1 and punched_at::date = '2026-10-05' order by punched_at`, [emp]);
    expect(raw.map((x) => x.source)).toEqual(["device", "regularisation"]);
  });

  it("ATT-11: the third late mark in a month becomes a half-day", async () => {
    for (const d of ["2026-10-06", "2026-10-07", "2026-10-08"]) {
      await ingest({ punches: [{ device_user_id: "17", timestamp: `${d} 09:30:00` }, { device_user_id: "17", timestamp: `${d} 19:00:00` }] });
    }
    expect((await day(emp, "2026-10-06")).status).toBe("late");
    expect((await day(emp, "2026-10-07")).status).toBe("late");
    const third = await day(emp, "2026-10-08");
    expect(third.status).toBe("half_day");
    expect(third.late_conversion).toBe(true);
  });

  it("handles a night shift that crosses midnight", async () => {
    const [s] = await q<{ id: string }>(
      `insert into shifts (company_id, name, start_time, end_time, grace_min, break_min) values ($1, 'Night', '22:00', '06:00', 0, 0) returning id`,
      [company]);
    await q(`update employees set shift_id = $1 where id = $2`, [s.id, emp]);
    await ingest({ punches: [{ device_user_id: "17", timestamp: "2026-10-13 21:55:00" }, { device_user_id: "17", timestamp: "2026-10-14 06:10:00" }] });
    const a = await day(emp, "2026-10-13");
    expect(a.status).toBe("present");
    expect(Number(a.worked_minutes)).toBe(8 * 60 + 15);
    expect(Number(a.ot_minutes)).toBe(15);
    await q(`update employees set shift_id = null where id = $1`, [emp]);
  });

  it("month lock blocks changes until an admin unlocks with a reason", async () => {
    await q(`select lock_attendance_month($1, '2026-10-01')`, [company]);
    await expect(q(`select set_attendance_status($1, '2026-10-02', 'present', 'x')`, [emp])).rejects.toThrow(/locked/);
    await expect(q(`select unlock_attendance_month($1, '2026-10-01', '')`, [company])).rejects.toThrow(/reason/);
    await q(`select unlock_attendance_month($1, '2026-10-01', 'Late regularisation')`, [company]);
    const log = await q(`select * from audit_log where table_name = 'attendance_locks' and action = 'unlock'`);
    expect(log).toHaveLength(1);
  });

  it("mobile punch is switched off: attendance is on site only (decision of 30 Oct, 0054)", async () => {
    const user = await createUser(db, "ravi@acme.in");
    await q(`update employees set user_id = $1 where id = $2`, [user, emp]);
    await expect(q(`update employees set mobile_attendance = true where id = $1`, [emp])).rejects.toThrow(/employees_on_site_only/);
    await q(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee')`, [company, user]);
    const asRavi = <T>(sql: string, p: unknown[]) => asOwnerUser(db, user, async () => (await db.query<T>(sql, p)).rows);
    await expect(asRavi(`select mobile_punch($1, 17.4401, 78.3490, null)`, [company])).rejects.toThrow();
  });
});

describe("leave", () => {
  it("checks balance, excludes weekly offs, and approval marks the day On Leave", async () => {
    const [sl] = await q<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'SL'`, [company]);
    // SL quota 6: Mon 19 – Sun 25 Oct is 6 working days (Sunday excluded)
    const [r] = await q<{ id: string; days: string }>(
      `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date)
       values ($1, $2, $3, '2026-10-19', '2026-10-25') returning id, days`, [company, emp, sl.id]);
    expect(Number(r.days)).toBe(6);
    await expect(q(`insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date)
       values ($1, $2, $3, '2026-10-26', '2026-10-26')`, [company, emp, sl.id])).rejects.toThrow(/Insufficient SL/);
    await q(`update leave_requests set status = 'approved' where id = $1`, [r.id]);
    expect((await day(emp, "2026-10-20")).status).toBe("on_leave");
  });
});
