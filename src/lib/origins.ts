// Independent company-app sessions in one browser. A Supabase session lives in a cookie that belongs to
// one host name, so every tab on the same address shares one signed-in account. The same app served at
// a second address (another host name) has its own cookies — and so its own, fully independent session.
//
// NEXT_PUBLIC_SESSION_ORIGINS lists the addresses of this app, e.g.
//   development: http://localhost:3000,http://127.0.0.1:3000   (the default when unset)
//   production:  https://app.example.com,https://app2.example.com   (two domains on the same deployment)
// Nothing else changes: each address runs the same sign-in, two-factor, company and permission checks.

const DEV_DEFAULT = "http://localhost:3000,http://127.0.0.1:3000";

export function sessionOrigins(): string[] {
  const raw = process.env.NEXT_PUBLIC_SESSION_ORIGINS ?? (process.env.NODE_ENV === "production" ? "" : DEV_DEFAULT);
  return raw.split(",").map((s) => s.trim().replace(/\/+$/, "")).filter((s) => /^https?:\/\/[^/]+$/.test(s));
}

/** another address of this app with its own sign-in, for the host this request came to (null if none) */
export function otherOrigin(host: string | null | undefined): string | null {
  if (!host) return null;
  const list = sessionOrigins();
  if (!list.some((o) => new URL(o).host === host)) return null;   // unknown host: don't guess
  return list.find((o) => new URL(o).host !== host) ?? null;
}
