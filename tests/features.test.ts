// Migration 0011: the remaining BRD features, exercised against the real SQL.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addAdmin, addMember, asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let owner: string, staff: string, other: string;
let hr: string;
let cid: string, empOwner: string, empStaff: string, empOther: string;

const sys = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asOwnerUser(db, uid, async () => (await db.query<T>(sql, p)).rows);
const as = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, p)).rows);

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@x.in");
  staff = await createUser(db, "staff@x.in");
  other = await createUser(db, "other@x.in");
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'X') returning id`, [owner])).rows;
  const [d1, d2] = await sys<{ id: string }>(owner, `select id from departments where company_id = $1 order by name`, [cid]);
  const mk = (name: string, user: string, dep: string) => sys<{ id: string }>(owner,
    `insert into employees (company_id, first_name, email, date_of_joining, user_id, department_id) values ($1, $2, $3, '2025-01-01', $4, $5) returning id`,
    [cid, name, `${name}@x.in`, user, dep]).then((r) => r[0].id);
  empOwner = await mk("owner", owner, d1.id);
  empStaff = await mk("staff", staff, d1.id);
  empOther = await mk("other", other, d2.id);
  await sys(owner, `insert into company_members (company_id, user_id, role) values ($1, $2, 'employee'), ($1, $3, 'employee')`, [cid, staff, other]);
  hr = await addMember(db, cid, "hr@x.in", "hr");                     // BRD §5.3: leave and payroll preparation
});

describe("tasks", () => {
  it("TSK-06: closing a recurring task creates the next one with assignees and checklist", async () => {
    const [t] = await as<{ id: string }>(owner, `insert into tasks (company_id, title, created_by, recurrence, due_at)
      values ($1, 'Weekly report', $2, 'weekly', '2026-10-23T12:00:00Z') returning id`, [cid, owner]);
    await as(owner, `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [t.id, empStaff, cid]);
    await as(owner, `insert into task_checklist (task_id, company_id, item) values ($1, $2, 'Collect numbers')`, [t.id, cid]);
    await as(owner, `update tasks set status = 'done' where id = $1`, [t.id]);
    const next = await sys<{ id: string; due_at: Date; status: string }>(owner,
      `select id, due_at, status from tasks where title = 'Weekly report' and id <> $1`, [t.id]);
    expect(next).toHaveLength(1);
    expect(next[0].status).toBe("todo");
    expect(new Date(next[0].due_at).toISOString()).toBe("2026-10-30T12:00:00.000Z");
    expect(await sys(owner, `select * from task_assignees where task_id = $1`, [next[0].id])).toHaveLength(1);
    expect(await sys(owner, `select * from task_checklist where task_id = $1 and not done`, [next[0].id])).toHaveLength(1);
  });

  it("TSK-03: a task can't be closed while a task it depends on is open", async () => {
    const [a] = await as<{ id: string }>(owner, `insert into tasks (company_id, title, created_by) values ($1, 'Design', $2) returning id`, [cid, owner]);
    const [b] = await as<{ id: string }>(owner, `insert into tasks (company_id, title, created_by) values ($1, 'Build', $2) returning id`, [cid, owner]);
    await as(owner, `insert into task_dependencies (task_id, blocked_by, company_id) values ($1, $2, $3)`, [b.id, a.id, cid]);
    await expect(as(owner, `update tasks set status = 'done' where id = $1`, [b.id])).rejects.toThrow(/blocked by: Design/);
    await as(owner, `update tasks set status = 'done' where id = $1`, [a.id]);
    await as(owner, `update tasks set status = 'done' where id = $1`, [b.id]);
  });

  it("TSK-08: a stopped timer records the minutes", async () => {
    const [t] = await as<{ id: string }>(owner, `insert into tasks (company_id, title, created_by) values ($1, 'Timed', $2) returning id`, [cid, owner]);
    const [l] = await as<{ minutes: number }>(owner, `insert into task_time_logs (task_id, company_id, employee_id, started_at, ended_at)
      values ($1, $2, $3, '2026-10-23T09:00:00Z', '2026-10-23T10:30:00Z') returning minutes`, [t.id, cid, empOwner]);
    expect(l.minutes).toBe(90);
    await expect(as(staff, `insert into task_time_logs (task_id, company_id, employee_id) values ($1, $2, $3)`, [t.id, cid, empOwner]))
      .rejects.toThrow(/row-level security/);
  });
});

describe("notifications", () => {
  it("X-01: an event type switched off is not delivered in-app", async () => {
    await as(staff, `insert into notification_prefs (kind, in_app) values ('tasks', false)`);
    const [t] = await as<{ id: string }>(owner, `insert into tasks (company_id, title, created_by) values ($1, 'Muted', $2) returning id`, [cid, owner]);
    await as(owner, `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [t.id, empOther, cid]);
    await as(owner, `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [t.id, empStaff, cid]);
    expect(await as(other, `select kind from notifications where title = 'New task assigned'`)).toEqual([{ kind: "tasks" }]);
    expect(await as(staff, `select * from notifications where title = 'New task assigned' and body = 'Muted'`)).toHaveLength(0);
  });
});

