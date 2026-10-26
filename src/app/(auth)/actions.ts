"use server";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueOtp, normaliseEmail, OtpError, verifyOtp, verifyOtpLink, type OtpPurpose, type OtpRecord } from "@/lib/auth/otp";
import { supabaseOtpStore } from "@/lib/auth/otp-store";
import { otpEmail, sendMail } from "@/lib/email/mailer";
import {
  clientIp, ensureUser, findUserByEmail, isLockedOut, PASSWORD_RULE, recordAttempt, recordLogin,
  signInVerifiedEmail, validPassword,
} from "@/lib/auth/session";
import { errorMessage, str, type ActionState } from "@/lib/actions";
import { emailVerificationOn } from "@/lib/auth/config";
import { linkInvitedEmployee } from "@/lib/auth/accounts";
import { syncMfaFlag } from "@/lib/auth/guard";
import { latestJoinRequest } from "@/lib/join";
import { COMPANY_LOCK_COOKIE, lockCookieOptions, sessionIdOf, signCompanyLock } from "@/lib/auth/company-lock";
import { companyAccessError, companyLanding, UUID_RE, type Access } from "@/lib/auth/company-login";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const verifyUrl = (email: string, purpose: OtpPurpose, next?: string | null) =>
  `/verify?${new URLSearchParams({ email, purpose, ...(next ? { next } : {}) })}`;

/** origin of the current request, so verify links work on localhost, previews and production alike */
async function origin() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return `${h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https")}://${host}`;
}

// The email carries both the 6-digit code and a one-click verify link (same record, same rules).
async function sendCode(email: string, purpose: OtpPurpose, payload?: Record<string, unknown>, next?: string | null) {
  const { code, linkToken } = await issueOtp(supabaseOtpStore(), { email, purpose, ip: await clientIp(), payload });
  const link = `${await origin()}/verify/confirm?${new URLSearchParams({ email, purpose, token: linkToken, ...(next ? { next } : {}) })}`;
  const sent = await sendMail(otpEmail(email, code, purpose, link));
  if (!sent.ok) {
    throw new Error(process.env.NODE_ENV === "production"
      ? "We couldn't send the email. Please try again in a minute."
      : `We couldn't send the email: ${sent.error}`);
  }
}

function otpError(err: unknown): ActionState {
  if (err instanceof OtpError) return { error: err.message };
  return { error: errorMessage(err) };
}

// ---------------------------------------------------------------------------
// Sign-up (candidate): name, email, company, designation, phone → account + join request. The
// candidate can't sign in until an Administrator of that company approves them (migration 0021).
// It never creates a company or ownership.
// ---------------------------------------------------------------------------
export async function signupStart(_: ActionState, fd: FormData): Promise<ActionState> {
  const name = str(fd, "name");
  const email = normaliseEmail(str(fd, "email") ?? "");
  if (!name || !EMAIL_RE.test(email)) return { error: "Enter your name and a valid email." };
  if (fd.get("consent") !== "on") return { error: "Please agree to the privacy notice to continue." };
  if (!emailVerificationOn()) return signupWithPassword(name, email, fd);
  // with email codes on, the request itself is made on /onboarding after the address is verified
  try {
    if (await findUserByEmail(email)) return { error: "An account with this email already exists. Sign in instead." };
    await sendCode(email, "signup", { name });
  } catch (err) {
    return otpError(err);
  }
  redirect(verifyUrl(email, "signup"));
}

// verification off: create the account with a password and sign in immediately
async function signupWithPassword(name: string, email: string, fd: FormData): Promise<ActionState> {
  const password = String(fd.get("password") ?? "");
  if (!validPassword(password)) return { error: PASSWORD_RULE };
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The passwords don't match." };
  if (!str(fd, "company") || !str(fd, "department") || !str(fd, "designation")) return { error: "Choose your company, department and designation." };
  if (!str(fd, "phone")) return { error: "Enter your mobile number." };
  let userId: string | undefined;
  try {
    if (await findUserByEmail(email)) return { error: "An account with this email already exists. Sign in instead." };
    const user = await createPasswordUser(email, password, name);
    userId = user.id;
    // no linking to invited employee records here: the email isn't verified on this path, so it
    // must not unlock a company. The administrator checks the details and approves instead.
    await initProfile(user.id, name);
    // the request is made as the new user (one client instance holds the session in this request)
    const supabase = await createClient();
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    if (signInError) throw signInError;
    const { error } = await supabase.rpc("submit_join_request", joinArgs(fd, name));
    if (error) throw error;
    await supabase.auth.signOut({ scope: "local" });   // no access until approved
  } catch (err) {
    // don't leave an account behind without a request
    if (userId) await createAdminClient().auth.admin.deleteUser(userId);
    return { error: errorMessage(err) };
  }
  redirect("/login?pending=1");
}

