// Decision of 27 Oct 2026 (migration 0042): every employee sees who is in today as Present / Not in yet,
// never the reason (absent, leave, late), and only for their own company.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite, cid: string, cidB: string;
const U: Record<string, string> = {}, E: Record<string, string> = {};
const today = async () => (await db.query<{ d: string }>(`select (now() at time zone 'Asia/Kolkata')::date::text d`)).rows[0].d;

beforeAll(async () => {
  db = await createDb();
  for (const w of ["owner", "ravi", "sita", "manoj", "hema", "outsider"]) U[w] = await createUser(db, `${w}@corp.in`);
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [U.owner])).rows;
  [{ id: cidB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [U.outsider])).rows;
  for (const w of ["ravi", "sita", "manoj", "hema"]) {
    await db.query(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee')`, [cid, U[w]]);
    [{ id: E[w] }] = (await db.query<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining, user_id) values ($1, $2, $3, '2025-01-01', $4) returning id`,
      [cid, w, `${w}@corp.in`, U[w]])).rows;
  }
  const d = await today();
  for (const [w, s] of [["ravi", "late"], ["sita", "on_leave"], ["manoj", "absent"], ["hema", "wfh"]]) {
    await db.query(`insert into daily_attendance (company_id, employee_id, date, status) values ($1, $2, $3, $4)`, [cid, E[w], d, s]);
  }
}, 120000);

const list = (who: string, c = cid) => asUser(db, U[who], async () =>
  (await db.query<{ full_name: string; present: boolean; me: boolean }>(`select * from who_is_in($1)`, [c])).rows);

describe("who's in today", () => {
  it("an employee sees colleagues as present or not, nothing more", async () => {
    const rows = await list("sita");
    expect(rows.map((r) => [r.full_name, r.present])).toEqual([["hema", true], ["ravi", true], ["manoj", false], ["sita", false]]);
    expect(Object.keys(rows[0]).sort()).toEqual(["emp_code", "employee_id", "full_name", "me", "photo_url", "present"]);
    expect(rows.find((r) => r.me)?.full_name).toBe("sita");
  });
  it("late counts as in; leave and absent both read as not in, with no reason", async () => {
    const rows = await list("manoj");
    expect(rows.find((r) => r.full_name === "ravi")?.present).toBe(true);
    expect(rows.find((r) => r.full_name === "sita")?.present).toBe(false);
    expect(rows.find((r) => r.full_name === "manoj")?.present).toBe(false);
  });
  it("someone from another company gets nothing", async () => {
    expect(await list("outsider")).toEqual([]);
    expect(await list("ravi", cidB)).toEqual([]);
  });
  it("an employee still can't read colleagues' attendance records", async () => {
    const rows = await asUser(db, U.sita, async () => (await db.query(`select * from daily_attendance where employee_id = $1`, [E.ravi])).rows);
    expect(rows).toHaveLength(0);
  });
});
