import "server-only";
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Who is signed in, read from the session token's verified claims (getClaims). With the project's
// asymmetric (ES256) signing keys this is checked locally, so it costs no request to Supabase Auth.
export type AuthUser = { id: string; email: string | null; aal: string | null; mfaEnrolled: boolean };

export async function currentUser(supabase: SupabaseClient): Promise<AuthUser | null> {
  const { data, error } = await supabase.auth.getClaims();
  const c = data?.claims;
  if (error || !c?.sub) return null;
  const app = (c.app_metadata ?? {}) as { mfa_enrolled?: boolean };
  return { id: c.sub, email: (c.email as string) ?? null, aal: (c.aal as string) ?? null, mfaEnrolled: !!app.mfa_enrolled };
}

// AUTH-14: someone with an authenticator app must finish the code step (aal2) before using the app
export const needsSecondFactor = (u: AuthUser) => u.mfaEnrolled && u.aal !== "aal2";

/**
 * Keep app_metadata.mfa_enrolled (carried in the token) in step with the user's verified factors.
 * Called after a factor is added or removed and at password sign-in.
 */
export async function syncMfaFlag(userId: string) {
  const admin = createAdminClient();
  const { data } = await admin.auth.admin.getUserById(userId);
  const user = data.user;
  if (!user) return;
  const enrolled = (user.factors ?? []).some((f) => f.status === "verified");
  if (!!(user.app_metadata as { mfa_enrolled?: boolean }).mfa_enrolled !== enrolled) {
    await admin.auth.admin.updateUserById(userId, { app_metadata: { ...user.app_metadata, mfa_enrolled: enrolled } });
  }
}

/** For API routes: the signed-in user (two-factor complete) or a 401 response to return. */
export async function requireApiUser(): Promise<{ user: AuthUser; supabase: SupabaseClient; error?: never } | { error: NextResponse; user?: never; supabase?: never }> {
  const supabase = await createClient();
  const user = await currentUser(supabase);
  if (!user) return { error: NextResponse.json({ error: "Sign in required" }, { status: 401 }) };
  if (needsSecondFactor(user)) return { error: NextResponse.json({ error: "Two-factor code required" }, { status: 401 }) };
  return { user, supabase };
}
