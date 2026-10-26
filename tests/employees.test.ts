// Migration 0012: employees integrity (EMP-03/04/05) on the real SQL.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let ownerA: string, ownerB: string, cidA: string, cidB: string, branchB: string, deptB: string;

const as = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asOwnerUser(db, uid, async () => (await db.query<T>(sql, p)).rows);
const add = (fields: Record<string, unknown>) => {
  const row = { company_id: cidA, first_name: "Asha", email: `asha${Math.random().toString(36).slice(2, 7)}@a.in`, date_of_joining: "2025-01-01", ...fields };
  const cols = Object.keys(row);
  return as<{ id: string; emp_code: string }>(ownerA, `insert into employees (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id, emp_code`, Object.values(row));
};

beforeAll(async () => {
  db = await createDb();
  ownerA = await createUser(db, "a@a.in");
  ownerB = await createUser(db, "b@b.in");
  [{ id: cidA }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'A') returning id`, [ownerA])).rows;
  [{ id: cidB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'B') returning id`, [ownerB])).rows;
  [{ id: branchB }] = await sys<{ id: string }>(ownerB, `insert into branches (company_id, name) values ($1, 'B-HQ') returning id`, [cidB]);
  [{ id: deptB }] = await sys<{ id: string }>(ownerB, `select id from departments where company_id = $1 limit 1`, [cidB]);
});

describe("employees table (EMP-01 … EMP-07)", () => {
  it("has company_id NOT NULL and RLS enabled", async () => {
    const [t] = await sys<{ rls: boolean; nullable: string }>(ownerA, `select c.relrowsecurity as rls,
      (select is_nullable from information_schema.columns where table_name = 'employees' and column_name = 'company_id') as nullable
      from pg_class c where c.relname = 'employees'`);
    expect(t).toEqual({ rls: true, nullable: "NO" });
  });

  it("stores full personal, job and statutory details and auto-generates the code", async () => {
    const [mgr] = await add({ first_name: "Manager" });
    const [e] = await add({
      last_name: "Rao", phone: "+91 98480 22338", dob: "1994-03-12", gender: "Female", address: "Hyderabad",
      emergency_name: "Ravi Rao", emergency_phone: "9848022339", reporting_manager_id: mgr.id, probation_end: "2025-07-01",
      employment_type: "full_time", uan: "100912345678", esi_no: "3100123456", ifsc: "HDFC0001234",
      pan_enc: "iv.tag.data", pan_last4: "234F", aadhaar_enc: "iv.tag.data", aadhaar_last4: "9012", bank_account_enc: "iv.tag.data", bank_last4: "4321",
    });
    expect(e.emp_code).toMatch(/^EMP\d{4}$/);
  });

  it("rejects branch, department or manager from another company", async () => {
    await expect(add({ branch_id: branchB })).rejects.toThrow(/Branch belongs to a different company/);
    await expect(add({ department_id: deptB })).rejects.toThrow(/Department belongs to a different company/);
    const [other] = await sys<{ id: string }>(ownerB, `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Bob', 'bob@b.in', '2025-01-01') returning id`, [cidB]);
    await expect(add({ reporting_manager_id: other.id })).rejects.toThrow(/Reporting manager belongs to a different company/);
  });

  it("prevents reporting loops", async () => {
    const [a] = await add({ first_name: "LoopA" });
    const [b] = await add({ first_name: "LoopB", reporting_manager_id: a.id });
    await expect(as(ownerA, `update employees set reporting_manager_id = $1 where id = $2`, [b.id, a.id])).rejects.toThrow(/loop/);
    await expect(as(ownerA, `update employees set reporting_manager_id = id where id = $1`, [a.id])).rejects.toThrow();
  });

  it.each([
    [{ uan: "12345" }, /employees_uan_format/],
    [{ esi_no: "31-001" }, /employees_esi_format/],
    [{ ifsc: "hdfc0001234" }, /employees_ifsc_format/],
    [{ pan_enc: "x", pan_last4: "1234" }, /employees_pan_last4_format/],
    [{ pan_last4: "234F" }, /employees_pan_pair/],
    [{ email: "not-an-email" }, /employees_email_format/],
    [{ gender: "F" }, /employees_gender_values/],
    [{ dob: "2030-01-01" }, /employees_dob_range/],
    [{ probation_end: "2024-01-01" }, /employees_probation_after_joining/],
  ])("rejects invalid data %j", async (fields, err) => {
    await expect(add(fields)).rejects.toThrow(err);
  });

  it("treats email as unique per company regardless of case, but allows it in another company", async () => {
    await add({ email: "Same.Person@a.in" });
    await expect(add({ email: "same.person@A.in" })).rejects.toThrow(/duplicate key/);
    await sys(ownerB, `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Same', 'same.person@a.in', '2025-01-01')`, [cidB]);
  });

  it("keeps RLS: another company's owner cannot read or add employees here", async () => {
    expect(await as(ownerB, `select * from employees where company_id = $1`, [cidA])).toHaveLength(0);
    await expect(as(ownerB, `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'X', 'x@x.in', '2025-01-01')`, [cidA]))
      .rejects.toThrow(/row-level security/);
  });
});
