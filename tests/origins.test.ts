import { afterEach, describe, expect, it, vi } from "vitest";
import { otherOrigin, sessionOrigins } from "../src/lib/origins";

afterEach(() => vi.unstubAllEnvs());

describe("addresses with their own sign-in", () => {
  it("defaults to localhost and 127.0.0.1 in development", () => {
    vi.stubEnv("NEXT_PUBLIC_SESSION_ORIGINS", undefined as unknown as string);
    expect(sessionOrigins()).toEqual(["http://localhost:3000", "http://127.0.0.1:3000"]);
    expect(otherOrigin("localhost:3000")).toBe("http://127.0.0.1:3000");
    expect(otherOrigin("127.0.0.1:3000")).toBe("http://localhost:3000");
  });

  it("uses the configured production domains, ignoring junk", () => {
    vi.stubEnv("NEXT_PUBLIC_SESSION_ORIGINS", "https://app.example.com/, https://app2.example.com ,javascript:alert(1),https://x.com/path");
    expect(sessionOrigins()).toEqual(["https://app.example.com", "https://app2.example.com"]);
    expect(otherOrigin("app2.example.com")).toBe("https://app.example.com");
  });

  it("offers nothing for an unknown host or a single address", () => {
    vi.stubEnv("NEXT_PUBLIC_SESSION_ORIGINS", "https://app.example.com");
    expect(otherOrigin("app.example.com")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_SESSION_ORIGINS", "https://app.example.com,https://app2.example.com");
    expect(otherOrigin("evil.example.net")).toBeNull();
    expect(otherOrigin(null)).toBeNull();
  });
});
