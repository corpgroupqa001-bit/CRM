// Admin portal: signed out after 15 minutes without activity (decision of 24 Oct 2026), and when the
// browser closes (its cookies are session cookies, see lib/supabase/scopes.ts). A signed cookie records
// the last admin request for this admin session; the middleware checks and renews it on every /admin
// request. Web Crypto only (runs in the middleware and in server actions).
import { hmac } from "./company-lock";

export const ADMIN_ACTIVITY_COOKIE = "cg_admin_seen";
export const ADMIN_IDLE_SECONDS = 15 * 60;
export const adminActivityCookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/admin" };

export async function signAdminActivity(sessionId: string, at = Math.floor(Date.now() / 1000)) {
  return `${sessionId}.${at}.${await hmac(`admin-activity.${sessionId}.${at}`)}`;
}

/** seconds since the last admin activity of this session, or null when missing, forged or another session's */
export async function adminIdleSeconds(cookie: string | undefined, sessionId: string, now = Math.floor(Date.now() / 1000)) {
  const [sid, at, sig] = (cookie ?? "").split(".");
  if (!sid || !at || !sig || sid !== sessionId || !/^\d+$/.test(at)) return null;
  if ((await hmac(`admin-activity.${sid}.${at}`)) !== sig) return null;
  return now - Number(at);
}

export const adminSessionExpired = (idle: number | null) => idle === null || idle > ADMIN_IDLE_SECONDS || idle < -60;
