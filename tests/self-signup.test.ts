// Revised BRD v2.0 (30 Oct 2026, migration 0056): employee self sign-up with the company code (AUTH-19),
// projects chosen at sign-up or later (AUTH-18), approved project by project by the Owner or the Admin (COM-15).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addAdmin, addMember, asUser, createDb, createUser } from "./db";

let db: PGlite;
let cid: string, cidB: string, code: string, owner: string, admin: string, hr: string, ravi: string, other: string;
let pA: string, pB: string, pOther: string;
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const as = async <T = Record<string, unknown>>(who: string, sql: string, p: unknown[] = []) =>
  asUser(db, who, async () => (await db.query<T>(sql, p)).rows);
const reqs = (user: string) => sys<{ name: string; status: string }>(
  `select p.name, r.status from project_requests r join projects p on p.id = r.project_id where r.user_id = $1 order by p.name, r.created_at`, [user]);

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@corp.in");
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner]);
  [{ id: cidB }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [owner]);
  [{ join_code: code }] = await sys<{ join_code: string }>(`select join_code from companies where id = $1`, [cid]);
  admin = await addAdmin(db);
  hr = await addMember(db, cid, "hr@corp.in", "hr");
  ravi = await createUser(db, "ravi@corp.in");
  other = await createUser(db, "other@corp.in");
  await sys(`update profiles set full_name = 'Ravi Kumar' where id = $1`, [ravi]);
  [{ id: pA }] = await sys<{ id: string }>(`insert into projects (company_id, name, status) values ($1, 'Website', 'active') returning id`, [cid]);
  [{ id: pB }] = await sys<{ id: string }>(`insert into projects (company_id, name, status) values ($1, 'Store opening', 'planned') returning id`, [cid]);
  [{ id: pOther }] = await sys<{ id: string }>(`insert into projects (company_id, name, status) values ($1, 'Elsewhere', 'active') returning id`, [cidB]);
}, 120000);

describe("the company sign-up code (AUTH-19)", () => {
  it("every company has its own 8-character code", async () => {
    const codes = await sys<{ join_code: string }>(`select join_code from companies`);
    expect(codes.every((c) => /^[A-HJ-NP-Z2-9]{8}$/.test(c.join_code))).toBe(true);
    expect(new Set(codes.map((c) => c.join_code)).size).toBe(codes.length);
  });

  it("the code shows only the company's name and open projects, to anyone; a wrong code shows nothing", async () => {
    const [{ j }] = await db.transaction(async (tx) => { await tx.query(`set local role anon`); return (await tx.query<{ j: { company: string; projects: { name: string }[] } }>(`select join_code_lookup($1) j`, [code.toLowerCase()])).rows; });
    expect(j.company).toBe("Acme");
    expect(j.projects.map((p) => p.name)).toEqual(["Store opening", "Website"]);
    expect((await sys(`select join_code_lookup('NOPE1234') j`))[0]).toEqual({ j: null });
  });

  it("only the Admin changes the code; the old one stops working", async () => {
    await expect(as(owner, `select regenerate_join_code($1)`, [cid])).rejects.toThrow(/Only the Admin/);
    const [{ c }] = await as<{ c: string }>(admin, `select regenerate_join_code($1) c`, [cid]);
    expect(c).not.toBe(code);
    expect((await sys(`select join_code_lookup($1) j`, [code]))[0]).toEqual({ j: null });
    code = c;
  });
});

