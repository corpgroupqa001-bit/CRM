// Custom roles (BRD v2.0 §5.2, migration 0037): the Owner copies a default role, renames it and ticks module
// permissions (the Company Admin role was removed on 30 Oct, 0051); a person on that role gets exactly the
// ticked permissions.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { PERMISSION_GROUPS } from "../src/lib/rbac";
import { addMember, asUser, createDb, createUser } from "./db";

let db: PGlite;
let cid: string, cidB: string, owner: string, hr: string, ravi: string, ravi2: string;

const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, who, async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const access = async (who: string) =>
  (await as<{ a: { role: string; custom_role?: string; permissions: string[] } }>(who, `select my_access($1) a`, [cid]))[0].a;
const clone = async (who: string, name: string, from: string | null, fromCustom: string | null = null) =>
  (await as<{ id: string }>(who, `select clone_role($1, $2, $3, $4) id`, [cid, name, from, fromCustom]))[0].id;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@corp.in");
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner]);
  [{ id: cidB }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [owner]);
  hr = await addMember(db, cid, "hr@corp.in", "hr");
  ravi = await addMember(db, cid, "ravi@corp.in", "employee");
  ravi2 = await addMember(db, cid, "ravi2@corp.in", "employee");
  for (const [u, e] of [[ravi, "ravi@corp.in"], [ravi2, "ravi2@corp.in"]]) {
    await sys(`insert into employees (company_id, first_name, email, date_of_joining, user_id, invite_role) values ($1, 'R', $2, '2025-01-01', $3, 'employee')`, [cid, e, u]);
  }
}, 120000);

describe("§5.2 · who manages custom roles", () => {
  it("the Owner copies roles (decision of 27 Oct, 0039); HR (Settings R) can't", async () => {
    expect(await clone(owner, "Admin's copy", "manager")).toBeTruthy();
    expect(await clone(owner, "Owner's copy", "employee")).toBeTruthy();
    await expect(clone(hr, "HR copy", "hr")).rejects.toThrow(/Only the Owner or the Admin can manage roles/);
    expect((await access(owner)).permissions).toContain("roles.manage");
  });

  it("the Owner and Super Admin roles can't be copied, and names are unique per company", async () => {
    await expect(clone(owner, "Boss", "owner")).rejects.toThrow(/Choose a role to copy/);
    await expect(clone(owner, "admin's COPY ", "employee")).rejects.toThrow(/already exists/);
    expect(await as(owner, `select clone_role($1, 'Admin''s copy', 'employee', null)`, [cidB])).toHaveLength(1);   // other company: fine
  });

  it("roles can't be written directly, only through the functions", async () => {
    await expect(as(owner, `insert into company_roles (company_id, name, base_role) values ($1, 'Sneaky', 'hr')`, [cid])).rejects.toThrow();
  });
});

