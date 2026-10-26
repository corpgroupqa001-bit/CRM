// Re-enter the password when switching company. A signed cookie records which company this sign-in
// session has unlocked; opening a different company needs the password again (/switch). The first
// company opened right after signing in is unlocked without asking.
// Web Crypto only, so the same code runs in the middleware (edge) and in server actions (Node).

export const COMPANY_LOCK_COOKIE = "cg_company";
/** a sign-in this recent (seconds) unlocks the first company opened without asking again */
export const FRESH_SIGN_IN_SECONDS = 10 * 60;

const enc = new TextEncoder();

/** HMAC-SHA256 of a value with the app secret (COMPANY_LOCK_SECRET or OTP_PEPPER), base64url */
export async function hmac(value: string) {
  const secret = process.env.COMPANY_LOCK_SECRET || process.env.OTP_PEPPER;
  if (!secret) throw new Error("COMPANY_LOCK_SECRET (or OTP_PEPPER) is not set");
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(value)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function signCompanyLock(sessionId: string, companyId: string) {
  return `${sessionId}.${companyId}.${await hmac(`${sessionId}.${companyId}`)}`;
}

/** the company unlocked by this cookie for this session, or null when it is missing, forged or stale */
export async function readCompanyLock(cookie: string | undefined, sessionId: string) {
  const [sid, cid, sig] = (cookie ?? "").split(".");
  if (!sid || !cid || !sig || sid !== sessionId) return null;
  return (await hmac(`${sid}.${cid}`)) === sig ? cid : null;
}

/** latest sign-in time (seconds) from the token's amr claim */
export function lastSignInAt(amr: unknown): number {
  if (!Array.isArray(amr)) return 0;
  return Math.max(0, ...amr.map((a) => (typeof a === "object" && a && "timestamp" in a ? Number((a as { timestamp: number }).timestamp) : 0)));
}

/** session id from an access token (payload only; the token was just issued by Supabase Auth) */
export function sessionIdOf(accessToken: string): string | null {
  try {
    const payload = JSON.parse(atob(accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof payload.session_id === "string" ? payload.session_id : null;
  } catch {
    return null;
  }
}

export const lockCookieOptions = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
