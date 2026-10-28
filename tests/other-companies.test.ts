// Decision of 28 Oct 2026 (migration 0047): Owner, Company Admin and HR see which other companies an employee
// works in, but only companies where they can see all employees too (NFR-04 isolation).
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addMember, asUser, createDb, createUser } from "./db";

let db: PGlite;
const U: Record<string, string> = {}, C: Record<string, string> = {};
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const others = (who: string, c = C.a) => asUser(db, U[who], async () =>
  (await db.query<{ company_name: string; emp_code: string; status: string }>(`select company_name, emp_code, status from employee_other_companies($1)`, [c])).rows);

beforeAll(async () => {
  db = await createDb();
  U.owner = await createUser(db, "owner@g.in"); U.stranger = await createUser(db, "stranger@g.in"); U.ravi = await createUser(db, "ravi@g.in");
  for (const [k, n, o] of [["a", "Alpha", U.owner], ["b", "Beta", U.owner], ["x", "Xeno (someone else's)", U.stranger]] as const) {
    [{ id: C[k] }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, $2) returning id`, [o, n]);
  }
  U.hrA = await addMember(db, C.a, "hra@g.in", "hr");            // HR of Alpha only
  U.hrAB = await addMember(db, C.a, "hrab@g.in", "hr");          // HR of Alpha and Beta
  await sys(`insert into company_members (company_id, user_id, role) values ($1, $2, 'hr')`, [C.b, U.hrAB]);
  U.mgr = await addMember(db, C.a, "mgr@g.in", "manager");
  // Ravi works in Alpha, Beta (same login) and Xeno (same email, another owner)
  for (const [k, code] of [["a", "A-005"], ["b", "B-012"], ["x", "X-001"]] as const) {
    await sys(`insert into employees (company_id, first_name, email, date_of_joining, user_id) values ($1, 'Ravi', 'ravi@g.in', '2025-01-01', $2)`, [C[k], k === "x" ? null : U.ravi]);
    await sys(`update employees set emp_code = $1 where company_id = $2 and email = 'ravi@g.in'`, [code, C[k]]);
  }
}, 120000);

describe("other companies of an employee", () => {
  it("the Owner sees their own other companies, never another owner's", async () => {
    expect(await others("owner")).toEqual([{ company_name: "Beta", emp_code: "B-012", status: "active" }]);
  });
  it("HR sees only companies where they are HR too", async () => {
    expect(await others("hrAB")).toEqual([{ company_name: "Beta", emp_code: "B-012", status: "active" }]);
    expect(await others("hrA")).toEqual([]);
  });
  it("a manager or someone outside gets nothing", async () => {
    expect(await others("mgr")).toEqual([]);
    expect(await others("stranger")).toEqual([]);
  });
  it("the other owner, from Xeno, doesn't learn about Alpha or Beta", async () => {
    expect(await others("stranger", C.x)).toEqual([]);
  });
});