describe("§5.2 · a custom role's ticked permissions are what the person gets", () => {
  let sup: string;

  it("a copy starts with the permissions of the role it was copied from", async () => {
    sup = await clone(owner, "Security Supervisor", "hr");
    const copied = (await sys<{ permission: string }>(`select permission from company_role_permissions where role_id = $1 order by 1`, [sup])).map((r) => r.permission);
    const hrPerms = (await sys<{ permission: string }>(`select permission from role_permissions where role = 'hr' order by 1`)).map((r) => r.permission);
    expect(copied).toEqual(hrPerms);
  });

  it("unticking salaries hides payroll; the person keeps the base role's name for role-based rules", async () => {
    const keep = (await sys<{ permission: string }>(`select permission from company_role_permissions where role_id = $1`, [sup]))
      .map((r) => r.permission).filter((p) => !p.startsWith("salaries."));
    await as(owner, `select save_role($1, 'Security Supervisor', $2)`, [sup, keep]);
    await as(owner, `update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [sup, cid, ravi]);
    const a = await access(ravi);
    expect(a.role).toBe("hr");
    expect(a.custom_role).toBe("Security Supervisor");
    expect(a.permissions).toContain("attendance.manage");
    expect(a.permissions).not.toContain("salaries.read");
    expect(await as(ravi, `select has_perm($1, 'salaries.read') ok`, [cid])).toEqual([{ ok: false }]);
    expect(await as(ravi, `select * from salary_structures where company_id = $1`, [cid])).toHaveLength(0);
    expect((await as(hr, `select * from salary_structures where company_id = $1`, [cid])).length).toBeGreaterThan(0);   // real HR still sees them
  });

  it("ticking a permission the base role doesn't have grants it", async () => {
    const cur = (await sys<{ permission: string }>(`select permission from company_role_permissions where role_id = $1`, [sup])).map((r) => r.permission);
    await as(owner, `select save_role($1, 'Security Supervisor', $2)`, [sup, [...cur, "audit.read", "settings.manage"]]);
    expect(await as(ravi, `select has_perm($1, 'settings.manage') ok`, [cid])).toEqual([{ ok: true }]);
  });

  it("every permission in the database has a tick box on the Roles screen, and no box is for a missing one", async () => {
    const db_ = (await sys<{ p: string }>(`select assignable_permissions() p`)).map((r) => r.p).sort();
    const ui = PERMISSION_GROUPS.flatMap((g) => g.perms.map(([p]) => p as string)).sort();
    expect(ui).toEqual(db_);
  });

  it("only real permissions can be ticked", async () => {
    await expect(as(owner, `select save_role($1, 'Security Supervisor', array['salaries.read','everything.all'])`, [sup])).rejects.toThrow(/Unknown permission everything.all/);
  });

  it("the change is in the audit log", async () => {
    expect((await sys(`select 1 from audit_log where table_name = 'company_roles' and record_id = $1 and action = 'permissions'`, [sup])).length).toBeGreaterThan(0);
  });

  it("someone holding a role that manages roles can't untick it for themselves", async () => {
    const mgr = await clone(owner, "Role keeper", "hr");
    await as(owner, `select save_role($1, 'Role keeper', array['settings.read','roles.manage'])`, [mgr]);
    await as(owner, `update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [mgr, cid, hr]);
    await expect(as(hr, `select save_role($1, 'Role keeper', array['settings.read'])`, [mgr])).rejects.toThrow(/keep "Manage roles" ticked/);
    await as(owner, `update company_members set custom_role_id = null, role = 'hr' where company_id = $1 and user_id = $2`, [cid, hr]);
  });
});

