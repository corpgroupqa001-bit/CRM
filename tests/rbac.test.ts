// Role-based access control against BRD v2.0 §5.3 (default permission matrix), migrations 0018, 0019 and 0027,
// checked against the real RLS policies. Every query runs as the `authenticated` role with the user's id,
// so RLS applies exactly as in production.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {};          // auth user ids by person
const E: Record<string, string> = {};          // employee ids by person
let cid: string, cidB: string, structure: string, task: string, ownTaskForEmp: string;

const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, U[who], async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const count = async (who: string, sql: string, p: unknown[] = []) => (await as(who, sql, p)).length;
const perms = async (who: string, c = cid) =>
  (await as<{ a: { allowed: boolean; role: string; permissions: string[] } }>(who, `select my_access($1) a`, [c]))[0].a;

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "admin", "hr", "manager", "emp", "emp2", "ownerB", "sa", "outsider"]) U[who] = await createUser(db, `${who}@corp.in`);
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [U.owner])).rows;
  [{ id: cidB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [U.ownerB])).rows;
  const roles: [string, string][] = [["admin", "company_admin"], ["hr", "hr"], ["manager", "manager"], ["emp", "employee"], ["emp2", "employee"]];
  for (const who of ["owner", ...roles.map((r) => r[0])]) {
    [{ id: E[who] }] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining, user_id, ifsc)
      values ($1, $2, $3, '2025-01-01', $4, 'HDFC0000001') returning id`, [cid, who, `${who}@corp.in`, U[who]]);
  }
  for (const [who, role] of roles) await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, U[who], role]);
  await sys(`update employees set reporting_manager_id = $1 where id = $2`, [E.manager, E.emp]);   // emp reports to manager; emp2 doesn't
  [{ id: structure }] = await sys<{ id: string }>(`select id from salary_structures where company_id = $1`, [cid]);
  await sys(`insert into employee_ctc (company_id, employee_id, structure_id, annual_ctc, effective_from) values ($1, $2, $3, 360000, '2025-01-01')`, [cid, E.emp, structure]);
  // a task assigned to emp, created by the manager; one the employee has nothing to do with
  [{ id: task }] = await as<{ id: string }>("manager", `insert into tasks (company_id, title, created_by) values ($1, 'Assigned work', $2) returning id`, [cid, U.manager]);
  await as("manager", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [task, E.emp, cid]);
  [{ id: ownTaskForEmp }] = await as<{ id: string }>("owner", `insert into tasks (company_id, title, created_by) values ($1, 'Unrelated work', $2) returning id`, [cid, U.owner]);
  // a locked payroll run with a payslip for emp and emp2, and a draft run with one for the manager
  const [run] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status) values ($1, '2026-09-01', 1, 'locked') returning id`, [cid]);
  const [draft] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status) values ($1, '2026-10-01', 1, 'draft') returning id`, [cid]);
  for (const [who, r] of [["emp", run.id], ["emp2", run.id], ["manager", run.id], ["emp", draft.id]]) {
    await sys(`insert into payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days, lop_days, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
      values ($1, $2, $3, '2026-09-01', 30, 30, 30, 0, 1, 30000, 1000, 30000, 30000, 1800, 28200)`, [r, cid, E[who]]);
  }
}, 120000);

describe("§5.3 · six roles, nothing else", () => {
  it("the Finance role is retired and can't be stored", async () => {
    await expect(sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'finance')`, [cid, U.outsider])).rejects.toThrow(/company_members_role_check/);
    expect(await sys(`select distinct role from role_permissions order by role`)).toEqual(
      ["company_admin", "employee", "hr", "manager", "owner"].map((role) => ({ role })));
  });
});

