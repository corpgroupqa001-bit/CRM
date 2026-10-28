// NFR-12 failure alerts (migration 0045): failed ingestion, failed payroll runs and failed background jobs are
// recorded and alerted, at most once an hour per company, kind and source.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addMember, asUser, createDb, createUser } from "./db";

let db: PGlite, cid: string, cidB: string, owner: string, admin: string, hr: string, emp: string;
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const alerts = async (u: string, title: string) => (await sys<{ body: string; link: string }>(
  `select body, link from notifications where user_id = $1 and title = $2 order by created_at`, [u, title]));

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@corp.in");
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner]);
  [{ id: cidB }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [owner]);
  admin = await addMember(db, cid, "admin@corp.in", "company_admin");
  hr = await addMember(db, cid, "hr@corp.in", "hr");
  emp = await addMember(db, cid, "emp@corp.in", "employee");
  await sys(`insert into devices (company_id, name, serial_no) values ($1, 'Gate Device 1', 'SN-001')`, [cid]);
}, 120000);

describe("failed ingestion", () => {
  it("HR and the Company Admin are told; the Owner and employees aren't", async () => {
    await sys(`select record_ingest_failure('SN-001', 'the device''s key, signature or IP address was rejected')`);
    for (const u of [admin, hr]) {
      const [a] = await alerts(u, "Punches not saved");
      expect(a.body).toMatch(/^Gate Device 1: punches from this device couldn't be saved \(the device's key, signature or IP address was rejected\)/);
      expect(a.link).toBe("/attendance/devices");
    }
    for (const u of [owner, emp]) expect(await alerts(u, "Punches not saved")).toHaveLength(0);
  });
  it("is recorded every time but alerted at most once an hour", async () => {
    await sys(`select record_ingest_failure('SN-001', 'timeout')`);
    expect(await sys(`select count(*)::int n from system_failures where kind = 'ingestion'`)).toEqual([{ n: 2 }]);
    expect(await alerts(hr, "Punches not saved")).toHaveLength(1);
  });
  it("an unknown serial number is ignored", async () => {
    await sys(`select record_ingest_failure('NOT-OURS', 'x')`);
    expect(await sys(`select count(*)::int n from system_failures`)).toEqual([{ n: 2 }]);
  });
});

describe("failed payroll", () => {
  it("HR, the Company Admin and the Owner are told", async () => {
    await sys(`select record_failure($1, 'payroll', 'Oct 2026', 'division by zero')`, [cid]);
    for (const u of [owner, admin, hr]) {
      expect((await alerts(u, "Payroll run failed"))[0].body).toBe("Payroll for Oct 2026 failed: division by zero. Nothing was saved; fix the cause and run it again.");
    }
    expect(await alerts(emp, "Payroll run failed")).toHaveLength(0);
  });
  it("payroll failures are visible to payroll roles; ingestion to attendance roles; never to employees", async () => {
    const seen = async (u: string) => (await asUser(db, u, async () => (await db.query<{ kind: string }>(`select kind from system_failures order by id`)).rows)).map((r) => r.kind);
    expect(await seen(hr)).toEqual(["ingestion", "ingestion", "payroll"]);
    expect(await seen(owner)).toEqual(["payroll"]);              // Owner: Salaries R, but no attendance.manage
    expect(await seen(emp)).toEqual([]);
  });
  it("only the server can record failures", async () => {
    await expect(asUser(db, hr, () => db.query(`select record_failure($1, 'payroll', 'x', 'y')`, [cid]))).rejects.toThrow(/permission denied/);
  });
});

describe("failed background job", () => {
  it("one company's attendance job failing is recorded and alerted; the others still run", async () => {
    await sys(`update companies set timezone = 'Mars/Olympus' where id = $1`, [cid]);     // makes this company's job fail
    await sys(`select attendance_tick()`);
    const [f] = await sys<{ source: string; detail: string }>(`select source, detail from system_failures where kind = 'job' and company_id = $1`, [cid]);
    expect(f.source).toBe("Attendance calculation");
    expect(f.detail).toMatch(/time zone/);
    expect((await alerts(admin, "Background job failed"))[0].body).toMatch(/^Attendance calculation failed: .*Attendance may not be up to date\.$/);
    expect(await sys(`select * from system_failures where company_id = $1`, [cidB])).toHaveLength(0);
    await sys(`update companies set timezone = 'Asia/Kolkata' where id = $1`, [cid]);
  });
});

describe("ATT-07: a device without credentials (0046)", () => {
  it("is refused whatever key it sends (the punch webhooks then record and alert it)", async () => {
    await sys(`insert into devices (company_id, name, serial_no) values ($1, 'No-key device', 'SN-NOKEY')`, [cid]);
    const body = JSON.stringify({ device_user_id: "17", timestamp: "2026-10-28T09:00:00+05:30" });
    await expect(sys(`select ingest_punches('SN-NOKEY', $1, null, 'anything', null)`, [body])).rejects.toThrow(/device has no credentials/);
    expect(await sys(`select count(*)::int n from punches_raw`)).toEqual([{ n: 0 }]);
  });
});
