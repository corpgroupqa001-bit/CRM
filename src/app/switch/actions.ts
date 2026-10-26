"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/context";
import { isLockedOut, recordAttempt, recordLogin } from "@/lib/auth/session";
import { COMPANY_LOCK_COOKIE, lockCookieOptions, sessionIdOf, signCompanyLock } from "@/lib/auth/company-lock";
import { str, type ActionState } from "@/lib/actions";

// Switching company: the password is checked again (with the usual lockout), which starts a fresh
// session, and that session is marked as having unlocked this company.
export async function unlockCompany(_: ActionState, fd: FormData): Promise<ActionState> {
  const user = await requireUser();
  const to = str(fd, "to") ?? "";
  const next = str(fd, "next");
  if (!/^[0-9a-f-]{36}$/.test(to) || !user.email) return { error: "Choose a company." };
  if (await isLockedOut(user.email)) return { error: "Too many failed attempts. Try again in 15 minutes." };
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: user.email, password: String(fd.get("password") ?? "") });
  await recordAttempt(user.email, !error);
  if (error || !data.session) return { error: "Incorrect password." };
  const sid = sessionIdOf(data.session.access_token);
  if (!sid) return { error: "Couldn't start the session. Try again." };
  (await cookies()).set(COMPANY_LOCK_COOKIE, await signCompanyLock(sid, to), lockCookieOptions);
  await recordLogin(user.id, "company_switch");
  redirect(next && next.startsWith(`/c/${to}`) ? next : `/c/${to}/dashboard`);
}