describe("Super Admin (§5.3, OI-13): tenants and subscriptions, no default access to company data", () => {
  it("is never granted automatically and can't be granted through the API", async () => {
    expect(await sys(`select * from platform_admins`)).toHaveLength(0);
    for (const who of ["owner", "admin", "hr", "emp"]) expect((await as<{ v: boolean }>(who, `select is_super_admin() v`))[0].v).toBe(false);
    await expect(as("owner", `insert into platform_admins (user_id) values ($1)`, [U.owner])).rejects.toThrow(/row-level security/);
  });

  it("once granted by the operator, manages companies and their administrators", async () => {
    await sys(`insert into platform_admins (user_id, note) values ($1, 'operator')`, [U.sa]);
    const companies = await as<{ name: string }>("sa", `select * from sa_companies()`);
    expect(companies.map((c) => c.name).sort()).toEqual(["Acme", "Other"]);
    await as("sa", `select sa_set_company_admin($1, 'outsider@corp.in')`, [cidB]);
    const [m] = await sys<{ role: string; active: boolean }>(`select role, active from company_members where company_id = $1 and user_id = $2`, [cidB, U.outsider]);
    expect(m).toEqual({ role: "company_admin", active: true });
    await as("sa", `select sa_remove_company_admin($1, $2)`, [cidB, U.outsider]);
    await expect(as("sa", `select sa_remove_company_admin($1, $2)`, [cid, U.owner])).rejects.toThrow(/owner cannot be removed/);
  });

  it("sees no company data until a Company Admin grants time-limited support access", async () => {
    expect(await perms("sa")).toMatchObject({ allowed: false });
    expect(await count("sa", `select * from employees where company_id = $1`, [cid])).toBe(0);
    expect(await count("sa", `select * from payslips`)).toBe(0);
    // only a member Company Admin grants; never the Owner, HR or the Super Admin itself
    for (const who of ["owner", "hr", "sa"]) await expect(as(who, `select grant_support_access($1, 4, 'Case 1')`, [cid])).rejects.toThrow(/Only a Company Admin/);
    await expect(as("admin", `select grant_support_access($1, 100, 'Case 1')`, [cid])).rejects.toThrow(/1 and 72 hours/);
    await expect(as("admin", `select grant_support_access($1, 4, '  ')`, [cid])).rejects.toThrow(/reason/);
    const [{ g }] = await as<{ g: string }>("admin", `select grant_support_access($1, 4, 'Ticket 42: payroll export') g`, [cid]);
    expect(await sys(`select action from audit_log where table_name = 'support_access' and record_id = $1`, [g])).toEqual([{ action: "grant" }]);
    const a = await perms("sa");
    expect(a).toMatchObject({ allowed: true, role: "super_admin" });
    expect(a.permissions).not.toContain("salaries.approve");
    expect(await count("sa", `select * from employees where company_id = $1`, [cid])).toBe(6);
    expect(await count("sa", `select * from employees where company_id = $1`, [cidB])).toBe(0);   // only the granted company
    // every write is audited as super admin
    await as("sa", `update employees set probation_end = '2025-06-30' where id = $1`, [E.emp]);
    const [log] = await sys<{ via_super_admin: boolean }>(`select via_super_admin from audit_log where table_name = 'employees' and record_id = $1 order by id desc limit 1`, [E.emp]);
    expect(log.via_super_admin).toBe(true);
    // revoked → no access again
    await as("admin", `select revoke_support_access($1)`, [g]);
    expect(await perms("sa")).toMatchObject({ allowed: false });
    // an expired grant gives nothing
    await sys(`insert into support_access (company_id, granted_by, reason, expires_at) values ($1, $2, 'old', now() - interval '1 minute')`, [cid, U.admin]);
    expect(await perms("sa")).toMatchObject({ allowed: false });
  });

  it("super-admin functions refuse everyone else", async () => {
    await expect(as("owner", `select * from sa_companies()`)).rejects.toThrow(/Super admin only/);
    await expect(as("admin", `select sa_set_company_admin($1, 'emp@corp.in')`, [cid])).rejects.toThrow(/Super admin only/);
  });
});

