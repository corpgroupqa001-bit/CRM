// Two independent Supabase sessions on one site address.
//
// The company session (Owners, HR, employees) uses Supabase's default cookie on
// path "/". The platform admin portal keeps its own session in a differently named cookie restricted
// to path "/admin": browsers send it only to /admin pages, and only clients created with the "admin"
// scope read it. So an admin and an employee can be signed in at the same time in one browser, and
// signing out of one leaves the other. Every server-side check still runs on whichever session a
// request carries.
export type SessionScope = "company" | "admin";

export const ADMIN_SESSION_COOKIE = "sb-admin-auth-token";
export const ADMIN_PATH = "/admin";

export function cookieOptionsFor(scope: SessionScope) {
  if (scope !== "admin") return undefined;
  return { name: ADMIN_SESSION_COOKIE, path: ADMIN_PATH, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production" };
}

/**
 * The admin portal's cookies end when the browser closes. @supabase/ssr always writes a 400-day maxAge,
 * so the lifetime is removed wherever its cookies are written (server client, middleware, browser
 * client). Removals (maxAge 0) are kept as they are.
 */
export function scopedCookieOptions<T extends { maxAge?: number; expires?: Date | number | string }>(scope: SessionScope, options: T): T {
  if (scope !== "admin" || options.maxAge === 0) return options;
  const rest = { ...options };
  delete rest.maxAge;
  delete rest.expires;
  return rest;
}
