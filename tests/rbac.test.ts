// Role-based access control (migrations 0018 + 0019) — the acceptance criteria, against the real RLS policies.
// Every query runs as the `authenticated` role with the user's id, so RLS applies exactly as in production.
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

beforeAll(async () => {
  db = await createDb();
  for (const who of ["owner", "admin", "hr", "finance", "manager", "emp", "emp2", "ownerB", "sa", "outsider"]) U[who] = await createUser(db, `${who}@corp.in`);
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [U.owner])).rows;
  [{ id: cidB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [U.ownerB])).rows;
  const roles: [string, string][] = [["admin", "company_admin"], ["hr", "hr"], ["finance", "finance"], ["manager", "manager"], ["emp", "employee"], ["emp2", "employee"]];
  for (const who of ["owner", ...roles.map((r) => r[0])]) {
    [{ id: E[who] }] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining, user_id, ifsc)
      values ($1, $2, $3, '2025-01-01', $4, 'HDFC0000001') returning id`, [cid, who, `${who}@corp.in`, U[who]]);
  }
  for (const [who, role] of roles) await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, $3)`, [cid, U[who], role]);
  await sys(`update employees set reporting_manager_id = $1 where id = $2`, [E.manager, E.emp]);   // emp reports to manager; emp2 doesn't
  [{ id: structure }] = await sys<{ id: string }>(`select id from salary_structures where company_id = $1`, [cid]);
  await sys(`insert into employee_ctc (company_id, employee_id, structure_id, annual_ctc, effective_from) values ($1, $2, $3, 360000, '2025-01-01')`, [cid, E.emp, structure]);
  // a task assigned to emp and to finance, created by the manager
  [{ id: task }] = await as<{ id: string }>("manager", `insert into tasks (company_id, title, created_by) values ($1, 'Assigned work', $2) returning id`, [cid, U.manager]);
  await as("manager", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3), ($1, $4, $3)`, [task, E.emp, cid, E.finance]);
  [{ id: ownTaskForEmp }] = await as<{ id: string }>("owner", `insert into tasks (company_id, title, created_by) values ($1, 'Unrelated work', $2) returning id`, [cid, U.owner]);
  // a locked payroll run with a payslip for emp (to check own-payslip access)
  const [run] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status) values ($1, '2026-09-01', 1, 'locked') returning id`, [cid]);
  for (const who of ["emp", "emp2"]) {
    await sys(`insert into payslips (run_id, company_id, employee_id, month, salary_days, window_days, payable_days, lop_days, ratio, monthly_gross, day_value, earned_gross, gross_payable, total_deductions, net_pay)
      values ($1, $2, $3, '2026-09-01', 30, 30, 30, 0, 1, 30000, 1000, 30000, 30000, 1800, 28200)`, [run.id, cid, E[who]]);
  }
}, 120000);