describe("Employees row: Owner, Company Admin, HR CRUD · Manager R (team) · Employee R, U (own)", () => {
  it("employees can't create employees or change their own role or membership", async () => {
    await expect(as("emp", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'x', 'x@corp.in', '2025-01-01')`, [cid]))
      .rejects.toThrow(/row-level security/);
    await expect(as("emp", `update employees set invite_role = 'company_admin' where id = $1`, [E.emp])).rejects.toThrow(/Only an administrator/);
    expect(await count("emp", `update company_members set role = 'company_admin' where user_id = $1 returning id`, [U.emp])).toBe(0);
  });

  it("HR / Payroll adds employees, sends invitations and links logins (AUTH-04), but doesn't choose system roles", async () => {
    await as("hr", `insert into employees (company_id, first_name, email, date_of_joining, invited_at) values ($1, 'Inv', 'inv@corp.in', '2025-01-01', now())`, [cid]);
    await as("hr", `insert into employees (company_id, first_name, email, date_of_joining, user_id) values ($1, 'Link', 'outsider@corp.in', '2025-01-01', $2)`, [cid, U.outsider]);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, invite_role) values ($1, 'y', 'y@corp.in', '2025-01-01', 'company_admin')`, [cid]))
      .rejects.toThrow(/Only an administrator can choose the system role/);
    await expect(as("hr", `update employees set invite_role = 'manager' where id = $1`, [E.emp])).rejects.toThrow(/Only an administrator can change the system role/);
    expect(await count("hr", `update company_members set role = 'manager' where user_id = $1 returning id`, [U.emp])).toBe(0);
    await as("hr", `update employees set phone = '9848022338', probation_end = '2025-07-01' where id = $1`, [E.emp]);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'z', 'z@corp.in', '2025-01-01')`, [cidB]))
      .rejects.toThrow(/row-level security/);
  });

  it("the Owner and a Company Admin assign system roles, never the owner's and never their own", async () => {
    const [made] = await as<{ invite_role: string }>("owner",
      `insert into employees (company_id, first_name, email, date_of_joining, invite_role) values ($1, 'Hema', 'hema@corp.in', '2026-10-01', 'hr') returning invite_role`, [cid]);
    expect(made.invite_role).toBe("hr");
    expect(await count("admin", `update company_members set role = 'hr' where user_id = $1 returning id`, [U.emp2])).toBe(1);
    expect((await perms("emp2")).role).toBe("hr");
    await as("admin", `update company_members set role = 'employee' where user_id = $1`, [U.emp2]);
    expect(await count("admin", `update company_members set role = 'employee' where user_id = $1 returning id`, [U.owner])).toBe(0);
    expect(await count("admin", `update company_members set active = false where user_id = $1 returning id`, [U.admin])).toBe(0);
  });

  it("a system role changed on the Job tab or in Users & roles takes effect, and both stay in step (0031)", async () => {
    await as("admin", `update employees set invite_role = 'manager' where id = $1`, [E.emp2]);          // Job tab
    expect((await perms("emp2")).role).toBe("manager");
    await as("admin", `update company_members set role = 'hr' where user_id = $1 and company_id = $2`, [U.emp2, cid]);   // Users & roles
    expect(await sys(`select invite_role from employees where id = $1`, [E.emp2])).toEqual([{ invite_role: "hr" }]);
    await as("admin", `update employees set invite_role = 'employee' where id = $1`, [E.emp2]);
    expect((await perms("emp2")).role).toBe("employee");
    await expect(as("hr", `update employees set invite_role = 'manager' where id = $1`, [E.emp2])).rejects.toThrow(/Only an administrator/);
    expect((await perms("owner")).role).toBe("owner");                                                 // the owner is never changed
  });

  it("Manager reads their team; Employee reads only their own record", async () => {
    expect((await as<{ id: string }>("manager", `select id from employees`)).map((r) => r.id).sort()).toEqual([E.manager, E.emp].sort());
    expect((await as<{ id: string }>("emp", `select id from employees`)).map((r) => r.id)).toEqual([E.emp]);
  });

  it("designation grants nothing: an employee titled 'HR Manager' stays an employee", async () => {
    const [d] = await sys<{ id: string }>(`insert into designations (company_id, name) values ($1, 'HR Manager') returning id`, [cid]);
    await sys(`update employees set designation_id = $1 where id = $2`, [d.id, E.emp2]);
    expect(await count("emp2", `select * from salary_structures`)).toBe(0);
    expect(await count("emp2", `select * from employees`)).toBe(1);
  });
});

describe("Attendance row: Owner R · Company Admin, HR CRUD · Manager R, A (team) · Employee R (own)", () => {
  it("the Owner reads attendance but can't correct, lock, unlock or register devices", async () => {
    await sys(`insert into daily_attendance (company_id, employee_id, date, status) values ($1, $2, '2026-10-20', 'present'), ($1, $3, '2026-10-20', 'present')`, [cid, E.emp, E.emp2]);
    expect(await count("owner", `select * from daily_attendance`)).toBe(2);
    await expect(as("owner", `select set_attendance_status($1, '2026-10-20', 'absent', 'x')`, [E.emp])).rejects.toThrow(/not allowed/);
    await expect(as("owner", `select unlock_attendance_month($1, '2026-10-01', 'x')`, [cid])).rejects.toThrow(/company administrator/);
    await expect(as("owner", `select register_device($1, null, 'D', 'SN-O', 'ZK', 'K', null, 'push')`, [cid])).rejects.toThrow(/not allowed/);
  });

  it("HR and the Company Admin correct attendance; only the Company Admin unlocks a month", async () => {
    await as("hr", `select set_attendance_status($1, '2026-10-20', 'half_day', 'Left early')`, [E.emp2]);
    await as("admin", `select set_attendance_status($1, '2026-10-20', 'present', 'Card reader fixed')`, [E.emp2]);
    await expect(as("hr", `select unlock_attendance_month($1, '2026-10-01', 'x')`, [cid])).rejects.toThrow(/company administrator/);
    await as("admin", `select unlock_attendance_month($1, '2026-10-01', 'Late punches')`, [cid]);
  });

  it("a Manager reads and approves their team only; an Employee reads their own", async () => {
    expect((await as<{ employee_id: string }>("manager", `select employee_id from daily_attendance`)).map((r) => r.employee_id)).toEqual([E.emp]);
    expect((await as<{ employee_id: string }>("emp", `select employee_id from daily_attendance`)).map((r) => r.employee_id)).toEqual([E.emp]);
  });
});

describe("Salaries row: Owner, Company Admin R, A · HR CRUD (prepare) · Manager, Employee R (own payslip)", () => {
  const salaryTables = ["salary_structures", "salary_components", "employee_ctc", "statutory_settings", "variable_inputs", "loans", "recovery_balances", "payroll_runs"];

  it("HR / Payroll prepares payroll: structures, CTC, statutory settings and runs", async () => {
    await as("hr", `insert into salary_structures (company_id, name) values ($1, 'HR structure')`, [cid]);
    expect(await count("hr", `update statutory_settings set pf_employee_rate = 12 where company_id = $1 returning company_id`, [cid])).toBe(1);
    await expect(as("hr", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/Lock attendance/);   // passed the permission check
  });

  it("only the Owner or a Company Admin approves; the preparer can't approve their own run", async () => {
    const [r1] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status, ran_by) values ($1, '2026-08-01', 1, 'draft', $2) returning id`, [cid, U.hr]);
    await expect(as("hr", `select approve_payroll($1)`, [r1.id])).rejects.toThrow(/Only the Owner or a Company Admin/);
    await as("owner", `select approve_payroll($1)`, [r1.id]);
    expect(await sys(`select * from audit_log where action = 'approve' and record_id = $1`, [r1.id])).toHaveLength(1);
    await expect(as("hr", `select reopen_payroll($1, 'fix', '2026-08')`, [r1.id])).rejects.toThrow(/owner or a company administrator/);
    await as("admin", `select reopen_payroll($1, 'Wrong OT', '2026-08')`, [r1.id]);
    const [r2] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status, ran_by) values ($1, '2026-08-01', 2, 'draft', $2) returning id`, [cid, U.admin]);
    await expect(as("admin", `select approve_payroll($1)`, [r2.id])).rejects.toThrow(/someone else must approve/);   // maker-checker kept
    await as("owner", `select approve_payroll($1)`, [r2.id]);
  });

  it("the Owner and a Company Admin read salaries but don't prepare them", async () => {
    for (const who of ["owner", "admin"]) {
      expect(await count(who, `select * from employee_ctc`)).toBeGreaterThan(0);
      await expect(as(who, `insert into salary_structures (company_id, name) values ($1, 'x')`, [cid])).rejects.toThrow(/row-level security/);
      await expect(as(who, `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
    }
  });

  it("Employees and Managers see no salary data, only their own approved payslips (SAL-12)", async () => {
    for (const who of ["emp", "manager"]) {
      for (const t of salaryTables) expect(await count(who, `select * from ${t}`), `${who} ${t}`).toBe(0);
      await expect(as(who, `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
    }
    const mine = await as<{ employee_id: string }>("emp", `select employee_id from payslips`);
    expect(mine).toEqual([{ employee_id: E.emp }]);                         // the approved one, not the draft, not emp2's
    expect(await count("emp", `select * from payslip_lines`)).toBe(0);      // (none generated in this fixture)
    expect((await as<{ employee_id: string }>("manager", `select employee_id from payslips`)).map((r) => r.employee_id)).toEqual([E.manager]);
    expect(await count("emp", `update payslips set net_pay = 1 returning id`)).toBe(0);
  });
});

describe("Tasks row: Owner, Company Admin, HR CRUD · Manager CRUD (team) · Employee R, U (assigned), C (own)", () => {
  it("HR creates, edits and deletes tasks", async () => {
    const [{ id }] = await as<{ id: string }>("hr", `insert into tasks (company_id, title, created_by) values ($1, 'Onboard Kavya', $2) returning id`, [cid, U.hr]);
    await as("hr", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [id, E.emp2, cid]);
    expect(await count("hr", `update tasks set title = 'x' where id = $1 returning id`, [task])).toBe(1);
    expect(await count("hr", `delete from tasks where id = $1 returning id`, [id])).toBe(1);
  });

  it("an Employee works on assigned tasks and creates tasks for themselves only", async () => {
    expect((await as<{ id: string }>("emp", `select id from tasks`)).map((r) => r.id)).toEqual([task]);
    expect(await count("emp", `select * from tasks where id = $1`, [ownTaskForEmp])).toBe(0);
    expect(await count("emp", `update tasks set status = 'in_progress' where id = $1 returning id`, [task])).toBe(1);
    const [{ id: own }] = await as<{ id: string }>("emp", `insert into tasks (company_id, title, created_by) values ($1, 'Renew my ID card', $2) returning id`, [cid, U.emp]);
    await as("emp", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [own, E.emp, cid]);
    await expect(as("emp", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [own, E.emp2, cid])).rejects.toThrow(/row-level security/);
    await expect(as("emp", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [task, E.emp2, cid])).rejects.toThrow(/row-level security/);
    expect(await count("emp", `update tasks set due_at = now() where id = $1 returning id`, [own])).toBe(1);
  });

  it("a Manager manages their team's tasks, not others'", async () => {
    expect(await count("manager", `update tasks set priority = 'high' where id = $1 returning id`, [task])).toBe(1);
    expect(await count("manager", `select * from tasks where id = $1`, [ownTaskForEmp])).toBe(0);
  });
});

describe("Projects row: Owner, Company Admin CRUD · HR R · Manager R, U (projects they manage) · Employee R (member)", () => {
  let led: string, adminProject: string;
  it("only the Owner and a Company Admin create projects", async () => {
    [{ id: adminProject }] = await as<{ id: string }>("admin", `insert into projects (company_id, name) values ($1, 'Admin project') returning id`, [cid]);
    [{ id: led }] = await as<{ id: string }>("owner", `insert into projects (company_id, name, manager_id) values ($1, 'Led by manager', $2) returning id`, [cid, E.manager]);
    await expect(as("manager", `insert into projects (company_id, name, manager_id) values ($1, 'Mine', $2)`, [cid, E.manager])).rejects.toThrow(/row-level security/);
    await expect(as("hr", `insert into projects (company_id, name) values ($1, 'HR')`, [cid])).rejects.toThrow(/row-level security/);
  });

  it("a Manager updates the project they manage, nothing else; HR reads all; Employees read member projects", async () => {
    expect(await count("manager", `update projects set client = 'X' where id = $1 returning id`, [led])).toBe(1);
    expect(await count("manager", `update projects set client = 'X' where id = $1 returning id`, [adminProject])).toBe(0);
    expect(await count("hr", `select * from projects`)).toBe(2);
    expect(await count("hr", `update projects set client = 'Y' where id = $1 returning id`, [led])).toBe(0);
    expect(await count("emp", `select * from projects`)).toBe(0);
    await as("manager", `insert into project_members (project_id, employee_id, company_id) values ($1, $2, $3)`, [led, E.emp, cid]);
    expect(await count("emp", `select * from projects`)).toBe(1);
    expect(await count("emp", `update projects set client = 'Y' where id = $1 returning id`, [led])).toBe(0);
  });
});

describe("Leave row: Owner R · Company Admin, HR CRUD · Manager R, A (team) · Employee C, R (own)", () => {
  it("Leave Management is on (MVP)", async () => {
    expect((await perms("emp")).permissions).toContain("feature.leave");
    const [lt] = await sys<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'CL'`, [cid]);
    const [{ id }] = await as<{ id: string }>("emp", `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date) values ($1, $2, $3, '2026-11-02', '2026-11-02') returning id`, [cid, E.emp, lt.id]);
    await expect(as("emp", `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date) values ($1, $2, $3, '2026-11-03', '2026-11-03')`, [cid, E.emp2, lt.id]))
      .rejects.toThrow(/row-level security/);
    expect(await count("owner", `select * from leave_requests`)).toBe(1);                  // Owner: R
    expect(await count("emp2", `select * from leave_requests`)).toBe(0);
    expect(await count("manager", `update leave_requests set status = 'approved' where id = $1 returning id`, [id])).toBe(1);
  });
});

