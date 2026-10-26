// Migration 0016: the dashboard's query shapes can use the new indexes.
// Seq scans are disabled so the tiny test tables still show which index the planner would pick.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asOwnerUser, createDb, createUser } from "./db";

let db: PGlite;
let ID = "";
const plan = async (sql: string) =>
  (await db.query<{ "QUERY PLAN": string }>(`explain ${sql.replaceAll("$CID", ID)}`)).rows.map((r) => r["QUERY PLAN"]).join("\n");

// realistic shape: several companies, ~1,200 employees, 3,000 tasks of which most are done
beforeAll(async () => {
  db = await createDb();
  const owner = await createUser(db, "o@x.in");
  for (let i = 0; i < 4; i++) {
    const [c] = (await asOwnerUser(db, owner, () => db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, $2) returning id`, [owner, `C${i}`]))).rows;
    if (i === 0) ID = c.id;
    await db.query(`insert into employees (company_id, first_name, email, date_of_joining, status)
      select $1, 'E' || g, 'e' || g || '@c${i}.in', '2025-01-01', case when g % 10 = 0 then 'exited' else 'active' end from generate_series(1, 300) g`, [c.id]);
    await db.query(`insert into tasks (company_id, title, status, due_at, created_by)
      select $1, 'T' || g, case when g % 20 = 0 then 'todo' else 'done' end, now() - (g || ' hours')::interval, $2 from generate_series(1, 750) g`, [c.id, owner]);
  }
  await db.exec("analyze; set enable_seqscan = off;");
}, 240000);

describe("dashboard query indexes", () => {
  it.each([
    ["Company today / 14-day trend", `select employee_id, status from daily_attendance where company_id = '$CID' and date between '2026-10-10' and '2026-10-23'`, "daily_attendance_company_date_cover"],
    ["people of a company (existing index)", `select id from employees where company_id = '$CID' and status in ('active','notice','exited') order by id limit 1000`, "on employees_company"],
    ["pending leave count", `select count(*) from leave_requests where company_id = '$CID' and status = 'pending'`, "leave_requests_company_pending"],
    ["pending corrections count", `select count(*) from regularisations where company_id = '$CID' and status = 'pending'`, "regularisations_company_pending"],
    ["overdue tasks", `select count(*) from tasks where company_id = '$CID' and status <> 'done' and due_at < now()`, "tasks_company_open_due"],
    ["offline devices", `select count(*) from devices where company_id = '$CID' and status = 'offline'`, "devices_company_status"],
    ["expiring documents", `select name from employee_documents where company_id = '$CID' and expiry_date is not null and expiry_date <= '2026-11-22'`, "employee_documents_company_expiry"],
    ["latest announcements", `select id from announcements where company_id = '$CID' order by created_at desc limit 3`, "announcements_company_created"],
    ["unread bell badge", `select count(*) from notifications where user_id = '$CID' and read_at is null and kind <> 'chat'`, "notifications_user_unread"],
  ])("%s uses %s", async (_, sql, index) => {
    expect(await plan(sql)).toContain(index);
  });

  it("the old plain (company_id, date) attendance index is gone (replaced by the covering one)", async () => {
    const r = await db.query(`select 1 from pg_indexes where indexname = 'daily_attendance_company_id_date_idx'`);
    expect(r.rows).toHaveLength(0);
  });
});
