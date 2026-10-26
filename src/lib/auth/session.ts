import "server-only";
import { headers } from "next/headers";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

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

export async function isLockedOut(email: string) {
  const since = new Date(Date.now() - 15 * 60_000).toISOString();
  const { data } = await createAdminClient().from("login_attempts").select("success, at")
    .eq("email", email).gte("at", since).order("at", { ascending: false }).limit(10);
  let failures = 0;
  for (const a of data ?? []) {
    if (a.success) break;
    failures++;
  }
  return failures >= 5;
}

export async function recordAttempt(email: string, success: boolean) {
  await createAdminClient().from("login_attempts").insert({ email, success, ip: await clientIp() });
}