function joinArgs(fd: FormData, name: string) {
  return { p_company: str(fd, "company"), p_full_name: name, p_phone: str(fd, "phone"), p_designation: str(fd, "designation"),
    p_department: str(fd, "department") ?? null, p_note: str(fd, "note") ?? null };
}

/** A signed-in account without a company asks to join one (used on /onboarding). */
export async function requestToJoin(_: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const name = str(fd, "name");
  if (!name) return { error: "Enter your full name." };
  const { error } = await supabase.rpc("submit_join_request", joinArgs(fd, name));
  if (error) return { error: error.message };
  redirect("/onboarding");
}

/**
 * Sign-in gate for candidates: an account with no company that is waiting for approval (or was
 * not approved) is signed straight back out. Returns the message to show, or null to continue.
 */
async function approvalGate(userId: string): Promise<string | null> {
  const admin = createAdminClient();
  const [{ count }, { data: sa }] = await Promise.all([
    admin.from("company_members").select("company_id", { count: "exact", head: true }).eq("user_id", userId).eq("active", true),
    admin.from("platform_admins").select("user_id").eq("user_id", userId).maybeSingle(),
  ]);
  if (count || sa) return null;
  const req = await latestJoinRequest(userId);
  if (req?.status === "pending") return `Your request to join ${req.company} is waiting for an administrator to approve it. You can sign in once it's approved.`;
  if (req?.status === "rejected") return `Your request to join ${req.company} was not approved${req.decision_note ? `: ${req.decision_note}` : ""}. Contact the company administrator.`;
  return null;
}

async function createPasswordUser(email: string, password: string, fullName?: string) {
  const { data, error } = await createAdminClient().auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: fullName ? { full_name: fullName } : undefined,
  });
  if (error) throw error;
  return data.user;
}

async function signInWithPassword(email: string, password: string, method: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  await recordLogin(data.user.id, method);
}

/** Consent and display name for a new account. No company or role: those come from an invitation
 * or from the platform Super Admin (companies are created only in /admin, migration 0020). */
async function initProfile(userId: string, name: string) {
  await createAdminClient().from("profiles").update({ full_name: name, consent_at: new Date().toISOString() }).eq("id", userId);
}

// AUTH-03 passwordless login
export async function loginOtpStart(_: ActionState, fd: FormData): Promise<ActionState> {
  if (!emailVerificationOn()) return { error: "Sign-in by email code is turned off. Use your password." };
  const email = normaliseEmail(str(fd, "email") ?? "");
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email." };
  try {
    // do not reveal whether the account exists; only send if it does
    if (await findUserByEmail(email)) await sendCode(email, "login", undefined, str(fd, "next"));
  } catch (err) {
    return otpError(err);
  }
  redirect(verifyUrl(email, "login", str(fd, "next")));
}

// AUTH-05 forgot password
export async function forgotStart(_: ActionState, fd: FormData): Promise<ActionState> {
  if (!emailVerificationOn()) return { error: "Password reset by email is turned off. Ask your company admin to set a new password for you." };
  const email = normaliseEmail(str(fd, "email") ?? "");
  if (!EMAIL_RE.test(email)) return { error: "Enter a valid email." };
  try {
    if (await findUserByEmail(email)) await sendCode(email, "reset");
  } catch (err) {
    return otpError(err);
  }
  redirect(verifyUrl(email, "reset"));
}

// AUTH-04 employee activation from an HR invite
export async function activateStart(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email") ?? "");
  try {
    const { data } = await createAdminClient().from("employees").select("id").ilike("email", email)
      .in("status", ["active", "notice"]).is("user_id", null).limit(1);
    if (!data?.length) return { error: "We couldn't find a pending invitation for this email. Ask HR to add you, or sign in if you already activated." };
    if (fd.get("consent") !== "on") return { error: "Please agree to the privacy notice to continue." };
    if (!emailVerificationOn()) {
      const password = String(fd.get("password") ?? "");
      if (!validPassword(password)) return { error: PASSWORD_RULE };
      if (password !== String(fd.get("confirm") ?? "")) return { error: "The passwords don't match." };
      const user = (await findUserByEmail(email)) ?? (await createPasswordUser(email, password));
      await createAdminClient().auth.admin.updateUserById(user.id, { password });
      await linkInvitedEmployee(user.id, email);
      await signInWithPassword(email, password, "invite");
    } else {
      await sendCode(email, "invite");
    }
  } catch (err) {
    return otpError(err);
  }
  redirect(emailVerificationOn() ? verifyUrl(email, "invite") : "/");
}