describe("chat", () => {
  it("COMMS-12: cross-department DMs can be switched off; HR is exempt", async () => {
    await sys(owner, `update companies set chat_cross_dept = false where id = $1`, [cid]);
    await expect(as(staff, `select open_dm($1, $2)`, [cid, other])).rejects.toThrow(/across departments/);
    await as(hr, `select open_dm($1, $2)`, [cid, other]);   // HR / Payroll is exempt
    await sys(owner, `update companies set chat_cross_dept = true where id = $1`, [cid]);
  });

  it("COMMS-05: any member can pin; only the sender can edit", async () => {
    const [{ open_dm: conv }] = await as<{ open_dm: string }>(staff, `select open_dm($1, $2)`, [cid, other]);
    const [m] = await as<{ id: string }>(staff, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'ship it') returning id`, [conv, cid]);
    await as(other, `update messages set pinned_at = now() where id = $1`, [m.id]);
    const [pin] = await sys<{ pinned_by: string }>(owner, `select pinned_by from messages where id = $1`, [m.id]);
    expect(pin.pinned_by).toBe(other);
    await expect(as(other, `update messages set body = 'hacked' where id = $1`, [m.id])).rejects.toThrow(/own messages/);
    await as(other, `insert into messages (conversation_id, company_id, body, reply_to_id) values ($1, $2, 'ok', $3)`, [conv, cid, m.id]);
    await as(other, `insert into message_stars (message_id, company_id) values ($1, $2)`, [m.id, cid]);
    expect(await as(other, `select * from message_stars`)).toHaveLength(1);
    expect(await as(staff, `select * from message_stars`)).toHaveLength(0);
  });

  it("COMMS-12: only the Admin can export a conversation, and it is logged", async () => {
    const [{ open_dm: conv }] = await as<{ open_dm: string }>(staff, `select open_dm($1, $2)`, [cid, other]);
    await expect(as(staff, `select * from export_conversation($1)`, [conv])).rejects.toThrow(/not allowed/);
    await expect(as(other, `select * from export_conversation($1)`, [conv])).rejects.toThrow(/not allowed/);
    await expect(as(owner, `select * from export_conversation($1)`, [conv])).rejects.toThrow(/not allowed/);   // Owner: Settings R
    const rows = await as(await addAdmin(db), `select * from export_conversation($1)`, [conv]);   // the Admin (0055)
    expect(rows.length).toBeGreaterThan(0);
    expect(await sys(owner, `select * from audit_log where action = 'export'`)).toHaveLength(1);
  });
});

describe("leave and payroll", () => {
  it("ATT-17: carry-forward is capped at the leave type's limit", async () => {
    const [el] = await sys<{ id: string }>(owner, `select id from leave_types where company_id = $1 and code = 'EL'`, [cid]);
    const y = new Date().getFullYear();
    await sys(owner, `update leave_types set accrual = 'yearly', annual_quota = 40, carry_forward_max = 30 where id = $1`, [el.id]);
    await as(hr, `select carry_forward_leaves($1, $2)`, [cid, y]);
    const [b] = await sys<{ opening: string }>(owner, `select opening from leave_balances where employee_id = $1 and leave_type_id = $2 and year = $3`, [empStaff, el.id, y + 1]);
    expect(Number(b.opening)).toBe(30);
    await expect(as(staff, `select carry_forward_leaves($1, $2)`, [cid, y])).rejects.toThrow(/not allowed/);
  });

  it("SAL-04: Salaries records an employee's declaration and totals are computed; employees have no access", async () => {
    const [d] = await as<{ declared_total: string; id: string }>(hr, `insert into tax_declarations (company_id, employee_id, fy_start_year, regime, items)
      values ($1, $2, 2026, 'old', '{"80C": 150000, "80D": 25000}') returning id, declared_total`, [cid, empStaff]);
    expect(Number(d.declared_total)).toBe(175000);
    await as(hr, `update tax_declarations set verified = true where id = $1`, [d.id]);
    expect(await as(staff, `select * from tax_declarations`)).toHaveLength(0);
    const upd = await as(staff, `update tax_declarations set items = '{"80C": 1}' where id = $1 returning id`, [d.id]);
    expect(upd).toHaveLength(0);
  });

  it("SAL-04: the old regime with declarations lowers the TDS projection", async () => {
    const [st] = await sys<Record<string, unknown>>(owner, `select * from statutory_settings where company_id = $1`, [cid]);
    expect(st).toBeTruthy();
    const tax = async (regime: string, income: number) => Number((await sys<{ t: string }>(owner,
      `select annual_tax(regime_settings(s, $2), $3) as t from statutory_settings s where company_id = $1`, [cid, regime, income]))[0].t);
    // ₹12,00,000 gross: new regime → full rebate (0); old regime with ₹1.75 L declared → taxable 9.75 L
    expect(await tax("new", 1200000 - 75000)).toBe(0);
    expect(Math.round(await tax("old", 1200000 - 50000 - 175000))).toBe(Math.round((12500 + 95000) * 1.04));
  });
});

describe("privacy", () => {
  it("NFR-06: data requests notify the owner and are visible only to the requester and admins", async () => {
    await as(staff, `insert into data_requests (company_id, kind) values ($1, 'export')`, [cid]);
    expect(await as(owner, `select * from notifications where title = 'Data export request'`)).toHaveLength(1);
    expect(await as(other, `select * from data_requests`)).toHaveLength(0);
    expect(await as(staff, `select * from data_requests`)).toHaveLength(1);
  });
});
