// Migration 0015: tasks and chat keep company_id consistent; chat attachments (COMMS-03).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwnerUser, asUser, createDb, createUser } from "./db";

let db: PGlite;
let both: string, alice: string, cidA: string, cidB: string, empB: string, projB: string;

const as = async <T = Record<string, unknown>>(uid: string, sql: string, p: unknown[] = []) =>
  asUser(db, uid, async () => (await db.query<T>(sql, p)).rows);
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;

beforeAll(async () => {
  db = await createDb();
  both = await createUser(db, "owner@both.in");      // owns two companies: the cross-tenant risk case
  alice = await createUser(db, "alice@a.in");
  [{ id: cidA }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'A') returning id`, [both])).rows;
  [{ id: cidB }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'B') returning id`, [both])).rows;
  await sys(`insert into employees (company_id, first_name, email, date_of_joining, user_id) values ($1, 'Own', 'own@a.in', '2025-01-01', $2)`, [cidA, both]);
  [{ id: empB }] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Bea', 'bea@b.in', '2025-01-01') returning id`, [cidB]);
  [{ id: projB }] = await as<{ id: string }>(both, `insert into projects (company_id, name) values ($1, 'B project') returning id`, [cidB]);
});

describe("tasks", () => {
  it("a task can't use another company's project or parent task", async () => {
    await expect(as(both, `insert into tasks (company_id, title, created_by, project_id) values ($1, 'x', $2, $3)`, [cidA, both, projB]))
      .rejects.toThrow(/Project belongs to a different company/);
    const [tb] = await as<{ id: string }>(both, `insert into tasks (company_id, title, created_by) values ($1, 'B task', $2) returning id`, [cidB, both]);
    await expect(as(both, `insert into tasks (company_id, title, created_by, parent_id) values ($1, 'sub', $2, $3)`, [cidA, both, tb.id]))
      .rejects.toThrow(/Parent task belongs to a different company/);
  });

  it("child rows take the task's company_id, whatever the client sends", async () => {
    const [t] = await as<{ id: string }>(both, `insert into tasks (company_id, title, created_by) values ($1, 'A task', $2) returning id`, [cidA, both]);
    const [c] = await as<{ company_id: string }>(both, `insert into task_comments (task_id, company_id, body) values ($1, $2, 'hi') returning company_id`, [t.id, cidB]);
    expect(c.company_id).toBe(cidA);
    await expect(as(both, `insert into task_assignees (task_id, employee_id, company_id) values ($1, $2, $3)`, [t.id, empB, cidB]))
      .rejects.toThrow(/Employee belongs to a different company/);
    await expect(as(both, `insert into task_attachments (task_id, company_id, name, storage_path) values ($1, $2, 'f', 'elsewhere/f.pdf')`, [t.id, cidA]))
      .rejects.toThrow(/task folder/);
    await as(both, `insert into task_attachments (task_id, company_id, name, storage_path) values ($1, $2, 'f', $3)`, [t.id, cidA, `${cidA}/${t.id}/1-f.pdf`]);
  });
});