describe("signing up and approval (AUTH-19, AUTH-18, COM-15)", () => {
  it("Ravi signs up with the code and asks for two projects: pending, no company access", async () => {
    await sys(`select join_company_for($1, $2, 'Ravi Kumar', '9848022338', $3)`, [ravi, code, [pA, pB]]);
    expect(await sys(`select status, phone from join_requests where user_id = $1`, [ravi])).toEqual([{ status: "pending", phone: "9848022338" }]);
    expect(await reqs(ravi)).toEqual([{ name: "Store opening", status: "pending" }, { name: "Website", status: "pending" }]);
    expect((await as<{ a: { allowed: boolean } }>(ravi, `select my_access($1) a`, [cid]))[0].a.allowed).toBe(false);
    expect(await as(ravi, `select * from projects`)).toHaveLength(0);
    // the Owner and the Admin are told
    for (const u of [owner, admin]) expect(await sys(`select 1 from notifications where user_id = $1 and title = 'New sign-up waiting for approval'`, [u])).toHaveLength(1);
  });

  it("a wrong code, a project of another company, or a missing mobile is refused; nobody calls it directly", async () => {
    await expect(sys(`select join_company_for($1, 'WRONG123', 'X', '9848011111', null)`, [other])).rejects.toThrow(/not valid/);
    await expect(sys(`select join_company_for($1, $2, 'X', '9848011111', $3)`, [other, code, [pOther]])).rejects.toThrow(/not part of this company/);
    await expect(sys(`select join_company_for($1, $2, 'X', ' ', null)`, [other, code])).rejects.toThrow(/mobile/);
    await expect(as(other, `select join_company_for($1, $2, 'X', '9848011111', null)`, [other, code])).rejects.toThrow(/permission denied/);
    await expect(as(other, `select submit_join_request($1, 'X', '1', null, null, null)`, [cid])).rejects.toThrow(/sign-up link or code/);
  });

  it("a project can't be approved before the account; HR can't decide either", async () => {
    const [r] = await sys<{ id: string }>(`select id from project_requests where user_id = $1 and project_id = $2`, [ravi, pA]);
    await expect(as(admin, `select decide_project_request($1, true, null)`, [r.id])).rejects.toThrow(/Approve their account first/);
    await expect(as(hr, `select decide_project_request($1, true, null)`, [r.id])).rejects.toThrow(/Only the Owner or the Admin/);
  });

  it("the Admin approves the account and Website, rejects Store opening: Ravi sees Website only", async () => {
    const [{ id: jr }] = await sys<{ id: string }>(`select id from join_requests where user_id = $1`, [ravi]);
    await as(admin, `select approve_join_request($1, 'employee')`, [jr]);
    const [a] = await sys<{ id: string }>(`select id from project_requests where user_id = $1 and project_id = $2`, [ravi, pA]);
    const [b] = await sys<{ id: string }>(`select id from project_requests where user_id = $1 and project_id = $2`, [ravi, pB]);
    await as(admin, `select decide_project_request($1, true, null)`, [a.id]);
    await as(owner, `select decide_project_request($1, false, 'Team is full')`, [b.id]);
    expect((await as<{ name: string }>(ravi, `select name from projects`)).map((p) => p.name)).toEqual(["Website"]);
    expect((await sys<{ title: string; body: string }>(`select title, body from notifications where user_id = $1 order by created_at`, [ravi])).map((n) => n.title))
      .toEqual(["Your account was approved", "Project request approved", "Project request not approved"]);
    expect((await sys<{ action: string }>(`select action from audit_log where table_name = 'project_requests' order by at`)).map((r) => r.action)).toEqual(["approve", "reject"]);
    // the approved project's chat channel now includes Ravi
    expect(await as(ravi, `select c.name from conversations c where c.kind = 'project'`)).toEqual([{ name: "Website" }]);
  });

  it("a rejected project can be asked for again later; only real members of the company can ask", async () => {
    expect((await as<{ name: string; request_status: string | null }>(ravi, `select name, request_status from joinable_projects($1)`, [cid])))
      .toEqual([{ name: "Store opening", request_status: "rejected" }]);
    expect(await as(ravi, `select request_projects($1, $2) n`, [cid, [pB, pA]])).toEqual([{ n: 1 }]);   // Website already joined
    expect(await reqs(ravi)).toContainEqual({ name: "Store opening", status: "pending" });
    await expect(as(other, `select request_projects($1, $2)`, [cid, [pA]])).rejects.toThrow(/Only people working in this company/);
  });

  it("requests are visible to the person, the Owner and the Admin only", async () => {
    expect((await as(ravi, `select * from project_requests`)).length).toBe(3);
    expect((await as(owner, `select * from project_requests`)).length).toBe(3);
    expect((await as(admin, `select * from project_requests`)).length).toBe(3);
    expect(await as(hr, `select * from project_requests`)).toHaveLength(0);
    await expect(as(ravi, `insert into project_requests (company_id, project_id, user_id) values ($1, $2, $3)`, [cid, pB, ravi])).rejects.toThrow(/row-level security/);
  });
});

describe("a wrong mobile number (0057)", () => {
  it("is refused at sign-up", async () => {
    const u = await createUser(db, "typo@corp.in");
    await expect(sys(`select join_company_for($1, $2, 'Typo', 'ravi@demo.test', null)`, [u, code])).rejects.toThrow(/valid mobile number/);
  });

  it("an older request with one is still approved; the phone is left for HR", async () => {
    const u = await createUser(db, "old@corp.in");
    await sys(`insert into join_requests (company_id, user_id, full_name, email, phone) values ($1, $2, 'Old Request', 'old@corp.in', 'ravi@demo.test')`, [cid, u]);
    const [{ id }] = await sys<{ id: string }>(`select id from join_requests where user_id = $1`, [u]);
    await as(admin, `select approve_join_request($1, 'employee')`, [id]);
    expect(await sys(`select first_name, phone from employees where user_id = $1`, [u])).toEqual([{ first_name: "Old", phone: null }]);
  });
});

describe("rejecting a sign-up (0058)", () => {
  it("closes the person's project requests in that company; they can ask again after signing up again", async () => {
    const u = await createUser(db, "turned.away@corp.in");
    await sys(`select join_company_for($1, $2, 'Turned Away', '9848033333', $3)`, [u, code, [pA, pB]]);
    const [{ id }] = await sys<{ id: string }>(`select id from join_requests where user_id = $1`, [u]);
    await as(owner, `select reject_join_request($1, 'Not hiring')`, [id]);
    expect(await sys(`select status, decision_note from project_requests where user_id = $1`, [u]))
      .toEqual([{ status: "rejected", decision_note: "Not approved: account rejected" }, { status: "rejected", decision_note: "Not approved: account rejected" }]);
    await sys(`select join_company_for($1, $2, 'Turned Away', '9848033333', $3)`, [u, code, [pA]]);
    expect(await sys(`select count(*)::int n from project_requests where user_id = $1 and status = 'pending'`, [u])).toEqual([{ n: 1 }]);
  });
});
