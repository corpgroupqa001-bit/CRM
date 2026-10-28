// Decision of 27 Oct 2026 (migration 0040): when HR switches PF, ESI, PT, LWF or TDS on or off, every
// Owner and Company Admin is notified, so the approver sees it before approving payroll.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addMember, asUser, createDb, createUser } from "./db";

let db: PGlite, cid: string, owner: string, admin: string, hr: string;
const notes = async (u: string) => (await db.query<{ title: string; body: string; link: string }>(
  `select title, body, link from notifications where user_id = $1 and title = 'Statutory deduction switched' order by created_at`, [u])).rows;

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@corp.in");
  [{ id: cid }] = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner])).rows;
  admin = await addMember(db, cid, "admin@corp.in", "company_admin");
  hr = await addMember(db, cid, "hr@corp.in", "hr");
  await db.query(`insert into profiles (id, full_name, email) values ($1, 'Hema HR', 'hr@corp.in') on conflict (id) do update set full_name = excluded.full_name`, [hr]);
}, 120000);

describe("statutory switches notify the approvers", () => {
  it("HR switching ESI off and PF off notifies the Owner and the Company Admin, not HR", async () => {
    await asUser(db, hr, () => db.query(`update statutory_settings set esi_enabled = false, pf_enabled = false where company_id = $1`, [cid]));
    for (const u of [owner, admin]) {
      const n = await notes(u);
      expect(n).toHaveLength(1);
      expect(n[0].body).toBe("Hema HR switched PF off, ESI off. It applies from the next payroll run; check it before you approve.");
      expect(n[0].link).toBe("/payroll/setup");
    }
    expect(await notes(hr)).toHaveLength(0);
  });

  it("switching back on is notified too; changing a rate is not", async () => {
    await asUser(db, hr, () => db.query(`update statutory_settings set esi_enabled = true where company_id = $1`, [cid]));
    await asUser(db, hr, () => db.query(`update statutory_settings set pf_employee_rate = 12 where company_id = $1`, [cid]));
    const n = await notes(owner);
    expect(n).toHaveLength(2);
    expect(n[1].body).toContain("switched ESI on");
  });

  it("the Owner still can't change the switches (BRD §5.3: Salaries R, A)", async () => {
    const r = await asUser(db, owner, () => db.query(`update statutory_settings set pf_enabled = true where company_id = $1`, [cid]));
    expect(r.affectedRows).toBe(0);
  });
});
