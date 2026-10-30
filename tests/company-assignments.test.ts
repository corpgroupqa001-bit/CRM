// One person, several companies (0023): the Super Admin assigns an existing person to other companies,
// each with its own department, designation, manager, role and status, against the real migrations.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";
import { switcherCompanies } from "../src/lib/company-switcher";

let db: PGlite;
const U: Record<string, string> = {};
const C: string[] = [];                      // five companies
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const access = async (who: string, cid: string) =>
  (await as<{ a: { allowed: boolean; role?: string; reason?: string } }>(who, `select my_access($1) a`, [cid]))[0].a;
const assign = (who: string, user: string, cid: string, role: string, dept: string | null = null, desig: string | null = null, mgr: string | null = null) =>
  as<{ id: string }>(who, `select sa_assign_company($1, $2, $3, $4, $5, $6, '2026-11-01') id`, [user, cid, role, dept, desig, mgr]);

beforeAll(async () => {
  db = await createDb();
  for (const who of ["sa", "owner", "person", "adminA", "other"]) U[who] = await createUser(db, `${who}@corp.in`);
  await sys(`update profiles set full_name = 'Priya Sharma' where id = $1`, [U.person]);
  await sys(`insert into platform_admins (user_id) values ($1)`, [U.sa]);
  for (const n of ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]) {
    C.push((await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, $2) returning id`, [U.owner, n]))[0].id);
  }
  // the person starts in Alpha only, with sensitive data and a salary there
  await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee'), ($1, $3, 'hr')`, [C[0], U.person, U.adminA]);
  await sys(`insert into employees (company_id, user_id, first_name, last_name, email, phone, date_of_joining, pan_enc, pan_last4)
             values ($1, $2, 'Priya', 'Sharma', 'person@corp.in', '98480 22338', '2025-01-01', 'ENCRYPTED', '123F')`, [C[0], U.person]);
  await sys(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Admin', 'adminA@corp.in', '2025-01-01')`, [C[0], U.adminA]);
});

describe("assigning one person to several companies", () => {
  it("assigns to one more company, reusing the same login and copying no sensitive data", async () => {
    const [{ id }] = await assign("sa", U.person, C[1], "hr");
    const [e] = await sys<Record<string, unknown>>(`select * from employees where id = $1`, [id]);
    expect(e).toMatchObject({ user_id: U.person, company_id: C[1], first_name: "Priya", last_name: "Sharma", email: "person@corp.in",
      phone: "98480 22338", pan_enc: null, pan_last4: null, bank_account_enc: null, status: "active", date_of_joining: new Date("2026-11-01") });
    expect(await sys(`select * from employee_ctc where employee_id = $1`, [id])).toHaveLength(0);       // no salary copied
    expect(await sys(`select count(*)::int n from auth.users where email = 'person@corp.in'`)).toEqual([{ n: 1 }]);   // one identity
  });

  it("can cover all five companies, each with its own role", async () => {
    await assign("sa", U.person, C[2], "manager");
    await assign("sa", U.person, C[3], "employee");
    await assign("sa", U.person, C[4], "employee");
    const rows = await as<{ company_id: string; role: string; is_active: boolean }>("sa", `select * from sa_person_assignments($1)`, [U.person]);
    expect(rows.filter((r) => r.is_active)).toHaveLength(5);
    expect(await access("person", C[0])).toMatchObject({ allowed: true, role: "employee" });
    expect(await access("person", C[1])).toMatchObject({ allowed: true, role: "hr" });
    expect(await access("person", C[4])).toMatchObject({ allowed: true, role: "employee" });
  });

  it("never creates a duplicate record in the same company", async () => {
    await assign("sa", U.person, C[1], "hr");                      // assigning again just updates
    expect(await sys(`select count(*)::int n from employees where company_id = $1 and user_id = $2`, [C[1], U.person])).toEqual([{ n: 1 }]);
    await expect(sys(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, 'Dup', 'dup@corp.in', '2026-01-01')`,
      [C[1], U.person])).rejects.toThrow(/duplicate|unique/i);
  });

  it("links an unlinked record HR already made with the same email instead of adding another", async () => {
    U.newbie = await createUser(db, "newbie@corp.in");
    const [{ id: hrMade }] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'New', 'NEWBIE@corp.in', '2026-01-01') returning id`, [C[2]]);
    const [{ id }] = await assign("sa", U.newbie, C[2], "employee");
    expect(id).toBe(hrMade);
  });
});

describe("company-specific details and permissions", () => {
  it("each company has its own department, designation and manager, checked against that company", async () => {
    const [dB] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'People') returning id`, [C[1]]);
    const [gB] = await sys<{ id: string }>(`insert into designations (company_id, department_id, name) values ($1, $2, 'HR Lead') returning id`, [C[1], dB.id]);
    const [dA] = await sys<{ id: string }>(`select id from departments where company_id = $1 limit 1`, [C[0]]);
    const [mgrA] = await sys<{ id: string }>(`select id from employees where user_id = $1`, [U.adminA]);
    await as("sa", `select sa_update_assignment($1, $2, 'hr', $3, $4, null, null)`, [U.person, C[1], dB.id, gB.id]);
    expect(await as("sa", `select department, designation from sa_person_assignments($1) where company_id = $2`, [U.person, C[1]]))
      .toEqual([{ department: "People", designation: "HR Lead" }]);
    await expect(as("sa", `select sa_update_assignment($1, $2, 'hr', $3, null, null, null)`, [U.person, C[1], dA.id])).rejects.toThrow(/different company/);
    await expect(as("sa", `select sa_update_assignment($1, $2, 'hr', null, null, $3, null)`, [U.person, C[1], mgrA.id])).rejects.toThrow(/different company/);
    const [dOther] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'Ops B') returning id`, [C[1]]);
    await expect(as("sa", `select sa_update_assignment($1, $2, 'hr', $3, $4, null, null)`, [U.person, C[1], dOther.id, gB.id])).rejects.toThrow(/not part of the selected department/);
  });

  it("the role in one company gives nothing in another (no payroll or records without permission there)", async () => {
    // HR in Bravo can read Bravo's employees, but in Alpha they are a plain employee: only their own record
    expect((await as("person", `select id from employees where company_id = $1`, [C[0]])).length).toBe(1);
    await sys(`insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Colleague', 'col@corp.in', '2026-01-01')`, [C[1]]);
    expect((await as("person", `select id from employees where company_id = $1`, [C[1]])).length).toBeGreaterThan(1);
    expect(await as("person", `select * from salary_structures where company_id = $1`, [C[0]])).toHaveLength(0);
    expect(await access("person", "00000000-0000-0000-0000-000000000000")).toMatchObject({ allowed: false });
  });
});