describe("Settings and audit log row: Owner R · Company Admin CRUD · HR R · Manager, Employee none", () => {
  it("only a Company Admin changes settings; the Owner also edits the company profile (Companies CRUD)", async () => {
    for (const who of ["owner", "admin", "hr"]) expect((await perms(who)).permissions, who).toContain("settings.read");
    for (const who of ["manager", "emp"]) expect((await perms(who)).permissions, who).not.toContain("settings.read");
    await as("admin", `insert into departments (company_id, name) values ($1, 'Legal')`, [cid]);
    for (const who of ["owner", "hr"]) {
      await expect(as(who, `insert into departments (company_id, name) values ($1, 'X-${who}')`, [cid])).rejects.toThrow(/row-level security/);
      await expect(as(who, `insert into branches (company_id, name) values ($1, 'B-${who}')`, [cid])).rejects.toThrow(/row-level security/);
    }
    expect(await count("owner", `update companies set legal_name = 'Acme Pvt Ltd' where id = $1 returning id`, [cid])).toBe(1);
    expect(await count("hr", `update companies set legal_name = 'x' where id = $1 returning id`, [cid])).toBe(0);
  });

  it("the audit log is readable by Owner, Company Admin and HR only", async () => {
    for (const who of ["owner", "admin", "hr"]) expect(await count(who, `select * from audit_log where company_id = $1`, [cid]), who).toBeGreaterThan(0);
    for (const who of ["manager", "emp"]) expect(await count(who, `select * from audit_log where company_id = $1`, [cid]), who).toBe(0);
  });

  it("announcements are posted by administrators and HR only (COMMS-08)", async () => {
    for (const who of ["admin", "hr"]) await as(who, `insert into announcements (company_id, title, body, created_by) values ($1, 'Hi', 'x', $2)`, [cid, U[who]]);
    for (const who of ["owner", "manager", "emp"]) await expect(as(who, `insert into announcements (company_id, title, body, created_by) values ($1, 'Hi', 'x', $2)`, [cid, U[who]])).rejects.toThrow(/row-level security/);
  });
});

