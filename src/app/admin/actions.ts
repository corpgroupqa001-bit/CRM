"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { normaliseEmail } from "@/lib/auth/otp";
import { lockedMessage, lockStatus, recordAttempt, recordLogin } from "@/lib/auth/session";
import { syncMfaFlag } from "@/lib/auth/guard";
import { errorMessage, str, type ActionState } from "@/lib/actions";
import { sessionIdOf } from "@/lib/auth/company-lock";
import { ADMIN_ACTIVITY_COOKIE, adminActivityCookieOptions, signAdminActivity } from "@/lib/auth/admin-idle";

// Admin portal sign-in. It uses the portal's own session (cookie on path /admin), so it never replaces
// the company session an employee may have open in the same browser, and vice versa. Same password
// rules, lockout, login history and two-factor step as the company sign-in; only the platform Super
// Admin (is_super_admin(), checked with the new session) gets in.
export async function adminSignIn(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!email) return { error: "Enter your work email." };
  if (!password) return { error: "Enter your password." };
  try {
    const until = await lockStatus(email);
    if (until) return { error: lockedMessage(until) };
    const supabase = await createClient("admin");
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    await recordAttempt(email, !error);
    if (error) return { error: "Incorrect email or password." };
    const { data: superAdmin } = await supabase.rpc("is_super_admin");
    if (!superAdmin) {
      await supabase.auth.signOut({ scope: "local" });
      return { error: "This sign-in is only for the platform Super Admin. Owners, HR Managers and employees sign in on the main page." };
    }
    // first activity stamp: the session is signed out after 15 minutes without admin activity
    const sid = sessionIdOf(data.session.access_token);
    if (sid) (await cookies()).set(ADMIN_ACTIVITY_COOKIE, await signAdminActivity(sid), adminActivityCookieOptions);
    await recordLogin(data.user.id, "admin_portal");
    await syncMfaFlag(data.user.id);
    if ((data.user.factors ?? []).some((f) => f.status === "verified")) await supabase.auth.refreshSession();
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect("/admin");
}

/** Ends only the admin portal's session in this browser; a company session stays signed in. */
export async function adminSignOut() {
  const supabase = await createClient("admin");
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).set(ADMIN_ACTIVITY_COOKIE, "", { ...adminActivityCookieOptions, maxAge: 0 });
  redirect("/admin");
}