describe("1 · Super Admin", () => {
  it("is never granted automatically: no existing user is a super admin", async () => {
    expect(await sys(`select * from platform_admins`)).toHaveLength(0);
    for (const who of ["owner", "admin", "hr", "emp"]) expect((await as<{ v: boolean }>(who, `select is_super_admin() v`))[0].v).toBe(false);
  });

  it("can't be granted through the API, even by a company owner", async () => {
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
    const [after] = await sys<{ active: boolean }>(`select active from company_members where company_id = $1 and user_id = $2`, [cidB, U.outsider]);
    expect(after.active).toBe(false);
    await expect(as("sa", `select sa_remove_company_admin($1, $2)`, [cid, U.owner])).rejects.toThrow(/owner cannot be removed/);
  });

  it("is not a member or an employee anywhere, but acts as an Administrator in every company", async () => {
    expect(await sys(`select * from company_members where user_id = $1`, [U.sa])).toHaveLength(0);
    expect(await sys(`select * from employees where user_id = $1`, [U.sa])).toHaveLength(0);
    const [{ a }] = await as<{ a: { allowed: boolean; role: string; permissions: string[] } }>("sa", `select my_access($1) a`, [cid]);
    expect(a.allowed).toBe(true);
    expect(a.role).toBe("super_admin");
    expect(a.permissions).toContain("employees.assign_role");
    expect(a.permissions).toContain("salaries.manage");
    expect(a.permissions).not.toContain("salaries.approve");
    expect(await count("sa", `select * from employees where company_id = $1`, [cid])).toBe(7);
    expect(await count("sa", `select * from employees where company_id = $1`, [cidB])).toBe(0);   // Other has no employees
  });

  it("every write it makes is audited as super admin; it can't approve or reopen payroll or promote itself", async () => {
    await as("sa", `update employees set probation_end = '2025-06-30' where id = $1`, [E.emp]);
    const [log] = await sys<{ via_super_admin: boolean; user_id: string }>(
      `select via_super_admin, user_id from audit_log where table_name = 'employees' and record_id = $1 order by id desc limit 1`, [E.emp]);
    expect(log).toEqual({ via_super_admin: true, user_id: U.sa });
    await as("sa", `insert into departments (company_id, name) values ($1, 'Platform-made')`, [cid]);   // a table without its own audit
    expect(await sys(`select * from audit_log where table_name = 'departments' and via_super_admin`)).toHaveLength(1);
    await as("sa", `select sa_log_access($1)`, [cid]);
    await as("sa", `select sa_log_access($1)`, [cid]);
    expect(await sys(`select * from audit_log where action = 'super_admin_access' and company_id = $1`, [cid])).toHaveLength(1);
    const [r] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status) values ($1, '2026-07-01', 1, 'draft') returning id`, [cid]);
    await expect(as("sa", `select approve_payroll($1)`, [r.id])).rejects.toThrow(/Only an Administrator or Finance/);
    await expect(as("sa", `select sa_set_company_admin($1, 'sa@corp.in')`, [cid])).rejects.toThrow(/yourself/);
    await expect(as("sa", `insert into company_members (company_id, user_id, role) values ($1, $2, 'company_admin')`, [cid, U.sa])).rejects.toThrow(/row-level security/);
    await sys(`delete from payroll_runs where id = $1`, [r.id]);
  });

  it("super-admin functions refuse everyone else", async () => {
    await expect(as("owner", `select * from sa_companies()`)).rejects.toThrow(/Super admin only/);
    await expect(as("admin", `select sa_set_company_admin($1, 'emp@corp.in')`, [cid])).rejects.toThrow(/Super admin only/);
  });
});

describe("2 · Employee creation, invitations and roles", () => {
  it("employees cannot create employees", async () => {
    await expect(as("emp", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'x', 'x@corp.in', '2025-01-01')`, [cid]))
      .rejects.toThrow(/row-level security/);
  });

  it("employees cannot change their own role or membership", async () => {
    await expect(as("emp", `update employees set invite_role = 'company_admin' where id = $1`, [E.emp])).rejects.toThrow(/Only an administrator/);
    expect(await count("emp", `update company_members set role = 'company_admin' where user_id = $1 returning id`, [U.emp])).toBe(0);
    await expect(as("emp", `insert into company_members (company_id, user_id, role) values ($1, $2, 'hr')`, [cid, U.outsider])).rejects.toThrow(/row-level security/);
  });

  it("HR manages records but not account creation, activation or system roles", async () => {
    // 0024: HR creates plain records — no login, no invitation, the 'employee' role only
    const [made] = await as<{ invite_role: string; user_id: string | null }>("hr",
      `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'x', 'x2@corp.in', '2025-01-01') returning invite_role, user_id`, [cid]);
    expect(made).toEqual({ invite_role: "employee", user_id: null });
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, invite_role) values ($1, 'y', 'y@corp.in', '2025-01-01', 'company_admin')`, [cid]))
      .rejects.toThrow(/Only an administrator can choose the system role/);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, invite_role) values ($1, 'y', 'y@corp.in', '2025-01-01', 'hr')`, [cid]))
      .rejects.toThrow(/Only an administrator can choose the system role/);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, user_id) values ($1, 'y', 'y@corp.in', '2025-01-01', $2)`, [cid, U.outsider]))
      .rejects.toThrow(/Only an administrator can link a login/);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining, invited_at) values ($1, 'y', 'y@corp.in', '2025-01-01', now())`, [cid]))
      .rejects.toThrow(/Only an administrator can send invitations/);
    await expect(as("hr", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'z', 'z@corp.in', '2025-01-01')`, [cidB]))
      .rejects.toThrow(/row-level security/);                 // HR here is nothing in another company
    await as("hr", `update employees set phone = '9848022338', probation_end = '2025-07-01' where id = $1`, [E.emp]);
    await expect(as("hr", `update employees set status = 'inactive' where id = $1`, [E.emp])).rejects.toThrow(/Only an administrator/);
    await expect(as("hr", `update employees set invite_role = 'manager' where id = $1`, [E.emp])).rejects.toThrow(/Only an administrator/);
    expect(await count("hr", `update company_members set role = 'manager' where user_id = $1 returning id`, [U.emp])).toBe(0);
  });

  it("nobody can change their own membership, not even an administrator", async () => {
    expect(await count("admin", `update company_members set role = 'employee' where user_id = $1 returning id`, [U.admin])).toBe(0);
    expect(await count("admin", `update company_members set active = false where user_id = $1 returning id`, [U.admin])).toBe(0);
  });

  it("administrators create employees and assign system roles, but cannot touch the owner", async () => {
    await as("admin", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'New', 'new@corp.in', '2026-10-01')`, [cid]);
    // an Administrator can make someone an HR Manager: on a new record, and on an existing member
    const [hrMade] = await as<{ invite_role: string }>("admin",
      `insert into employees (company_id, first_name, email, date_of_joining, invite_role) values ($1, 'Hema', 'hema@corp.in', '2026-10-01', 'hr') returning invite_role`, [cid]);
    expect(hrMade.invite_role).toBe("hr");
    expect(await count("admin", `update company_members set role = 'hr' where user_id = $1 returning id`, [U.emp2])).toBe(1);
    expect((await as<{ a: { role: string } }>("emp2", `select my_access($1) a`, [cid]))[0].a.role).toBe("hr");
    expect(await count("admin", `update company_members set role = 'manager' where user_id = $1 returning id`, [U.emp2])).toBe(1);
    await as("admin", `update company_members set role = 'employee' where user_id = $1`, [U.emp2]);
    expect(await count("admin", `update company_members set role = 'employee' where user_id = $1 returning id`, [U.owner])).toBe(0);
  });

  it("designation grants nothing: an employee titled 'Manager' stays an employee", async () => {
    const [d] = await sys<{ id: string }>(`insert into designations (company_id, name) values ($1, 'HR Manager') returning id`, [cid]);
    await sys(`update employees set designation_id = $1 where id = $2`, [d.id, E.emp2]);
    expect(await count("emp2", `select * from salary_structures`)).toBe(0);
    expect(await count("emp2", `select * from employees`)).toBe(1);
  });
});

