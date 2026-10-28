import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { LOCK_WINDOW_MIN, lockedUntil, lockTimeText } from "@/lib/auth/lockout";

export async function clientIp() {
  const h = await headers();
  return (h.get("x-forwarded-for") ?? h.get("x-real-ip") ?? "").split(",")[0].trim() || null;
}

/** Find a Supabase auth user by email via the profiles mirror (service role). */
export async function findUserByEmail(email: string) {
  const admin = createAdminClient();
  const { data: profile } = await admin.from("profiles").select("id").eq("email", email.toLowerCase()).maybeSingle();
  if (!profile) return null;
  const { data } = await admin.auth.admin.getUserById(profile.id);
  return data.user ?? null;
}

/** Create the Supabase user if needed (email already verified by our OTP) and keep the profile row in sync. */
export async function ensureUser(email: string, fullName?: string) {
  const admin = createAdminClient();
  let user = await findUserByEmail(email);
  if (!user) {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: { full_name: fullName } });
    if (error) throw error;
    user = data.user;
  }
  await admin.from("profiles").upsert({ id: user.id, email, ...(fullName ? { full_name: fullName } : {}) });
  return user;
}

/**
 * Issue a Supabase session (JWT access + refresh tokens in cookies) for a user whose email we have
 * just verified with our own OTP (AUTH-09). Uses a one-time magic-link token generated server-side.
 */
export async function signInVerifiedEmail(email: string, method: string) {
  const admin = createAdminClient();
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (error) throw error;
  const supabase = await createClient();
  const { data: session, error: vErr } = await supabase.auth.verifyOtp({ type: "email", token_hash: data.properties.hashed_token });
  if (vErr) throw vErr;
  await recordLogin(session.user!.id, method);
  return session.user!;
}

export async function recordLogin(userId: string, method: string) {
  const h = await headers();
  await createAdminClient().from("login_history").insert({
    user_id: userId, ip: await clientIp(), user_agent: h.get("user-agent")?.slice(0, 300), method,
  });
}

// AUTH-02: password rules and lockout
export const PASSWORD_RULE = "At least 8 characters, including a number and a special character.";
export const validPassword = (p: string) => p.length >= 8 && /\d/.test(p) && /[^A-Za-z0-9]/.test(p);

/** the lock time for a login: the longest among the companies it belongs to (AUTH-02, 0041) */
async function lockMinutesFor(email: string) {
  const admin = createAdminClient();
  const { data: p } = await admin.from("profiles").select("id").eq("email", email).maybeSingle();
  if (!p) return LOCK_WINDOW_MIN;
  const { data } = await admin.from("company_members").select("companies(lockout_minutes)").eq("user_id", p.id).eq("active", true);
  return Math.max(LOCK_WINDOW_MIN, ...(data ?? []).map((m) => Number((m.companies as unknown as { lockout_minutes: number } | null)?.lockout_minutes ?? 0)));
}

/** when this login is locked until, or null when it isn't locked */
export async function lockStatus(email: string): Promise<Date | null> {
  const minutes = await lockMinutesFor(email);
  const since = new Date(Date.now() - (minutes + LOCK_WINDOW_MIN) * 60_000).toISOString();
  const { data } = await createAdminClient().from("login_attempts").select("success, at")
    .eq("email", email).gte("at", since).order("at", { ascending: false }).limit(50);
  return lockedUntil(data ?? [], minutes);
}

export const isLockedOut = async (email: string) => (await lockStatus(email)) !== null;

/** the message a locked-out person sees */
export const lockedMessage = (until: Date, extra = "") =>
  `Too many wrong passwords. Try again after ${lockTimeText(until)}${extra}, or ask your administrator to unlock your account.`;

export async function recordAttempt(email: string, success: boolean) {
  await createAdminClient().from("login_attempts").insert({ email, success, ip: await clientIp() });
}
