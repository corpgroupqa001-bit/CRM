// What each role is shown and may export, from the permissions the server returns (my_access),
// fed through the same NAV / EXPORT_PERMISSION rules the app uses. One account per role.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";
import { EXPORT_PERMISSION, NAV } from "../src/lib/rbac";

let db: PGlite;
let cid: string;
const perms: Record<string, Set<string>> = {};
const ROLES = ["owner", "company_admin", "hr", "manager", "employee", "super_admin"] as const;

beforeAll(async () => {
  db = await createDb();
  const ids: Record<string, string> = {};
  for (const r of ROLES) ids[r] = await createUser(db, `${r}@ui.in`);
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'UI') returning id`, [ids.owner])).rows;
  for (const r of ROLES.filter((r) => !["owner", "super_admin"].includes(r))) {
    await db.query(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, ids[r], r]);
  }
  await db.query(`insert into platform_admins (user_id) values ($1)`, [ids.super_admin]);
  // OI-13: the Super Admin enters a company only while support access is granted
  await db.query(`insert into support_access (company_id, granted_by, reason, expires_at) values ($1, $2, 'test', now() + interval '1 hour')`, [cid, ids.company_admin]);
  for (const r of ROLES) {
    const { rows: [{ a }] } = await asUser(db, ids[r], () => db.query<{ a: { allowed: boolean; role: string; permissions: string[] } }>(`select my_access($1) a`, [cid]));
    expect(a.allowed).toBe(true);
    expect(a.role).toBe(r);
    perms[r] = new Set(a.permissions);
  }
});

const nav = (r: string) => NAV.filter((n) => n.show(perms[r])).map((n) => n.label);
const canExport = (r: string, report: string) => perms[r].has(EXPORT_PERMISSION[report]);

describe("navigation per role (BRD v2.0 §5.3)", () => {
  it("Employee: own work only, including Leave and My payslips", () => {
    const items = nav("employee");
    for (const hidden of ["Employees", "Attendance", "Payroll", "Settings"]) expect(items).not.toContain(hidden);
    for (const shown of ["Dashboard", "My attendance", "Leave", "My payslips", "Tasks", "Chat"]) expect(items).toContain(shown);
  });

  it("Manager: team employees and attendance, tasks, own payslips; no Payroll or Settings", () => {
    const items = nav("manager");
    for (const hidden of ["Payroll", "Settings"]) expect(items).not.toContain(hidden);
    for (const shown of ["Employees", "Attendance", "Tasks", "Chat", "My payslips"]) expect(items).toContain(shown);
  });

  it("HR / Payroll: Payroll (prepare), Employees, Attendance, Tasks, Leave and Settings (read)", () => {
    for (const shown of ["Payroll", "Employees", "Attendance", "Tasks", "Leave", "Settings"]) expect(nav("hr")).toContain(shown);
    expect(perms.hr.has("salaries.manage")).toBe(true);
    expect(perms.hr.has("salaries.approve")).toBe(false);
    expect(perms.hr.has("settings.manage")).toBe(false);
  });

  it("Owner, Company Admin and Super Admin (with support access) see every module", () => {
    for (const r of ["owner", "company_admin", "super_admin"]) {
      for (const shown of ["Employees", "Attendance", "Payroll", "Tasks", "Chat", "Settings", "Leave"]) expect(nav(r), r).toContain(shown);
    }
  });
});

describe("actions and exports per role", () => {
  it("add employee, invite, assign roles, run and approve payroll go to the BRD roles", () => {
    const pick = (p: string) => ROLES.filter((r) => perms[r].has(p));
    expect(pick("employees.create")).toEqual(["owner", "company_admin", "hr", "super_admin"]);
    expect(pick("employees.account")).toEqual(["owner", "company_admin", "hr", "super_admin"]);      // AUTH-04: HR invites
    expect(pick("employees.assign_role")).toEqual(["owner", "company_admin", "super_admin"]);
    expect(pick("salaries.manage")).toEqual(["hr"]);                                                   // HR / Payroll prepares
    expect(pick("salaries.approve")).toEqual(["owner", "company_admin"]);                              // SAL-09
    expect(pick("attendance.manage")).toEqual(["company_admin", "hr", "super_admin"]);                 // Owner: Attendance R
    expect(pick("settings.manage")).toEqual(["company_admin", "super_admin"]);
  });

  it("payroll exports: none for Employee or Manager; HR / Payroll has the bank file; Owner and Admin the reports", () => {
    for (const r of ["employee", "manager"]) for (const rep of ["salary-register", "bank-file", "pf-ecr", "journal", "form16"]) expect(canExport(r, rep), `${r} ${rep}`).toBe(false);
    expect(canExport("hr", "bank-file")).toBe(true);
    expect(canExport("owner", "salary-register")).toBe(true);
    expect(canExport("owner", "bank-file")).toBe(false);
    expect(canExport("employee", "employees")).toBe(false);
    expect(canExport("manager", "projects")).toBe(false);
  });
});
