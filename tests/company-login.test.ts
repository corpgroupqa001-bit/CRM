// Company chosen at sign-in: the server asks my_access(company) as the signed-in user and only an
// allowed answer gets through. The decision helpers and the database answers they rely on.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { asUser, createDb, createUser } from "./db";
import { companyAccessError, companyLanding, UUID_RE, type Access } from "../src/lib/auth/company-login";

const A = "3e8a7eb6-903b-4120-ad4a-f82839b965c9", B = "b1490f92-94e0-43ab-8ba0-ed9f420ca8a2";

describe("company sign-in decision", () => {
  it("lets an allowed answer through and refuses everything else", () => {
    expect(companyAccessError({ allowed: true, role: "employee" })).toBeNull();
    expect(companyAccessError({ allowed: false, reason: "not_member" })).toMatch(/doesn't have access to the selected company/);
    expect(companyAccessError({ allowed: false, reason: "membership_inactive" })).toMatch(/inactive/);
    expect(companyAccessError({ allowed: false, reason: "employee_inactive" })).toMatch(/inactive/);
    expect(companyAccessError(null)).toMatch(/doesn't have access/);
  });

  it("never names another company in the message", () => {
    for (const reason of ["not_member", "membership_inactive", "employee_inactive"]) {
      expect(companyAccessError({ allowed: false, reason })).not.toMatch(/belong to|member of|other compan/i);
    }
  });

  it("requires a real company id", () => {
    expect(UUID_RE.test(A)).toBe(true);
    for (const bad of ["", "JOBWAYS", "1 or 1=1", `${A}x`]) expect(UUID_RE.test(bad)).toBe(false);
  });

  it("lands on the selected company, never on another one", () => {
    expect(companyLanding(A, null)).toBe(`/c/${A}/dashboard`);
    expect(companyLanding(A, "/")).toBe(`/c/${A}/dashboard`);
    expect(companyLanding(A, `/c/${A}/payroll`)).toBe(`/c/${A}/payroll`);
    expect(companyLanding(A, `/c/${B}/payroll`)).toBe(`/c/${A}/dashboard`);      // deep link into another company
    expect(companyLanding(A, "/account")).toBe("/account");
    expect(companyLanding(A, "//evil.example")).toBe(`/c/${A}/dashboard`);       // no open redirect
    expect(companyLanding(A, "https://evil.example")).toBe(`/c/${A}/dashboard`);
  });

  it("never lands in the admin portal: it has its own sign-in and session", () => {
    expect(companyLanding(A, "/admin")).toBe(`/c/${A}/dashboard`);
    expect(companyLanding(A, "/admin/mfa")).toBe(`/c/${A}/dashboard`);
  });
});

describe("my_access answers used at sign-in", () => {
  let db: PGlite;
  let alpha: string, beta: string;
  const U: Record<string, string> = {};
  const access = async (who: string, cid: string) =>
    asUser(db, U[who], async () => (await db.query<{ a: Access }>(`select my_access($1) a`, [cid])).rows[0].a);

  beforeAll(async () => {
    db = await createDb();
    for (const who of ["owner", "staff", "left", "paused", "outsider"]) U[who] = await createUser(db, `${who}@corp.in`);
    alpha = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Alpha') returning id`, [U.owner])).rows[0].id;
    beta = (await db.query<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Beta') returning id`, [U.outsider])).rows[0].id;
    for (const who of ["staff", "left", "paused"]) {
      await db.query(`insert into company_members (company_id, user_id, role) values ($1, $2, 'employee')`, [alpha, U[who]]);
      await db.query(`insert into employees (company_id, user_id, first_name, email, date_of_joining) values ($1, $2, $3, $4, '2025-01-01')`,
        [alpha, U[who], who, `${who}@corp.in`]);
    }
    await db.query(`update employees set status = 'exited', last_working_day = '2026-01-31' where user_id = $1`, [U.left]);
    await db.query(`update company_members set active = false where user_id = $1`, [U.paused]);
  });

  it("a member of the selected company is allowed, with their own role", async () => {
    expect(await access("staff", alpha)).toMatchObject({ allowed: true, role: "employee" });
    expect(await access("owner", alpha)).toMatchObject({ allowed: true, role: "owner" });
  });

  it("the right password but the wrong company is refused", async () => {
    const a = await access("staff", beta);
    expect(a).toMatchObject({ allowed: false, reason: "not_member" });
    expect(companyAccessError(a)).toMatch(/doesn't have access/);
  });

  it("inactive accounts are refused", async () => {
    expect(companyAccessError(await access("left", alpha))).toMatch(/inactive/);      // exited employee
    expect(companyAccessError(await access("paused", alpha))).toMatch(/inactive/);    // membership switched off
  });

  it("a made-up company id gets nothing", async () => {
    expect(await access("staff", "00000000-0000-0000-0000-000000000000")).toMatchObject({ allowed: false, reason: "not_member" });
  });
});
