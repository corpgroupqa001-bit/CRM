import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { linkInvitedEmployee } from "@/lib/auth/accounts";
import { recordLogin } from "@/lib/auth/session";

// AUTH-16 Google sign-in: Supabase redirects here with a one-time code.
// An invited employee signing in with Google for the first time is linked to their employee record.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") ?? "/";
  if (!code) return NextResponse.redirect(new URL("/login", url.origin));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user?.email) return NextResponse.redirect(new URL("/login?error=google", url.origin));
  await linkInvitedEmployee(data.user.id, data.user.email.toLowerCase());
  await recordLogin(data.user.id, "google");
  return NextResponse.redirect(new URL(next.startsWith("/") ? next : "/", url.origin));
}
