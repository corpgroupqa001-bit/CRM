// AUTH-06/07 rules, against an in-memory store.
import { describe, expect, it, beforeEach } from "vitest";
import { issueOtp, verifyOtp, verifyOtpLink, hashOtp, type OtpRecord, type OtpStore } from "@/lib/auth/otp";

function memoryStore() {
  const rows: OtpRecord[] = [];
  const store: OtpStore = {
    async latest(email, purpose) {
      return [...rows].reverse().find((r) => r.email === email && r.purpose === purpose && !r.used_at && !r.invalidated_at) ?? null;
    },
    async countSince(since, by) {
      return rows.filter((r) => new Date(r.created_at) >= since && (!by.email || r.email === by.email) && (!by.ip || r.ip === by.ip)).length;
    },
    async invalidateAll(email, purpose, at) {
      rows.filter((r) => r.email === email && r.purpose === purpose && !r.used_at && !r.invalidated_at)
        .forEach((r) => (r.invalidated_at = at.toISOString()));
    },
    async insert(rec) {
      rows.push({ id: String(rows.length + 1), attempts: 0, used_at: null, invalidated_at: null, created_at: new Date().toISOString(), ...rec } as OtpRecord);
    },
    async update(id, patch) {
      Object.assign(rows.find((r) => r.id === id)!, patch);
    },
  };
  return { store, rows };
}

const T0 = new Date("2026-10-22T10:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const email = "priya@acme.in";

describe("email OTP", () => {
  let m: ReturnType<typeof memoryStore>;
  beforeEach(() => { m = memoryStore(); });

  it("issues a 6-digit code stored only as a hash", async () => {
    const { code } = await issueOtp(m.store, { email, purpose: "signup", ip: "1.1.1.1", now: T0 });
    expect(code).toMatch(/^\d{6}$/);
    expect(m.rows[0].code_hash).toBe(hashOtp(email, "signup", code));
    expect(JSON.stringify(m.rows)).not.toContain(code);
    expect(new Date(m.rows[0].expires_at).getTime() - T0.getTime()).toBe(10 * 60 * 1000);
  });

  it("works once within 10 minutes", async () => {
    const { code } = await issueOtp(m.store, { email, purpose: "signup", ip: null, now: T0 });
    await expect(verifyOtp(m.store, { email: "PRIYA@acme.in ", purpose: "signup", code, now: at(599) })).resolves.toBeTruthy();
    await expect(verifyOtp(m.store, { email, purpose: "signup", code, now: at(600) })).rejects.toThrow(/No active code/);
  });

  it("expires after 10 minutes", async () => {
    const { code } = await issueOtp(m.store, { email, purpose: "login", ip: null, now: T0 });
    await expect(verifyOtp(m.store, { email, purpose: "login", code, now: at(601) })).rejects.toThrow(/expired/);
  });

  it("is invalidated by the 5th wrong attempt", async () => {
    const { code } = await issueOtp(m.store, { email, purpose: "login", ip: null, now: T0 });
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 1; i <= 4; i++) {
      await expect(verifyOtp(m.store, { email, purpose: "login", code: wrong, now: at(i) })).rejects.toThrow(`${5 - i} attempt`);
    }
    await expect(verifyOtp(m.store, { email, purpose: "login", code: wrong, now: at(5) })).rejects.toThrow(/Too many wrong attempts/);
    await expect(verifyOtp(m.store, { email, purpose: "login", code, now: at(6) })).rejects.toThrow(/No active code/);
  });

  it("enforces the 60 s resend cooldown, and a resend invalidates the previous code", async () => {
    const { code: first } = await issueOtp(m.store, { email, purpose: "reset", ip: null, now: T0 });
    await expect(issueOtp(m.store, { email, purpose: "reset", ip: null, now: at(30) })).rejects.toThrow(/wait 30 s/);
    const { code: second } = await issueOtp(m.store, { email, purpose: "reset", ip: null, now: at(61) });
    if (first !== second) {
      await expect(verifyOtp(m.store, { email, purpose: "reset", code: first, now: at(62) })).rejects.toThrow(/Incorrect/);
    }
    await expect(verifyOtp(m.store, { email, purpose: "reset", code: second, now: at(63) })).resolves.toBeTruthy();
  });

  it("allows at most 5 emails per address and per IP per hour", async () => {
    for (let i = 0; i < 5; i++) await issueOtp(m.store, { email, purpose: "login", ip: "9.9.9.9", now: at(i * 61) });
    await expect(issueOtp(m.store, { email, purpose: "login", ip: "9.9.9.9", now: at(5 * 61) })).rejects.toThrow(/this email/);
    for (let i = 0; i < 5; i++) await issueOtp(m.store, { email: `u${i}@x.in`, purpose: "login", ip: "8.8.8.8", now: T0 });
    await expect(issueOtp(m.store, { email: "new@x.in", purpose: "login", ip: "8.8.8.8", now: T0 })).rejects.toThrow(/this network/);
    // an hour later the address can request again
    await expect(issueOtp(m.store, { email, purpose: "login", ip: "7.7.7.7", now: at(3600 + 5 * 61) })).resolves.toMatchObject({ code: expect.stringMatching(/^\d{6}$/) });
  });
});

describe("one-click verify link", () => {
  let m: ReturnType<typeof memoryStore>;
  beforeEach(() => { m = memoryStore(); });

  it("stores only a hash of the link token and verifies once", async () => {
    const { code, linkToken } = await issueOtp(m.store, { email, purpose: "signup", ip: null, now: T0 });
    expect(linkToken.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(m.rows)).not.toContain(linkToken);
    await expect(verifyOtpLink(m.store, { email, purpose: "signup", token: linkToken, now: at(30) })).resolves.toBeTruthy();
    // link and code share one record: after the link is used the code no longer works
    await expect(verifyOtpLink(m.store, { email, purpose: "signup", token: linkToken, now: at(31) })).rejects.toThrow(/already used/);
    await expect(verifyOtp(m.store, { email, purpose: "signup", code, now: at(32) })).rejects.toThrow(/No active code/);
  });

  it("expires with the code and is replaced by a resend", async () => {
    const a = await issueOtp(m.store, { email, purpose: "login", ip: null, now: T0 });
    await expect(verifyOtpLink(m.store, { email, purpose: "login", token: a.linkToken, now: at(601) })).rejects.toThrow(/expired/);
    const b = await issueOtp(m.store, { email, purpose: "login", ip: null, now: at(700) });
    await expect(verifyOtpLink(m.store, { email, purpose: "login", token: a.linkToken, now: at(701) })).rejects.toThrow(/not valid/);
    await expect(verifyOtpLink(m.store, { email, purpose: "login", token: b.linkToken, now: at(702) })).resolves.toBeTruthy();
  });

  it("cannot be used for a different purpose or email", async () => {
    const { linkToken } = await issueOtp(m.store, { email, purpose: "reset", ip: null, now: T0 });
    await issueOtp(m.store, { email: "other@acme.in", purpose: "reset", ip: null, now: T0 });
    await expect(verifyOtpLink(m.store, { email: "other@acme.in", purpose: "reset", token: linkToken, now: at(5) })).rejects.toThrow(/not valid/);
  });
});
