// Re-entering the password when switching company: the signed cookie that records the unlocked company.
import { beforeAll, describe, expect, it } from "vitest";
import { lastSignInAt, readCompanyLock, sessionIdOf, signCompanyLock } from "../src/lib/auth/company-lock";

const A = "3e8a7eb6-903b-4120-ad4a-f82839b965c9", B = "b1490f92-94e0-43ab-8ba0-ed9f420ca8a2";
beforeAll(() => { process.env.COMPANY_LOCK_SECRET = "test-secret"; });

describe("company lock cookie", () => {
  it("unlocks only the signed company, for the same sign-in session", async () => {
    const c = await signCompanyLock("sess-1", A);
    expect(await readCompanyLock(c, "sess-1")).toBe(A);
    expect(await readCompanyLock(c, "sess-2")).toBeNull();            // another session (signed in again elsewhere)
    expect(await readCompanyLock(undefined, "sess-1")).toBeNull();
  });

  it("can't be edited to point at another company", async () => {
    const [sid, , sig] = (await signCompanyLock("sess-1", A)).split(".");
    expect(await readCompanyLock(`${sid}.${B}.${sig}`, "sess-1")).toBeNull();
    expect(await readCompanyLock(`${sid}.${B}.forged`, "sess-1")).toBeNull();
  });

  it("reads the sign-in time and session id from the token", () => {
    expect(lastSignInAt([{ method: "password", timestamp: 100 }, { method: "totp", timestamp: 250 }])).toBe(250);
    expect(lastSignInAt(["password"])).toBe(0);
    const token = `x.${btoa(JSON.stringify({ session_id: "sess-9" }))}.y`;
    expect(sessionIdOf(token)).toBe("sess-9");
    expect(sessionIdOf("garbage")).toBeNull();
  });
});
