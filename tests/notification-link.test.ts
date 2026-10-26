import { describe, expect, it } from "vitest";
import { notificationHref } from "../src/lib/notification-link";

const C = "e672507e-6450-49c1-ae41-4ce7bc0e79ae";

describe("notification links", () => {
  it("puts company-relative links under their company", () => {
    expect(notificationHref("/leave", C)).toBe(`/c/${C}/leave`);
    expect(notificationHref("/tasks/abc", C)).toBe(`/c/${C}/tasks/abc`);
  });
  it("never adds the company twice (sign-up approval links are stored as full paths)", () => {
    expect(notificationHref(`/c/${C}/employees/approvals`, C)).toBe(`/c/${C}/employees/approvals`);
    expect(notificationHref(`/c/${C}/dashboard`, C)).toBe(`/c/${C}/dashboard`);
  });
  it("falls back safely", () => {
    expect(notificationHref(null, C)).toBe("/");
    expect(notificationHref("https://evil.example", C)).toBe("/");
    expect(notificationHref("//evil.example", C)).toBe("/");
    expect(notificationHref("/account", null)).toBe("/account");
  });
});