export async function resendCode(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email") ?? "");
  const purpose = str(fd, "purpose") as OtpPurpose;
  try {
    // carry the sign-up details / new email over to the replacement code
    const prev = await supabaseOtpStore().latest(email, purpose);
    if (purpose === "login" || purpose === "reset") {
      if (await findUserByEmail(email)) await sendCode(email, purpose);
    } else {
      await sendCode(email, purpose, prev?.payload ?? undefined);
    }
    return { ok: "A new code is on its way. The previous code no longer works." };
  } catch (err) {
    return otpError(err);
  }
}

// ---------------------------------------------------------------------------
// Verify the 6-digit code, then create / sign in the user (AUTH-09)
// ---------------------------------------------------------------------------
export async function verifyCode(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email") ?? "");
  const purpose = str(fd, "purpose") as OtpPurpose;
  const code = (str(fd, "code") ?? "").replace(/\D/g, "");
  if (code.length !== 6) return { error: "Enter the 6-digit code." };
  let target: string;
  try {
    const rec = await verifyOtp(supabaseOtpStore(), { email, purpose, code });
    target = await completeVerification(rec, str(fd, "next"));
  } catch (err) {
    return otpError(err);
  }
  redirect(target);
}

// One-click link from the email. The link opens a confirm page whose button posts here, so mail
// scanners that pre-fetch links cannot use up the token.
export async function verifyLink(_: ActionState, fd: FormData): Promise<ActionState> {
  const email = normaliseEmail(str(fd, "email") ?? "");
  const purpose = str(fd, "purpose") as OtpPurpose;
  const token = str(fd, "token") ?? "";
  let target: string;
  try {
    const rec = await verifyOtpLink(supabaseOtpStore(), { email, purpose, token });
    target = await completeVerification(rec, str(fd, "next"));
  } catch (err) {
    return otpError(err);
  }
  redirect(target);
}

/** After a verified code or link: create / sign in the user and return where to go next. */
async function completeVerification(rec: OtpRecord, next: string | null): Promise<string> {
  const email = rec.email;
  const purpose = rec.purpose;
  const admin = createAdminClient();

  if (purpose === "signup") {
    const payload = rec.payload as { name: string };
    const user = await ensureUser(email, payload.name);
    await signInVerifiedEmail(email, "signup");
    await initProfile(user.id, payload.name);
    await linkInvitedEmployee(user.id, email);
    return `/set-password?next=${encodeURIComponent("/")}&welcome=1`;
  } else if (purpose === "login") {
    if (!(await findUserByEmail(email))) throw new OtpError("not_found", "No account for this email.");
    await signInVerifiedEmail(email, "otp");
    return next && next.startsWith("/") ? next : "/";
  } else if (purpose === "reset") {
    await signInVerifiedEmail(email, "reset");
    return "/set-password?reset=1";
  } else if (purpose === "invite") {
    const user = await ensureUser(email);
    await signInVerifiedEmail(email, "invite");
    await linkInvitedEmployee(user.id, email);
    return "/set-password?welcome=1";
  } else if (purpose === "change_email") {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    const newEmail = (rec.payload as { new_email: string }).new_email;
    if (!user || rec.email !== normaliseEmail(newEmail)) throw new Error("Sign in again to change your email.");
    const { error } = await admin.auth.admin.updateUserById(user.id, { email: newEmail, email_confirm: true });
    if (error) throw error;
    await admin.from("employees").update({ email: newEmail }).eq("user_id", user.id);
    return "/account?email_changed=1";
  }
  throw new Error("Unknown verification purpose.");
}

// ---------------------------------------------------------------------------
// AUTH-02 email + password with lockout after 5 failures in 15 minutes
// ---------------------------------------------------------------------------
export async function loginPassword(_: ActionState, fd: FormData): Promise<ActionState> {
  const company = str(fd, "company") ?? "";
  const email = normaliseEmail(str(fd, "email") ?? "");
  const password = String(fd.get("password") ?? "");
  const next = str(fd, "next");
  let target = "/";
  if (!UUID_RE.test(company)) return { error: "Select your company." };
  if (!email) return { error: "Enter your work email." };
  if (!password) return { error: "Enter your password." };
  try {
    if (await isLockedOut(email)) {
      return { error: "Too many failed attempts. Try again in 15 minutes, or sign in with an email code." };
    }
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    await recordAttempt(email, !error);
    if (error) return { error: "Incorrect email or password." };
    const blocked = await approvalGate(data.user.id);
    if (blocked) {
      await supabase.auth.signOut({ scope: "local" });   // only the session just created here
      return { error: blocked };
    }
    // the selected company is checked on the server, as the signed-in user (RLS helpers, not the form)
    const { data: access, error: accessError } = await supabase.rpc("my_access", { cid: company });
    let denied = accessError ? "Couldn't check your access. Try again." : companyAccessError(access as Access);
    // the HR portal (/hr) is only for HR Managers of the selected company — their role there, from the database
    if (!denied && str(fd, "portal") === "hr" && (access as Access)?.role !== "hr") {
      denied = "This sign-in is for HR Managers of the selected company. Use the employee sign-in on the main page instead.";
    }
    if (denied) {
      await supabase.auth.signOut({ scope: "local" });   // only the session just created here
      return { error: denied };
    }
    // this sign-in session has unlocked exactly the selected company (the middleware's company lock)
    const sid = sessionIdOf(data.session.access_token);
    if (sid) (await cookies()).set(COMPANY_LOCK_COOKIE, await signCompanyLock(sid, company), lockCookieOptions);
    await createAdminClient().from("profiles").update({ last_company_id: company }).eq("id", data.user.id);
    target = companyLanding(company, next);
    await recordLogin(data.user.id, "password");
    await syncMfaFlag(data.user.id);
    if ((data.user.factors ?? []).some((f) => f.status === "verified")) {
      // the token issued above predates the flag: refresh it so the two-factor step is enforced at once
      await supabase.auth.refreshSession();
    }
  } catch (err) {
    return { error: errorMessage(err) };
  }
  redirect(target);
}