describe("§5.2 · assigning and removing custom roles", () => {
  it("changing the system role on the Job tab takes the person off the custom role", async () => {
    const lite = await clone(owner, "Lite HR", "hr");
    await as(owner, `update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [lite, cid, ravi2]);
    expect((await sys<{ invite_role: string }>(`select invite_role from employees where user_id = $1`, [ravi2]))[0].invite_role).toBe("hr");
    await as(owner, `update employees set invite_role = 'manager' where user_id = $1`, [ravi2]);
    expect(await sys(`select role, custom_role_id from company_members where company_id = $1 and user_id = $2`, [cid, ravi2]))
      .toEqual([{ role: "manager", custom_role_id: null }]);
  });

  it("a role from another company can't be given, and the Owner can't be put on a custom role", async () => {
    const [{ id: foreign }] = await sys<{ id: string }>(`select id from company_roles where company_id = $1`, [cidB]);
    await expect(as(owner, `update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [foreign, cid, ravi2])).rejects.toThrow(/another company/);
    const [{ id: any }] = await sys<{ id: string }>(`select id from company_roles where company_id = $1 limit 1`, [cid]);
    await expect(sys(`update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [any, cid, owner])).rejects.toThrow(/Owner/);
  });

  it("a role still held can't be deleted; once nobody holds it, it can", async () => {
    const [{ id: sup }] = await sys<{ id: string }>(`select id from company_roles where company_id = $1 and name = 'Security Supervisor'`, [cid]);
    await expect(as(owner, `select delete_role($1)`, [sup])).rejects.toThrow(/1 person still has this role/);
    await as(owner, `update company_members set custom_role_id = null, role = 'employee' where company_id = $1 and user_id = $2`, [cid, ravi]);
    expect((await access(ravi)).permissions).not.toContain("attendance.manage");
    await as(owner, `select delete_role($1)`, [sup]);
    expect(await sys(`select 1 from company_roles where id = $1`, [sup])).toHaveLength(0);
  });

  it("a custom role can be given an Admin-only permission such as Settings (0055)", async () => {
    const withSettings = await clone(owner, "HR with settings", "hr");
    const cur = (await sys<{ permission: string }>(`select permission from company_role_permissions where role_id = $1`, [withSettings])).map((r) => r.permission);
    await as(owner, `select save_role($1, 'HR with settings', $2)`, [withSettings, [...cur, "settings.manage", "attendance.unlock"]]);
    const u = await addMember(db, cid, "hr2@corp.in", "hr");
    await sys(`update company_members set custom_role_id = $1 where company_id = $2 and user_id = $3`, [withSettings, cid, u]);
    expect(await as(u, `select has_perm($1, 'settings.manage') ok`, [cid])).toEqual([{ ok: true }]);
  });
});

describe("view and edit every role (decision of 27 Oct 2026, migration 0038)", () => {
  const perms = async (who: string) => (await access(who)).permissions;

  it("editing a default role changes it for this company only", async () => {
    const mgr = await addMember(db, cid, "mgr@corp.in", "manager");
    const mgrB = await addMember(db, cidB, "mgrb@corp.in", "manager");
    expect(await perms(mgr)).toContain("attendance.approve");
    const cur = await perms(mgr);
    await as(owner, `select save_default_role($1, 'manager', $2)`, [cid, cur.filter((p) => p !== "attendance.approve" && !p.startsWith("feature."))]);
    expect(await perms(mgr)).not.toContain("attendance.approve");
    expect(await as(mgr, `select has_perm($1, 'attendance.approve') ok`, [cid])).toEqual([{ ok: false }]);
    const b = (await asUser(db, mgrB, async () => (await db.query<{ a: { permissions: string[] } }>(`select my_access($1) a`, [cidB])).rows[0].a));
    expect(b.permissions).toContain("attendance.approve");   // the other company keeps the standard Manager
  });

  it("a copy of an edited default role starts from this company's version", async () => {
    const id = await clone(owner, "Shift lead", "manager");
    expect((await sys(`select 1 from company_role_permissions where role_id = $1 and permission = 'attendance.approve'`, [id]))).toHaveLength(0);
  });

  it("Reset to standard puts the original ticks back", async () => {
    await as(owner, `select reset_default_role($1, 'manager')`, [cid]);
    const [{ id: mgr }] = await sys<{ id: string }>(`select id from auth.users where email = 'mgr@corp.in'`);
    expect(await perms(mgr)).toContain("attendance.approve");
    expect((await sys(`select action from audit_log where table_name = 'company_default_roles' order by at`)).map((r) => r.action)).toEqual(["permissions", "reset"]);
  });

  it("the Owner edits; HR can't, and the Owner role can't be edited", async () => {
    await as(owner, `select save_default_role($1, 'employee', array['chat.use','tasks.use'])`, [cid]);
    await as(owner, `select reset_default_role($1, 'employee')`, [cid]);
    await expect(as(hr, `select save_default_role($1, 'employee', array['chat.use'])`, [cid])).rejects.toThrow(/Only the Owner or the Admin can change roles/);
    await expect(as(owner, `select save_default_role($1, 'owner', array['chat.use'])`, [cid])).rejects.toThrow(/Owner role can't be changed/);
    await expect(as(owner, `insert into company_default_roles (company_id, role, permissions) values ($1, 'hr', '{}')`, [cid])).rejects.toThrow();
  });

  it("there is no Company Admin role to edit, copy or give (decision of 30 Oct, 0051)", async () => {
    await expect(as(owner, `select save_default_role($1, 'company_admin', array['settings.read'])`, [cid])).rejects.toThrow();
    await expect(clone(owner, "Old admin", "company_admin")).rejects.toThrow(/Choose a role to copy/);
    await expect(sys(`update company_members set role = 'company_admin' where company_id = $1 and user_id = $2`, [cid, ravi2])).rejects.toThrow(/company_members_role_check/);
    expect(await sys(`select 1 from role_permissions where role = 'company_admin'`)).toHaveLength(0);
  });
});