describe("deactivating and reactivating one company", () => {
  it("switching off Charlie leaves the other four untouched", async () => {
    const [{ left }] = await as<{ left: number }>("sa", `select sa_set_assignment_active($1, $2, false, 'Moved on') left`, [U.person, C[2]]);
    expect(left).toBe(4);
    expect(await access("person", C[2])).toMatchObject({ allowed: false });
    for (const i of [0, 1, 3, 4]) expect((await access("person", C[i])).allowed).toBe(true);
    expect(await sys(`select status from employees where company_id = $1 and user_id = $2`, [C[2], U.person])).toEqual([{ status: "inactive" }]);
  });

  it("reactivation restores only that company", async () => {
    await as("sa", `select sa_set_assignment_active($1, $2, true, null)`, [U.person, C[2]]);
    expect(await access("person", C[2])).toMatchObject({ allowed: true, role: "manager" });
  });

  it("history lists every assignment change, and each is in the audit log", async () => {
    const h = await as<{ action: string; company_name: string }>("sa", `select * from sa_assignment_history($1)`, [U.person]);
    const actions = h.filter((r) => ["assign", "reassign", "update", "deactivate", "reactivate"].includes(r.action)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["assign", "reassign", "update", "deactivate", "reactivate"]));
    expect(h.find((r) => r.action === "deactivate")?.company_name).toBe("Charlie");
  });
});

describe("only the Super Admin, and never on themselves", () => {
  it("company admins, the person themself and outsiders can't use these functions", async () => {
    for (const who of ["adminA", "person", "other", "owner"]) {
      await expect(assign(who, U.other, C[0], "employee")).rejects.toThrow(/Super admin only/);
      await expect(as(who, `select * from sa_person_assignments($1)`, [U.person])).rejects.toThrow(/Super admin only/);
      await expect(as(who, `select sa_set_assignment_active($1, $2, false, null)`, [U.person, C[1]])).rejects.toThrow(/Super admin only/);
    }
  });

  it("the Super Admin can't change their own access, make an owner, or switch off an owner", async () => {
    await expect(assign("sa", U.sa, C[0], "hr")).rejects.toThrow(/your own company access/);
    await expect(assign("sa", U.other, C[0], "owner")).rejects.toThrow(/access role/);
    await expect(as("sa", `select sa_set_assignment_active($1, $2, false, null)`, [U.owner, C[0]])).rejects.toThrow(/This person is not assigned|owner/);
  });

  it("nobody can make themselves Super Admin", async () => {
    await expect(as("adminA", `insert into platform_admins (user_id) values ($1)`, [U.adminA])).rejects.toThrow(/row-level security|permission/);
  });

  it("the assignments view shows only what each user may see", async () => {
    expect((await as("person", `select company_id from employee_company_assignments where user_id = $1`, [U.person])).length).toBe(5);
    expect(await as("other", `select * from employee_company_assignments where user_id = $1`, [U.person])).toHaveLength(0);
  });
});

describe("company switcher", () => {
  it("lists only companies the person can open", () => {
    const m = (id: string, role = "employee") => ({ role, companies: { id, name: id.toUpperCase() } });
    const shown = switcherCompanies([m("a"), m("b", "hr"), m("c"), m("d")], [
      { company_id: "a", status: "active", removed_at: null },
      { company_id: "b", status: "notice", removed_at: null },          // serving notice: still works there
      { company_id: "c", status: "inactive", removed_at: null },        // switched off in this company
      { company_id: "d", status: "exited", removed_at: "2026-10-01" },  // removed
    ]);
    expect(shown).toEqual([{ id: "a", name: "A", role: "employee" }, { id: "b", name: "B", role: "hr" }]);
    expect(switcherCompanies(null, null)).toEqual([]);
  });
});
