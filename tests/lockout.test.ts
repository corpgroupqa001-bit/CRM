// AUTH-02: five failed sign-ins within 15 minutes lock the login for the company's lock time (0041),
// or until an administrator unlocks it (stored as a successful attempt). src/lib/auth/lockout.ts
import { describe, expect, it } from "vitest";
import { lockedUntil, lockoutLabel, lockTimeText } from "../src/lib/auth/lockout";

const now = Date.parse("2026-10-27T10:00:00Z");
const ago = (min: number) => new Date(now - min * 60_000).toISOString();
const fail = (min: number) => ({ success: false, at: ago(min) });
const ok = (min: number) => ({ success: true, at: ago(min) });

describe("lockedUntil", () => {
  it("four wrong passwords don't lock", () => {
    expect(lockedUntil([fail(1), fail(2), fail(3), fail(4)], 15, now)).toBeNull();
  });
  it("five within 15 minutes lock for the company's time, counted from the fifth", () => {
    const a = [fail(1), fail(2), fail(3), fail(4), fail(5)];
    expect(lockedUntil(a, 15, now)?.toISOString()).toBe(ago(-14));
    expect(lockedUntil(a, 60, now)?.toISOString()).toBe(ago(-59));
  });
  it("the lock ends after the lock time", () => {
    const a = [fail(20), fail(21), fail(22), fail(23), fail(24)];
    expect(lockedUntil(a, 15, now)).toBeNull();
    expect(lockedUntil(a, 30, now)?.toISOString()).toBe(ago(-10));
  });
  it("five spread over more than 15 minutes don't lock", () => {
    expect(lockedUntil([fail(1), fail(5), fail(10), fail(14), fail(17)], 60, now)).toBeNull();
  });
  it("a successful sign-in or an administrator's unlock starts the count again", () => {
    expect(lockedUntil([ok(0.5), fail(1), fail(2), fail(3), fail(4), fail(5)], 60, now)).toBeNull();
    expect(lockedUntil([fail(1), fail(2), ok(2.5), fail(3), fail(4), fail(5)], 60, now)).toBeNull();
  });
  it("labels and times read naturally", () => {
    expect([15, 30, 60, 1440].map(lockoutLabel)).toEqual(["15 minutes", "30 minutes", "1 hour", "24 hours"]);
    expect(lockTimeText(new Date("2026-10-27T10:15:00Z"), new Date(now))).toBe("3:45 pm");
    expect(lockTimeText(new Date("2026-10-28T10:15:00Z"), new Date(now))).toBe("28 Oct, 3:45 pm");
  });
});