describe("Tenant isolation and access loss", () => {
  it("no role reads another company's records", async () => {
    for (const who of ["owner", "admin", "hr", "manager", "emp"]) {
      for (const t of ["employees", "payroll_runs", "payslips", "salary_structures", "tasks", "daily_attendance"]) {
        expect(await count(who, `select * from ${t} where company_id = $1`, [cidB]), `${who} ${t}`).toBe(0);
      }
    }
    await expect(as("ownerB", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
  });

  it("an inactive or exited employee, or a disabled membership, loses all access", async () => {
    await sys(`update employees set status = 'inactive' where id = $1`, [E.emp2]);
    expect(await perms("emp2")).toMatchObject({ allowed: false, reason: "employee_inactive" });
    expect(await count("emp2", `select * from payslips`)).toBe(0);
    await sys(`update employees set status = 'exited', last_working_day = '2026-09-30' where id = $1`, [E.emp2]);
    expect((await perms("emp2")).allowed).toBe(false);
    await sys(`update company_members set active = false where user_id = $1`, [U.manager]);
    expect(await perms("manager")).toMatchObject({ allowed: false, reason: "membership_inactive" });
    await sys(`update company_members set active = true where user_id = $1`, [U.manager]);
    expect(await perms("outsider")).toMatchObject({ allowed: false });
  });
});

describe("Retention (NFR-09): archiving keeps statutory records for 8 years", () => {
  it("90 days after archiving only other data goes; after 8 years the company goes", async () => {
    const [{ id: co }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Archived Co') returning id`, [U.ownerB]);
    const [{ id: e }] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Old', 'old@a.in', '2020-01-01') returning id`, [co]);
    const [{ id: r }] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status) values ($1, '2026-01-01', 1, 'locked') returning id`, [co]);
    await sys(`insert into payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days, lop_days, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
      values ($1, $2, $3, '2026-01-01', 31, 31, 31, 0, 1, 30000, 967, 30000, 30000, 0, 30000)`, [r, co, e]);
    await sys(`insert into daily_attendance (company_id, employee_id, date, status) values ($1, $2, '2026-01-05', 'present')`, [co, e]);
    await sys(`insert into tasks (company_id, title, created_by) values ($1, 'Old task', $2)`, [co, U.ownerB]);
    await sys(`insert into announcements (company_id, title, body, created_by) values ($1, 'Old', 'x', $2)`, [co, U.ownerB]);
    const kept = async () => (await sys<{ n: number }>(`select (select count(*) from payslips where company_id = $1) + (select count(*) from daily_attendance where company_id = $1)
      + (select count(*) from employees where company_id = $1) + (select count(*) from payroll_runs where company_id = $1) as n`, [co]))[0].n;

    await sys(`update companies set status = 'archived', archived_at = now() - interval '91 days' where id = $1`, [co]);
    await sys(`select purge_archived_companies()`);
    expect(Number(await kept())).toBe(4);                                               // statutory records stay
    expect(await sys(`select * from tasks where company_id = $1`, [co])).toHaveLength(0);
    expect(await sys(`select * from announcements where company_id = $1`, [co])).toHaveLength(0);
    expect(await sys(`select * from company_members where company_id = $1`, [co])).toHaveLength(0);
    const [{ purged_at }] = await sys<{ purged_at: string | null }>(`select purged_at from companies where id = $1`, [co]);
    expect(purged_at).not.toBeNull();
    await sys(`select purge_archived_companies()`);                                      // running again changes nothing
    expect(Number(await kept())).toBe(4);

    await sys(`update companies set archived_at = now() - interval '8 years 1 day' where id = $1`, [co]);
    await sys(`select purge_archived_companies()`);
    expect(await sys(`select * from companies where id = $1`, [co])).toHaveLength(0);
  });
});

describe("Staff directory and employee removal", () => {
  it("the directory exposes basic details only", async () => {
    const [row] = await as<Record<string, unknown>>("emp", `select * from employee_directory limit 1`);
    for (const k of ["phone", "date_of_joining", "dob", "pan_last4", "bank_last4", "ifsc", "address", "invite_role"]) expect(row, k).not.toHaveProperty(k);
    expect(row).toHaveProperty("designation");
  });

  it("an employee with payroll history can't be deleted; one created by mistake can, by HR or an administrator", async () => {
    await expect(as("admin", `delete from employees where id = $1`, [E.emp])).rejects.toThrow(/history/);
    const [{ id }] = await as<{ id: string }>("admin", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Typo', 'typo@corp.in', '2026-10-01') returning id`, [cid]);
    expect(await count("emp", `delete from employees where id = $1 returning id`, [id])).toBe(0);
    expect(await count("hr", `delete from employees where id = $1 returning id`, [id])).toBe(1);   // HR / Payroll: Employees CRUD
    expect(await sys(`select * from audit_log where table_name = 'employees' and action = 'delete' and record_id = $1`, [id])).toHaveLength(1);
  });
});

describe("Companies (AUTH-01, COM-01): owners create their companies; employees are invited", () => {
  it("a signed-in account creates a company and becomes its Owner, with an employee record", async () => {
    U.newOwner = await createUser(db, "founder@corp.in");
    await sys(`update profiles set full_name = 'Farah Founder' where id = $1`, [U.newOwner]);
    const [{ id: co }] = await as<{ id: string }>("newOwner", `select create_company('Founder Foods') id`);
    expect(await sys(`select role from company_members where company_id = $1 and user_id = $2`, [co, U.newOwner])).toEqual([{ role: "owner" }]);
    expect(await sys(`select first_name, last_name from employees where company_id = $1 and user_id = $2`, [co, U.newOwner])).toEqual([{ first_name: "Farah", last_name: "Founder" }]);
    expect((await perms("newOwner", co))).toMatchObject({ allowed: true, role: "owner" });
    expect(await sys(`select * from audit_log where company_id = $1 and action = 'create_company'`, [co])).toHaveLength(1);
    // an owner can create several companies, each a separate tenant
    const [{ id: co2 }] = await as<{ id: string }>("newOwner", `select create_company('Founder Logistics') id`);
    expect(co2).not.toBe(co);
    expect(await count("newOwner", `select * from employees where company_id = $1`, [co2])).toBe(1);
    await expect(as("newOwner", `select create_company('  ')`)).rejects.toThrow(/name is required/);
  });

  it("nobody creates a company for someone else or inserts one directly", async () => {
    await expect(as("emp", `insert into companies (owner_id, name) values ($1, 'Mine')`, [U.emp])).rejects.toThrow(/row-level security/);
    await expect(as("emp", `select create_company_for($1, 'Theirs')`, [U.outsider])).rejects.toThrow(/permission denied/);
    await expect(as("owner", `select sa_create_company('Second', 'owner@corp.in')`)).rejects.toThrow(/Super admin only/);
  });

  it("the Super Admin can still create a company for an existing account", async () => {
    const [{ id }] = await as<{ id: string }>("sa", `select sa_create_company('New Co', 'outsider@corp.in') id`);
    expect(await sys(`select role, active from company_members where company_id = $1 and user_id = $2`, [id, U.outsider])).toEqual([{ role: "owner", active: true }]);
    await expect(as("sa", `select sa_create_company('Ghost', 'nobody@corp.in')`)).rejects.toThrow(/No account/);
  });

  it("there is no sign-up approval (AUTH-01, AUTH-04): approving or rejecting is refused for everyone", async () => {
    const fake = "00000000-0000-0000-0000-000000000001";
    for (const who of ["owner", "admin"]) {
      await expect(as(who, `select approve_join_request($1, 'employee')`, [fake])).rejects.toThrow(/not used/);
      await expect(as(who, `select reject_join_request($1, 'no')`, [fake])).rejects.toThrow(/not used/);
    }
  });

  it("employees don't self-register: new join requests are refused", async () => {
    U.cand = await createUser(db, "cand@corp.in");
    const [d] = await sys<{ id: string; department_id: string | null }>(`select id, department_id from designations where company_id = $1 limit 1`, [cid]);
    await expect(as("cand", `select submit_join_request($1, 'Ravi', null, $2, $3, null)`, [cid, d?.id ?? null, d?.department_id ?? null]))
      .rejects.toThrow(/invitation/);
    expect((await perms("cand")).allowed).toBe(false);
  });

  it("removed employees are hidden from the directory but their record is kept", async () => {
    await sys(`update employees set removed_at = now(), status = 'exited', last_working_day = current_date where id = $1`, [E.emp2]);
    expect(await count("admin", `select * from employee_directory where id = $1`, [E.emp2])).toBe(0);
    expect(await count("admin", `select * from employees where id = $1`, [E.emp2])).toBe(1);
  });
});

describe("Department → designation (0022)", () => {
  let eng: string, hr: string, dev: string, hrExec: string;

  it("designations belong to a department; the same title may exist in two departments", async () => {
    [{ id: eng }] = await as<{ id: string }>("admin", `insert into departments (company_id, name) values ($1, 'Engineering / IT') returning id`, [cid]);
    [{ id: hr }] = await as<{ id: string }>("admin", `insert into departments (company_id, name) values ($1, 'HR') returning id`, [cid]);
    [{ id: dev }] = await as<{ id: string }>("admin", `insert into designations (company_id, department_id, name) values ($1, $2, 'Software Engineer') returning id`, [cid, eng]);
    [{ id: hrExec }] = await as<{ id: string }>("admin", `insert into designations (company_id, department_id, name) values ($1, $2, 'HR Recruiter') returning id`, [cid, hr]);
    await as("admin", `insert into designations (company_id, department_id, name) values ($1, $2, 'Team Lead'), ($1, $3, 'Team Lead')`, [cid, eng, hr]);
    await expect(as("admin", `insert into designations (company_id, department_id, name) values ($1, $2, 'Team Lead')`, [cid, eng])).rejects.toThrow(/duplicate|unique/i);
  });

  it("a designation's department must be in the same company", async () => {
    const [{ id: other }] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'Elsewhere') returning id`, [cidB]);
    await expect(as("admin", `update designations set department_id = $1 where id = $2`, [other, dev])).rejects.toThrow(/different company/);
  });

  it("the server refuses a designation that isn't part of the chosen department", async () => {
    // employees no longer self-register (0028); the same rule guards the Super Admin's assignments
    await expect(sys(`select sa_check_assignment($1, 'employee', $2, $3)`, [cid, eng, hrExec])).rejects.toThrow(/not part of the selected department/);
    await sys(`select sa_check_assignment($1, 'employee', $2, $3)`, [cid, eng, dev]);
    await expect(sys(`select sa_check_assignment($1, 'finance', $2, $3)`, [cid, eng, dev])).rejects.toThrow(/access role/);
  });

  it("only HR / administrators manage the lists; a department in use can't be deleted", async () => {
    await expect(as("emp", `insert into departments (company_id, name) values ($1, 'Rogue')`, [cid])).rejects.toThrow(/row-level security/);
    expect(await as("emp", `update designations set active = false where id = $1 returning id`, [dev])).toHaveLength(0);
    await expect(as("admin", `delete from departments where id = $1`, [eng])).rejects.toThrow(/foreign key|violates/i);
  });
});
