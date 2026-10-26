// Admin portal: signed out after 15 minutes without activity. The signed activity stamp and the cookie
// lifetime rule (admin cookies end when the browser closes).
import { beforeAll, describe, expect, it } from "vitest";
import { ADMIN_IDLE_SECONDS, adminIdleSeconds, adminSessionExpired, signAdminActivity } from "../src/lib/auth/admin-idle";
import { scopedCookieOptions } from "../src/lib/supabase/scopes";

beforeAll(() => { process.env.COMPANY_LOCK_SECRET = "test-secret"; });

describe("admin activity stamp", () => {
  it("is fresh right after activity and expires after 15 minutes", async () => {
    const now = 1_800_000_000;
    const c = await signAdminActivity("sess-1", now);
    expect(adminSessionExpired(await adminIdleSeconds(c, "sess-1", now + 10))).toBe(false);
    expect(adminSessionExpired(await adminIdleSeconds(c, "sess-1", now + ADMIN_IDLE_SECONDS))).toBe(false);
    expect(adminSessionExpired(await adminIdleSeconds(c, "sess-1", now + ADMIN_IDLE_SECONDS + 1))).toBe(true);
  });

  it("a missing, forged or other session's stamp counts as expired", async () => {
    const now = 1_800_000_000;
    const c = await signAdminActivity("sess-1", now);
    const [sid, , sig] = c.split(".");
    expect(adminSessionExpired(await adminIdleSeconds(undefined, "sess-1", now))).toBe(true);           // sessions from before the rule
    expect(adminSessionExpired(await adminIdleSeconds(c, "sess-2", now))).toBe(true);                   // another sign-in
    expect(adminSessionExpired(await adminIdleSeconds(`${sid}.${now + 3600}.${sig}`, "sess-1", now + 3600))).toBe(true);   // edited time
    expect(adminSessionExpired(await adminIdleSeconds(`${sid}.${now}.forged`, "sess-1", now))).toBe(true);
    expect(adminSessionExpired(await adminIdleSeconds(await signAdminActivity("sess-1", now + 600), "sess-1", now))).toBe(true);   // from the future
  });
});

describe("admin cookies end with the browser", () => {
  it("drops the lifetime for admin cookies but keeps removals and the company session", () => {
    expect(scopedCookieOptions("admin", { path: "/admin", maxAge: 34560000 })).toEqual({ path: "/admin" });
    expect(scopedCookieOptions("admin", { path: "/admin", maxAge: 0 })).toEqual({ path: "/admin", maxAge: 0 });
    expect(scopedCookieOptions("company", { path: "/", maxAge: 34560000 })).toEqual({ path: "/", maxAge: 34560000 });
  });
});
