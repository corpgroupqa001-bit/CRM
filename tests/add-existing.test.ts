// Adding an existing employee to another company: keep them, or move them out of chosen companies
// (decision of 27 Oct 2026, migration 0036). Only Owners of the companies involved
// (the Company Admin role was removed on 30 Oct).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {};
const C: Record<string, string> = {};
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const emp = async (co: string, who: string, extra = "") =>
  (await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, last_name, email, phone, date_of_joining, uan${extra ? ", " + extra.split("=")[0] : ""})
    values ($1, $2, $3, 'K', $4, '98480 11111', '2025-01-01', $5${extra ? ", " + extra.split("=")[1] : ""}) returning id`, [co, U[who] ?? null, who, `${who}@x.in`, String(100200300400 + Math.floor(Math.random() * 1e6))]))[0].id;

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "adminB", "hrA", "ravi", "sita", "other"]) U[who] = await createUser(db, `${who}@x.in`);
  for (const [k, name] of [["A", "Alpha"], ["B", "Bravo"], ["X", "Xray"]]) {
    C[k] = (await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, $2) returning id`, [k === "X" ? U.other : U.owner, name]))[0].id;
  }
  await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'hr'), ($3, $4, 'hr'), ($1, $5, 'employee'), ($3, $5, 'employee'), ($3, $6, 'employee'), ($7, $6, 'employee')`,
    [C.B, U.adminB, C.A, U.hrA, U.ravi, U.sita, C.X]);
  await emp(C.A, "ravi"); await emp(C.B, "ravi"); await emp(C.A, "sita"); await emp(C.X, "sita");
});

describe("people from my other companies (0036)", () => {
  it("lists people of the companies I manage, not yet here; only for Owners", async () => {
    // a new company C2 of the same owner: Ravi (A, B) and Sita (A) are listed; Sita's Xray record isn't visible
    C.C2 = (await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Charlie') returning id`, [U.owner]))[0].id;
    const rows = await as<{ full_name: string; email: string; companies: { company: string }[] }>("owner", `select * from people_from_my_companies($1)`, [C.C2]);
    expect(rows.map((r) => r.email)).toEqual(["ravi@x.in", "sita@x.in"]);
    expect(rows[0].companies.map((c) => c.company)).toEqual(["Alpha", "Bravo"]);
    expect(rows[1].companies.map((c) => c.company)).toEqual(["Alpha"]);
    await expect(as("hrA", `select * from people_from_my_companies($1)`, [C.A])).rejects.toThrow(/not allowed/);
    await expect(as("adminB", `select * from people_from_my_companies($1)`, [C.B])).rejects.toThrow(/not allowed/);   // HR of Bravo
  });

  it("Add keeps them where they are; only basic details are copied; their login opens the new company", async () => {
    const [{ id: src }] = await sys<{ id: string }>(`select id from employees where company_id = $1 and email = 'ravi@x.in'`, [C.A]);
    const [{ id }] = await as<{ id: string }>("owner", `select add_existing_person($1, $2, 'add', null, 'manager', null, null, null, '2026-11-01') id`, [C.C2, src]);
    expect(await sys(`select first_name, phone, uan, status, invite_role from employees where id = $1`, [id]))
      .toEqual([{ first_name: "ravi", phone: "98480 11111", uan: null, status: "active", invite_role: "manager" }]);   // no UAN / PAN / bank copied
    expect(await sys(`select status from employees where email = 'ravi@x.in' and company_id in ($1, $2) order by company_id`, [C.A, C.B])).toEqual([{ status: "active" }, { status: "active" }]);
    expect((await as<{ a: { allowed: boolean; role: string } }>("ravi", `select my_access($1) a`, [C.C2]))[0].a).toMatchObject({ allowed: true, role: "manager" });
    await expect(as("owner", `select add_existing_person($1, $2, 'add', null, 'employee', null, null, null, '2026-11-01')`, [C.C2, src])).rejects.toThrow(/already works/);
  });

  it("Move leaves the chosen companies (or all) the day before, releases device IDs and access", async () => {
    const [{ id: src }] = await sys<{ id: string }>(`select id from employees where company_id = $1 and email = 'sita@x.in'`, [C.A]);
    await expect(as("adminB", `select add_existing_person($1, $2, 'move', null, 'employee', null, null, null, '2026-11-01')`, [C.B, src])).rejects.toThrow(/both companies/);
    const [{ id }] = await as<{ id: string }>("owner", `select add_existing_person($1, $2, 'move', $3, 'employee', null, null, null, '2026-11-01') id`, [C.C2, src, [C.A]]);
    expect(await sys(`select status, last_working_day::text, exit_reason from employees where id = $1`, [src]))
      .toEqual([{ status: "exited", last_working_day: "2026-10-31", exit_reason: "Moved to Charlie" }]);
    expect(await sys(`select active from company_members where company_id = $1 and user_id = $2`, [C.A, U.sita])).toEqual([{ active: false }]);
    expect(await sys(`select status from employees where company_id = $1 and email = 'sita@x.in'`, [C.X])).toEqual([{ status: "active" }]);   // Xray isn't mine: untouched
    expect((await as<{ a: { allowed: boolean } }>("sita", `select my_access($1) a`, [C.C2]))[0].a.allowed).toBe(true);
    expect((await sys<{ action: string }>(`select action from audit_log where action in ('moved_out','moved_in') order by id`)).map((r) => r.action)).toEqual(["moved_out", "moved_in"]);
    expect(id).toBeTruthy();
  });

  it("Move from all my companies, and an owner can't be moved out", async () => {
    C.D = (await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Delta') returning id`, [U.owner]))[0].id;
    const [{ id: src }] = await sys<{ id: string }>(`select id from employees where company_id = $1 and email = 'ravi@x.in'`, [C.A]);
    await as("owner", `select add_existing_person($1, $2, 'move', null, 'employee', null, null, null, '2026-12-01')`, [C.D, src]);
    expect((await sys<{ status: string }>(`select status from employees where email = 'ravi@x.in' and company_id <> $1 order by company_id`, [C.D])).every((r) => r.status === "exited")).toBe(true);
    const [{ id: ownerRec }] = await sys<{ id: string }>(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Boss', 'owner@x.in', '2025-01-01') returning id`, [C.A, U.owner]);
    await expect(as("owner", `select add_existing_person($1, $2, 'move', $3, 'employee', null, null, null, '2026-12-01')`, [C.D, ownerRec, [C.A]])).rejects.toThrow(/owner can't be moved/);
  });
});