export async function setPassword(_: ActionState, fd: FormData): Promise<ActionState> {
  const password = String(fd.get("password") ?? "");
  const confirm = String(fd.get("confirm") ?? "");
  const next = str(fd, "next");
  if (!validPassword(password)) return { error: PASSWORD_RULE };
  if (password !== confirm) return { error: "The passwords don't match." };
  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };
  // AUTH-05: a reset signs out every other session
  if (fd.get("reset") === "1") await supabase.auth.signOut({ scope: "others" });
  redirect(next && next.startsWith("/") ? next : "/");
}

// AUTH-13 change email: verify the new address first
export async function changeEmailStart(_: ActionState, fd: FormData): Promise<ActionState> {
  const newEmail = normaliseEmail(str(fd, "email") ?? "");
  if (!EMAIL_RE.test(newEmail)) return { error: "Enter a valid email." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  try {
    if (await findUserByEmail(newEmail)) return { error: "That email is already used by another account." };
    if (!emailVerificationOn()) {
      const admin = createAdminClient();
      const { error } = await admin.auth.admin.updateUserById(user.id, { email: newEmail, email_confirm: true });
      if (error) throw error;
      await admin.from("employees").update({ email: newEmail }).eq("user_id", user.id);
      return { ok: "Your email address has been changed." };
    }
    await sendCode(newEmail, "change_email", { new_email: newEmail, user_id: user.id });
  } catch (err) {
    return otpError(err);
  }
  redirect(verifyUrl(newEmail, "change_email"));
}

// change password while signed in: confirm the current one first
export async function changePassword(_: ActionState, fd: FormData): Promise<ActionState> {
  const current = String(fd.get("current") ?? "");
  const password = String(fd.get("password") ?? "");
  if (!validPassword(password)) return { error: PASSWORD_RULE };
  if (password !== String(fd.get("confirm") ?? "")) return { error: "The new passwords don't match." };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) redirect("/login");
  const check = await supabase.auth.signInWithPassword({ email: user.email, password: current });
  if (check.error) return { error: "Your current password is incorrect." };
  const { error } = await supabase.auth.updateUser({ password });
  if (error) return { error: error.message };
  await supabase.auth.signOut({ scope: "others" });
  return { ok: "Password changed. Other devices have been signed out." };
}

// Sign out of this browser only (scope "local"): the same account stays signed in on other devices
// and browsers. Supabase's default is "global", which is what "Log out of all devices" is for.
export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(COMPANY_LOCK_COOKIE);
  redirect("/login");
}

/** "Sign in as another account" on a sign-in page: end this browser's company session, back to that page's form */
export async function switchAccount(back: "/" | "/login" | "/hr") {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(COMPANY_LOCK_COOKIE);
  redirect(back);
}

// AUTH-12 log out of all devices
export async function logoutAll() {
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "global" });
  (await cookies()).delete(COMPANY_LOCK_COOKIE);
  redirect("/login");
}

// NFR-06: ask the company to delete (or export) personal data
export async function requestDataAction(_: ActionState, fd: FormData): Promise<ActionState> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { error } = await supabase.from("data_requests").insert({ company_id: str(fd, "company_id"), user_id: user.id, kind: str(fd, "kind") ?? "delete", note: str(fd, "note") });
  if (error) return { error: errorMessage(error) };
  return { ok: "Request sent to the company admin. You'll be notified when it's handled." };
}

// called by the two-factor settings after adding or removing an authenticator app
export async function refreshMfaFlag() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await syncMfaFlag(user.id);
  await supabase.auth.refreshSession();   // new token carries the updated flag
}