describe("chat", () => {
  let conv: string, other: string;
  beforeAll(async () => {
    [{ create_group: conv }] = await as<{ create_group: string }>(both, `select create_group($1, 'Team A', '{}')`, [cidA]);
    [{ create_group: other }] = await as<{ create_group: string }>(both, `select create_group($1, 'Other A', '{}')`, [cidA]);
  });

  it("a message takes its conversation's company_id", async () => {
    const [m] = await as<{ company_id: string }>(both, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'hello') returning company_id`, [conv, cidA]);
    expect(m.company_id).toBe(cidA);
    // RLS already blocks a wrong company_id from the client; the trigger guarantees it for server code too
    const [s] = await sys<{ company_id: string }>(`insert into messages (conversation_id, company_id, sender_id, body) values ($1, $2, $3, 'svc') returning company_id`, [conv, cidB, both]);
    expect(s.company_id).toBe(cidA);
  });

  it("COMMS-03: attachments must be in the conversation's folder and ≤ 25 MB", async () => {
    await as(both, `insert into messages (conversation_id, company_id, attachment_path, attachment_name, attachment_size) values ($1, $2, $3, 'a.pdf', 1024)`,
      [conv, cidA, `${cidA}/${conv}/1-a.pdf`]);
    await expect(as(both, `insert into messages (conversation_id, company_id, attachment_path) values ($1, $2, $3)`, [conv, cidA, `${cidA}/${other}/1-a.pdf`]))
      .rejects.toThrow(/conversation's folder/);
    await expect(as(both, `insert into messages (conversation_id, company_id, attachment_path, attachment_size) values ($1, $2, $3, $4)`,
      [conv, cidA, `${cidA}/${conv}/2-big.zip`, 25 * 1024 * 1024 + 1])).rejects.toThrow(/attachment_size/);
    const [{ file_size_limit }] = await sys<{ file_size_limit: string }>(`select file_size_limit from storage.buckets where id = 'chat'`);
    expect(Number(file_size_limit)).toBe(25 * 1024 * 1024);
  });

  it("a reply can only quote a message from the same conversation", async () => {
    const [m] = await as<{ id: string }>(both, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'q') returning id`, [other, cidA]);
    await expect(as(both, `insert into messages (conversation_id, company_id, body, reply_to_id) values ($1, $2, 'r', $3)`, [conv, cidA, m.id]))
      .rejects.toThrow(/same conversation/);
  });

  it("only members of the company can be added to its conversations", async () => {
    await expect(as(both, `insert into conversation_members (conversation_id, user_id, company_id) values ($1, $2, $3)`, [conv, alice, cidA]))
      .rejects.toThrow(/row-level security|Only members of this company/);
  });

  it("an activated employee joins their department channel whatever the order of linking and membership", async () => {
    const [dept] = await sys<{ id: string }>(`select id from departments where company_id = $1 order by name limit 1`, [cidA]);
    const [e] = await sys<{ id: string }>(`insert into employees (company_id, first_name, email, date_of_joining, department_id) values ($1, 'Alice', 'alice@a.in', '2025-01-01', $2) returning id`, [cidA, dept.id]);
    // the invite flow: link the user first, add the membership second
    await sys(`update employees set user_id = $1 where id = $2`, [alice, e.id]);
    expect(await sys(`select * from conversation_members where user_id = $1`, [alice])).toHaveLength(0);
    await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee')`, [cidA, alice]);
    const channels = await sys<{ kind: string }>(`select c.kind from conversation_members cm join conversations c on c.id = cm.conversation_id where cm.user_id = $1`, [alice]);
    expect(channels.map((c) => c.kind)).toEqual(["department"]);
  });

  it("stars take the message's company", async () => {
    const [m] = await as<{ id: string }>(both, `insert into messages (conversation_id, company_id, body) values ($1, $2, 'star me') returning id`, [conv, cidA]);
    const [s] = await as<{ company_id: string }>(both, `insert into message_stars (message_id, company_id) values ($1, $2) returning company_id`, [m.id, cidA]);
    expect(s.company_id).toBe(cidA);
  });
});

describe("company_id and RLS on every task and chat table", () => {
  it("each table has a NOT NULL company_id and RLS enabled", async () => {
    const rows = await asOwnerUser(db, both, async () => (await db.query<{ t: string; rls: boolean; nullable: string }>(
      `select c.relname t, c.relrowsecurity rls, col.is_nullable nullable from pg_class c
       join information_schema.columns col on col.table_name = c.relname and col.column_name = 'company_id' and col.table_schema = 'public'
       where c.relname in ('tasks','task_assignees','task_comments','task_attachments','task_activity','task_checklist','task_dependencies',
         'task_time_logs','task_templates','conversations','conversation_members','messages','message_stars') order by 1`)).rows);
    expect(rows).toHaveLength(13);
    expect(rows.every((r) => r.rls && r.nullable === "NO")).toBe(true);
  });
});
