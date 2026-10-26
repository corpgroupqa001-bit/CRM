// What each role is shown and may export, from the permissions the server returns (my_access),
// fed through the same NAV / EXPORT_PERMISSION rules the app uses. One account per role.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";
import { EXPORT_PERMISSION, NAV } from "../src/lib/rbac";

let db: PGlite;
let cid: string;
const perms: Record<string, Set<string>> = {};
const ROLES = ["owner", "company_admin", "hr", "finance", "manager", "employee", "super_admin"] as const;

beforeAll(async () => {
  db = await createDb();
  const ids: Record<string, string> = {};
  for (const r of ROLES) ids[r] = await createUser(db, `${r}@ui.in`);
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'UI') returning id`, [ids.owner])).rows;
  for (const r of ROLES.filter((r) => !["owner", "super_admin"].includes(r))) {
    await db.query(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, ids[r], r]);
  }
  await db.query(`insert into platform_admins (user_id) values ($1)`, [ids.super_admin]);
  for (const r of ROLES) {
    const { rows: [{ a }] } = await asUser(db, ids[r], () => db.query<{ a: { allowed: boolean; role: string; permissions: string[] } }>(`select my_access($1) a`, [cid]));
    expect(a.allowed).toBe(true);
    expect(a.role).toBe(r);
    perms[r] = new Set(a.permissions);
  }
});

const nav = (r: string) => NAV.filter((n) => n.show(perms[r])).map((n) => n.label);
const canExport = (r: string, report: string) => perms[r].has(EXPORT_PERMISSION[report]);

describe("navigation per role", () => {
  it("Employee: no Employees, Attendance admin, Payroll, payslips, Projects-admin or Leave", () => {
    const items = nav("employee");
    for (const hidden of ["Employees", "Attendance", "Payroll", "My payslips", "Leave", "Settings"]) expect(items).not.toContain(hidden);
    for (const shown of ["Dashboard", "My attendance", "Tasks", "Chat"]) expect(items).toContain(shown);
  });

  it("Manager: team employees and attendance, tasks and projects, no Payroll", () => {
    const items = nav("manager");
    expect(items).not.toContain("Payroll");
    for (const shown of ["Employees", "Attendance", "Tasks", "Chat"]) expect(items).toContain(shown);
  });

  it("HR: Payroll (view), Employees, Attendance, Tasks, Settings", () => {
    for (const shown of ["Payroll", "Employees", "Attendance", "Tasks", "Settings"]) expect(nav("hr")).toContain(shown);
    expect(perms.hr.has("salaries.manage")).toBe(false);
  });

  it("Finance: Payroll and pay fields, but no Tasks or Projects", () => {
    const items = nav("finance");
    expect(items).toContain("Payroll");
    expect(items).toContain("Employees");
    expect(items).not.toContain("Tasks");
    expect(items).not.toContain("Projects");
  });

  it("Administrator and Super Admin see every module; Leave stays hidden while the feature is off", () => {
    for (const r of ["owner", "company_admin", "super_admin"]) {
      for (const shown of ["Employees", "Attendance", "Payroll", "Tasks", "Chat", "Settings"]) expect(nav(r), r).toContain(shown);
      expect(nav(r)).not.toContain("Projects");   // removed from the Collaboration menu
      expect(nav(r)).not.toContain("Leave");
    }
  });
});

describe("actions and exports per role", () => {
  it("Add employee and Run payroll appear only for the roles that may use them", () => {
    const addEmployee = ROLES.filter((r) => perms[r].has("employees.create"));
    expect(addEmployee).toEqual(["owner", "company_admin", "hr", "super_admin"]);     // HR creates records (0024); invite / role stay admin
    const runPayroll = ROLES.filter((r) => perms[r].has("salaries.manage"));
    expect(runPayroll).toEqual(["owner", "company_admin", "finance", "super_admin"]);
    const approve = ROLES.filter((r) => perms[r].has("salaries.approve"));
    expect(approve).toEqual(["owner", "company_admin", "finance"]);
  });

  it("payroll exports: none for Employee or Manager; HR read-only reports; bank file for Finance / Administrator", () => {
    for (const r of ["employee", "manager"]) for (const rep of ["salary-register", "bank-file", "pf-ecr", "journal", "form16"]) expect(canExport(r, rep), `${r} ${rep}`).toBe(false);
    expect(canExport("hr", "salary-register")).toBe(true);
    expect(canExport("hr", "bank-file")).toBe(false);
    expect(canExport("finance", "bank-file")).toBe(true);
    expect(canExport("finance", "employees")).toBe(false);
    expect(canExport("employee", "employees")).toBe(false);
    expect(canExport("manager", "projects")).toBe(false);
  });
});