describe("3–5 · Salaries", () => {
  const salaryTables = ["salary_structures", "salary_components", "employee_ctc", "statutory_settings", "variable_inputs", "loans", "recovery_balances", "payroll_runs"];

  it("3 · employees see no payroll data — not even their own CTC — and cannot run or pre-check payroll", async () => {
    for (const t of salaryTables) expect(await count("emp", `select * from ${t}`), t).toBe(0);
    await expect(as("emp", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
    await expect(as("emp", `select * from calculate_payroll_run($1, '2026-10')`, [cid])).rejects.toThrow(/not allowed/);
    await expect(as("emp", `select payroll_precheck($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
  });

  it("3 · employees get no payslips (not even their own approved one) and no tax declarations", async () => {
    expect(await count("emp", `select * from payslips`)).toBe(0);
    expect(await count("emp", `select * from final_payslips`)).toBe(0);
    expect(await count("emp", `select * from payslip_lines`)).toBe(0);
    await expect(as("emp", `insert into tax_declarations (company_id, employee_id, fy_start_year, regime, items) values ($1, $2, 2026, 'old', '{}')`, [cid, E.emp]))
      .rejects.toThrow(/row-level security/);
  });

  it("4 · managers have no Salaries access", async () => {
    for (const t of salaryTables) expect(await count("manager", `select * from ${t}`), t).toBe(0);
    expect(await count("manager", `select * from payslips`)).toBe(0);
    expect(await count("manager", `select * from final_payslips`)).toBe(0);
    await expect(as("manager", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
  });

  it("5 · HR reads Salaries but cannot change or run anything", async () => {
    expect(await count("hr", `select * from salary_structures`)).toBe(1);
    expect(await count("hr", `select * from employee_ctc`)).toBe(1);
    expect(await count("hr", `select * from payslips`)).toBe(2);
    await expect(as("hr", `insert into salary_structures (company_id, name) values ($1, 'x')`, [cid])).rejects.toThrow(/row-level security/);
    expect(await count("hr", `update statutory_settings set pf_employee_rate = 1 where company_id = $1 returning company_id`, [cid])).toBe(0);
    expect(await count("hr", `update payslips set payment_status = 'paid' returning id`)).toBe(0);
    await expect(as("hr", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
    await as("hr", `select payroll_precheck($1, '2026-10-01')`, [cid]);   // view-only pre-checks are allowed
  });

  it("Finance and the Administrator have full Salaries access, including approval (maker-checker)", async () => {
    await as("finance", `insert into salary_structures (company_id, name) values ($1, 'Finance structure')`, [cid]);
    await expect(as("finance", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/Lock attendance/);   // passed the permission check
    const [mine] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status, ran_by) values ($1, '2026-08-01', 1, 'draft', $2) returning id`, [cid, U.finance]);
    await expect(as("finance", `select approve_payroll($1)`, [mine.id])).rejects.toThrow(/someone else must approve/);
    await expect(as("hr", `select approve_payroll($1)`, [mine.id])).rejects.toThrow(/Only an Administrator or Finance/);
    await as("admin", `select approve_payroll($1)`, [mine.id]);
    expect(await sys(`select * from audit_log where action = 'approve' and record_id = $1`, [mine.id])).toHaveLength(1);
    await expect(as("finance", `select reopen_payroll($1, 'fix', '2026-08')`, [mine.id])).rejects.toThrow(/owner or a company administrator/);
    await expect(as("admin", `select reopen_payroll($1, 'fix', 'yes')`, [mine.id])).rejects.toThrow(/Type 2026-08 to confirm/);
    await as("admin", `select reopen_payroll($1, 'fix', '2026-08')`, [mine.id]);
    const [other] = await sys<{ id: string }>(`insert into payroll_runs (company_id, month, version, status, ran_by) values ($1, '2026-08-01', 2, 'draft', $2) returning id`, [cid, U.admin]);
    await as("finance", `select approve_payroll($1)`, [other.id]);   // Finance approves a run someone else prepared
    await as("admin", `insert into salary_structures (company_id, name) values ($1, 'Admin structure')`, [cid]);
  });
});

describe("6 · Finance and Tasks", () => {
  it("Finance sees no tasks, even one assigned to them, and cannot create tasks", async () => {
    expect(await count("finance", `select * from tasks`)).toBe(0);
    expect(await count("finance", `select * from task_assignees`)).toBe(0);
    await expect(as("finance", `insert into tasks (company_id, title, created_by) values ($1, 'x', $2)`, [cid, U.finance])).rejects.toThrow(/row-level security/);
  });

  it("Finance reads pay-related fields only, through employee_pay_fields", async () => {
    expect(await count("finance", `select * from employees`)).toBe(1);   // only their own profile
    expect(await count("finance", `select * from employee_pay_fields`)).toBeGreaterThanOrEqual(7);
    await as("finance", `select update_employee_pay_fields($1, '{"ifsc": "ICIC0000002", "uan": "100912345678"}')`, [E.emp]);
    await expect(as("finance", `select update_employee_pay_fields($1, '{"first_name": "Hacked"}')`, [E.emp])).rejects.toThrow(/pay-related/);
    await expect(as("emp", `select update_employee_pay_fields($1, '{"ifsc": "ICIC0000003"}')`, [E.emp])).rejects.toThrow(/not allowed/);
  });

  it("HR has view-only Tasks access", async () => {
    expect(await count("hr", `select * from tasks`)).toBeGreaterThanOrEqual(2);
    await expect(as("hr", `insert into tasks (company_id, title, created_by) values ($1, 'x', $2)`, [cid, U.hr])).rejects.toThrow(/row-level security/);
    expect(await count("hr", `update tasks set title = 'x' where id = $1 returning id`, [task])).toBe(0);
    await expect(as("hr", `insert into task_comments (task_id, company_id, body) values ($1, $2, 'x')`, [task, cid])).rejects.toThrow(/row-level security/);
  });
});

describe("7 · Employees see their own profile and assigned tasks", () => {
  it("only their own employee record", async () => {
    const rows = await as<{ id: string }>("emp", `select id from employees`);
    expect(rows.map((r) => r.id)).toEqual([E.emp]);
  });

  it("only tasks assigned to them; they work on them but cannot create or reassign", async () => {
    const rows = await as<{ id: string }>("emp", `select id from tasks`);
    expect(rows.map((r) => r.id)).toEqual([task]);
    expect(await count("emp", `select * from tasks where id = $1`, [ownTaskForEmp])).toBe(0);
    expect(await count("emp", `update tasks set status = 'in_progress' where id = $1 returning id`, [task])).toBe(1);
    await as("emp", `insert into task_comments (task_id, company_id, body) values ($1, $2, 'on it')`, [task, cid]);
    await expect(as("emp", `insert into tasks (company_id, title, created_by) values ($1, 'mine', $2)`, [cid, U.emp])).rejects.toThrow(/row-level security/);
    await expect(as("emp", `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [task, E.emp2, cid])).rejects.toThrow(/row-level security/);
  });
});

describe("8 · Managers see their team only", () => {
  it("employee records: themselves and direct reports", async () => {
    const rows = await as<{ id: string }>("manager", `select id from employees order by id`);
    expect(rows.map((r) => r.id).sort()).toEqual([E.manager, E.emp].sort());
  });

  it("attendance: their team, not other employees", async () => {
    await sys(`insert into daily_attendance (company_id, employee_id, date, status) values ($1, $2, '2026-10-20', 'present'), ($1, $3, '2026-10-20', 'present')`, [cid, E.emp, E.emp2]);
    const rows = await as<{ employee_id: string }>("manager", `select employee_id from daily_attendance`);
    expect(rows.map((r) => r.employee_id)).toEqual([E.emp]);
    expect(await count("finance", `select * from daily_attendance`)).toBe(2);   // payroll needs the whole company
  });

  it("tasks: they manage their team's work", async () => {
    expect(await count("manager", `update tasks set priority = 'high' where id = $1 returning id`, [task])).toBe(1);
    expect(await count("manager", `select * from tasks where id = $1`, [ownTaskForEmp])).toBe(0);
  });
});

describe("9 · Tenant isolation", () => {
  it("no role reads another company's records", async () => {
    for (const who of ["owner", "admin", "hr", "finance", "manager", "emp"]) {
      for (const t of ["employees", "payroll_runs", "salary_structures", "tasks", "daily_attendance"]) {
        expect(await count(who, `select * from ${t} where company_id = $1`, [cidB]), `${who} ${t}`).toBe(0);
      }
    }
    expect(await count("ownerB", `select * from employees where company_id = $1`, [cid])).toBe(0);
    await expect(as("ownerB", `select run_payroll($1, '2026-10-01')`, [cid])).rejects.toThrow(/not allowed/);
  });
});

describe("10 · Inactive users and invalid roles", () => {
  it("my_access reports allowed with permissions from the server-side matrix", async () => {
    const [{ a }] = await as<{ a: { allowed: boolean; role: string; permissions: string[] } }>("finance", `select my_access($1) a`, [cid]);
    expect(a.allowed).toBe(true);
    expect(a.role).toBe("finance");
    expect(a.permissions).toContain("salaries.manage");
    expect(a.permissions).not.toContain("tasks.use");
  });

  it("an inactive employee loses all access, even with an active membership", async () => {
    await sys(`update employees set status = 'inactive' where id = $1`, [E.emp2]);
    const [{ a }] = await as<{ a: { allowed: boolean; reason: string } }>("emp2", `select my_access($1) a`, [cid]);
    expect(a).toMatchObject({ allowed: false, reason: "employee_inactive" });
    expect(await count("emp2", `select * from employees`)).toBe(0);
    expect(await count("emp2", `select * from payslips`)).toBe(0);
    expect(await count("emp2", `select * from companies where id = $1`, [cid])).toBe(0);
    await expect(as("emp2", `select open_dm($1, $2)`, [cid, U.emp])).rejects.toThrow(/not allowed/);
  });

  it("an exited employee and a disabled membership are denied too", async () => {
    await sys(`update employees set status = 'exited', last_working_day = '2026-09-30' where id = $1`, [E.emp2]);
    expect((await as<{ a: { allowed: boolean } }>("emp2", `select my_access($1) a`, [cid]))[0].a.allowed).toBe(false);
    await sys(`update company_members set active = false where user_id = $1`, [U.manager]);
    const [{ a }] = await as<{ a: { allowed: boolean; reason: string } }>("manager", `select my_access($1) a`, [cid]);
    expect(a).toMatchObject({ allowed: false, reason: "membership_inactive" });
    expect(await count("manager", `select * from employees`)).toBe(0);
    await sys(`update company_members set active = true where user_id = $1`, [U.manager]);
  });

  it("a role outside the matrix cannot be stored, and non-members get nothing", async () => {
    await expect(sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'superuser')`, [cid, U.outsider])).rejects.toThrow(/company_members_role_check/);
    const [{ a }] = await as<{ a: { allowed: boolean; reason: string } }>("outsider", `select my_access($1) a`, [cid]);
    expect(a).toMatchObject({ allowed: false, reason: "not_member" });
  });
});

describe("Projects (confirmed mapping)", () => {
  let led: string, other: string;
  it("Administrator full; a Manager creates only projects they lead; Finance has none", async () => {
    [{ id: other }] = await as<{ id: string }>("admin", `insert into projects (company_id, name) values ($1, 'Admin project') returning id`, [cid]);
    await expect(as("manager", `insert into projects (company_id, name) values ($1, 'Not mine')`, [cid])).rejects.toThrow(/row-level security/);
    [{ id: led }] = await as<{ id: string }>("manager", `insert into projects (company_id, name, manager_id) values ($1, 'Mine', $2) returning id`, [cid, E.manager]);
    expect(await count("manager", `update projects set client = 'X' where id = $1 returning id`, [led])).toBe(1);
    expect(await count("manager", `update projects set client = 'X' where id = $1 returning id`, [other])).toBe(0);
    expect(await count("finance", `select * from projects`)).toBe(0);
    await expect(as("hr", `insert into projects (company_id, name) values ($1, 'HR')`, [cid])).rejects.toThrow(/row-level security/);
  });

  it("HR, Managers and Employees read only the projects they belong to", async () => {
    expect(await count("emp", `select * from projects`)).toBe(0);
    expect(await count("hr", `select * from projects`)).toBe(0);
    await as("manager", `insert into project_members (project_id, employee_id, company_id) values ($1, $2, $3), ($1, $4, $3)`, [led, E.emp, cid, E.hr]);
    expect(await count("emp", `select * from projects`)).toBe(1);
    expect(await count("hr", `select * from projects`)).toBe(1);
    expect(await count("emp", `update projects set client = 'Y' where id = $1 returning id`, [led])).toBe(0);
    expect(await count("admin", `select * from projects`)).toBe(2);
  });
});

describe("Leave Management is off in Phase 1", () => {
  it("is blocked at the database for every role, and returns when the operator enables it", async () => {
    const [lt] = await sys<{ id: string }>(`select id from leave_types where company_id = $1 and code = 'CL'`, [cid]);
    await expect(as("emp", `insert into leave_requests (company_id, employee_id, leave_type_id, from_date, to_date) values ($1, $2, $3, '2026-11-02', '2026-11-02')`, [cid, E.emp, lt.id]))
      .rejects.toThrow(/row-level security/);
    expect(await count("owner", `select * from leave_types`)).toBe(0);
    expect((await as<{ a: { permissions: string[] } }>("emp", `select my_access($1) a`, [cid]))[0].a.permissions).not.toContain("feature.leave");
    await sys(`update platform_features set enabled = true where feature = 'leave'`);
    expect((await as<{ a: { permissions: string[] } }>("emp", `select my_access($1) a`, [cid]))[0].a.permissions).toContain("feature.leave");
    expect(await count("owner", `select * from leave_types`)).toBeGreaterThan(0);
    await sys(`update platform_features set enabled = false where feature = 'leave'`);
  });
});

describe("Staff directory and employee removal", () => {
  it("the directory exposes basic details only", async () => {
    const [row] = await as<Record<string, unknown>>("emp", `select * from employee_directory limit 1`);
    for (const k of ["phone", "date_of_joining", "dob", "pan_last4", "bank_last4", "ifsc", "address", "invite_role"]) expect(row, k).not.toHaveProperty(k);
    expect(row).toHaveProperty("designation");
  });

  it("an employee with payroll history can't be deleted; one created by mistake can, by an administrator", async () => {
    await expect(as("admin", `delete from employees where id = $1`, [E.emp])).rejects.toThrow(/history/);
    const [{ id }] = await as<{ id: string }>("admin", `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Typo', 'typo@corp.in', '2026-10-01') returning id`, [cid]);
    expect(await count("hr", `delete from employees where id = $1 returning id`, [id])).toBe(0);
    expect(await count("admin", `delete from employees where id = $1 returning id`, [id])).toBe(1);
    expect(await sys(`select * from audit_log where table_name = 'employees' and action = 'delete' and record_id = $1`, [id])).toHaveLength(1);
  });
});

describe("Companies are created only by the Super Admin (0020)", () => {
  it("a signed-in user can't create a company or make themselves an owner", async () => {
    await expect(as("outsider", `insert into companies (owner_id, name) values ($1, 'Mine')`, [U.outsider])).rejects.toThrow(/row-level security/);
    await expect(as("emp", `insert into companies (owner_id, name) values ($1, 'Mine')`, [U.emp])).rejects.toThrow(/row-level security/);
    await expect(as("owner", `select sa_create_company('Second', 'owner@corp.in')`)).rejects.toThrow(/Super admin only/);
    expect(await sys(`select * from company_members where user_id = $1 and role = 'owner'`, [U.outsider])).toHaveLength(0);
  });

  it("the Super Admin creates a company for an existing account, which becomes its owner with an employee record", async () => {
    const [{ id }] = await as<{ id: string }>("sa", `select sa_create_company('New Co', 'outsider@corp.in') id`);
    const [m] = await sys<{ role: string; active: boolean }>(`select role, active from company_members where company_id = $1 and user_id = $2`, [id, U.outsider]);
    expect(m).toEqual({ role: "owner", active: true });
    expect(await sys(`select * from employees where company_id = $1 and user_id = $2`, [id, U.outsider])).toHaveLength(1);
    expect(await sys(`select * from audit_log where action = 'super_admin_create_company' and company_id = $1`, [id])).toHaveLength(1);
    const [{ id: own }] = await as<{ id: string }>("sa", `select sa_create_company('Operator Co', 'sa@corp.in') id`);   // the operator may own one
    expect(await sys(`select role from company_members where company_id = $1 and user_id = $2`, [own, U.sa])).toEqual([{ role: "owner" }]);
    await expect(as("sa", `select sa_create_company('Ghost', 'nobody@corp.in')`)).rejects.toThrow(/No account/);
  });
});

describe("Candidate sign-up and approval (0021)", () => {
  let req: string, hrDesig: string, plainDesig: string, hrDept: string;
  it("only an administrator sets which access role a designation gives", async () => {
    [{ id: hrDesig }] = await as<{ id: string }>("admin", `insert into designations (company_id, name, access_role) values ($1, 'HR Executive', 'hr') returning id`, [cid]);
    await expect(as("hr", `insert into designations (company_id, name, access_role) values ($1, 'Boss', 'company_admin')`, [cid])).rejects.toThrow(/Only an administrator/);
    [{ id: plainDesig }] = await as<{ id: string }>("hr", `insert into designations (company_id, name) values ($1, 'Clerk') returning id`, [cid]);
    await expect(as("hr", `update designations set access_role = 'company_admin' where id = $1`, [plainDesig])).rejects.toThrow(/Only an administrator/);
    // 0022: designations sit under a department; candidates pick the department first
    [{ id: hrDept }] = await sys<{ id: string }>(`insert into departments (company_id, name) values ($1, 'Human Resources') returning id`, [cid]);
    await as("admin", `update designations set department_id = $1 where id = any($2)`, [hrDept, [hrDesig, plainDesig]]);
  });

  it("a candidate requests to join with a designation and gets no access until approved", async () => {
    U.cand = await createUser(db, "cand@corp.in");
    [{ id: req }] = await as<{ id: string }>("cand", `select submit_join_request($1, 'Ravi Kumar', '98480 11111', $2, $3, null) id`, [cid, hrDesig, hrDept]);
    expect((await as<{ a: { allowed: boolean } }>("cand", `select my_access($1) a`, [cid]))[0].a.allowed).toBe(false);
    expect(await count("cand", `select * from employees`)).toBe(0);
    expect(await count("cand", `select * from join_requests`)).toBe(1);                 // their own request
    await expect(as("cand", `insert into join_requests (company_id, user_id, full_name, email) values ($1, $2, 'x', 'x')`, [cid, U.cand])).rejects.toThrow(/row-level security/);
    await expect(as("cand", `select submit_join_request($1, 'Ravi', null, $2, $3, null)`, [cid, (await sys<{ id: string }>(`select id from designations where company_id = $1 limit 1`, [cidB]))[0]?.id ?? cid, hrDept]))
      .rejects.toThrow(/designation/);
    expect(await count("admin", `select * from join_requests where status = 'pending'`)).toBe(1);
    expect(await count("hr", `select * from join_requests`)).toBe(0);                    // HR doesn't approve
    expect(await count("ownerB", `select * from join_requests`)).toBe(0);                // other companies don't see it
  });

  it("only an administrator approves, once; the candidate then gets the confirmed role", async () => {
    await expect(as("hr", `select approve_join_request($1, 'hr')`, [req])).rejects.toThrow(/Only an administrator/);
    await expect(as("cand", `select approve_join_request($1, 'company_admin')`, [req])).rejects.toThrow(/Only an administrator/);
    await expect(as("admin", `select approve_join_request($1, 'owner')`, [req])).rejects.toThrow(/access role/);
    await as("admin", `select approve_join_request($1, 'hr')`, [req]);
    const [{ a }] = await as<{ a: { allowed: boolean; role: string } }>("cand", `select my_access($1) a`, [cid]);
    expect(a).toMatchObject({ allowed: true, role: "hr" });
    const [e] = await sys<{ designation_id: string; phone: string }>(`select designation_id, phone from employees where user_id = $1`, [U.cand]);
    expect(e).toEqual({ designation_id: hrDesig, phone: "98480 11111" });
    await expect(as("admin", `select approve_join_request($1, 'hr')`, [req])).rejects.toThrow(/already approved/);
    await expect(as("cand", `select submit_join_request($1, 'Ravi', null, $2, $3, null)`, [cid, hrDesig, hrDept])).rejects.toThrow(/already belong/);
    expect(await sys(`select * from audit_log where table_name = 'join_requests' and action = 'approve'`)).toHaveLength(1);
  });

  it("a rejected candidate stays without access", async () => {
    U.cand2 = await createUser(db, "cand2@corp.in");
    const [{ id }] = await as<{ id: string }>("cand2", `select submit_join_request($1, 'Asha', null, $2, $3, null) id`, [cid, plainDesig, hrDept]);
    await as("admin", `select reject_join_request($1, 'Not our employee')`, [id]);
    expect((await as<{ a: { allowed: boolean } }>("cand2", `select my_access($1) a`, [cid]))[0].a.allowed).toBe(false);
  });

  it("removed employees are hidden from the directory but their record is kept", async () => {
    await sys(`update employees set removed_at = now(), status = 'exited', last_working_day = current_date where user_id = $1`, [U.cand]);
    expect(await count("admin", `select * from employee_directory where user_id = $1`, [U.cand])).toBe(0);
    expect(await count("admin", `select * from employees where user_id = $1`, [U.cand])).toBe(1);
    expect((await as<{ a: { allowed: boolean } }>("cand", `select my_access($1) a`, [cid]))[0].a.allowed).toBe(false);
  });
});

describe("Department → designation (0022)", () => {
  let eng: string, hr: string, dev: string, hrExec: string;
  const submit = (who: string, desig: string | null, dept: string | null) =>
    as(who, `select submit_join_request($1, 'Kiran', null, $2, $3, null) id`, [cid, desig, dept]);

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

  it("the server refuses a designation from another department, a missing department, and inactive ones", async () => {
    U.cand3 = await createUser(db, "cand3@corp.in");
    await expect(submit("cand3", dev, null)).rejects.toThrow(/Choose your department/);
    await expect(submit("cand3", hrExec, eng)).rejects.toThrow(/not part of the selected department/);   // HR role under Engineering
    await expect(submit("cand3", null, eng)).rejects.toThrow(/Choose your designation/);

    await as("admin", `update designations set active = false where id = $1`, [dev]);
    await expect(submit("cand3", dev, eng)).rejects.toThrow(/Choose your designation/);
    await as("admin", `update designations set active = true where id = $1`, [dev]);

    await as("admin", `update departments set active = false where id = $1`, [eng]);
    await expect(submit("cand3", dev, eng)).rejects.toThrow(/Choose your department/);
    await as("admin", `update departments set active = true where id = $1`, [eng]);

    const [{ id }] = await submit("cand3", dev, eng) as { id: string }[];
    expect(await sys(`select department_id, designation_id from join_requests where id = $1`, [id])).toEqual([{ department_id: eng, designation_id: dev }]);
  });

  it("only HR / administrators manage the lists; a department in use can't be deleted", async () => {
    await expect(as("emp", `insert into departments (company_id, name) values ($1, 'Rogue')`, [cid])).rejects.toThrow(/row-level security/);
    expect(await as("emp", `update designations set active = false where id = $1 returning id`, [dev])).toHaveLength(0);
    await expect(as("admin", `delete from departments where id = $1`, [eng])).rejects.toThrow(/foreign key|violates/i);
  });
});
