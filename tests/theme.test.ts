// Light / dark preference: anything but "dark" is light, and the cookie is site-wide, a year long and not cross-site.
import { describe, expect, it } from "vitest";
import { parseTheme, themeCookie, THEME_COOKIE } from "@/lib/theme";

describe("theme preference", () => {
  it("defaults to light for a missing or unknown value", () => {
    expect(parseTheme(undefined)).toBe("light");
    expect(parseTheme("")).toBe("light");
    expect(parseTheme("blue")).toBe("light");
    expect(parseTheme("dark")).toBe("dark");
  });

  it("writes a one-year, site-wide, SameSite=Lax cookie (Secure on https)", () => {
    expect(themeCookie("dark", false)).toBe(`${THEME_COOKIE}=dark; Path=/; Max-Age=31536000; SameSite=Lax`);
    expect(themeCookie("light", true)).toMatch(/; Secure$/);
  });
});
