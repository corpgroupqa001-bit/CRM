import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUser, needsSecondFactor } from "@/lib/auth/guard";
import { MfaChallenge } from "@/app/mfa/challenge";

export const metadata = { title: "Two-factor authentication" };

// Two-factor step for the admin portal's own session (AUTH-14), same as /mfa for the company app.
export default async function AdminMfaPage() {
  const user = await currentUser(await createClient("admin"));
  if (!user) redirect("/admin");
  if (!needsSecondFactor(user)) redirect("/admin");
  return (
    <div className="flex min-h-screen items-center justify-center bg-white px-5">
      <div className="w-full max-w-sm">
        <span className="inline-flex rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-700">Admin portal</span>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-900">Enter your code</h1>
        <p className="mt-1.5 text-sm text-slate-500">Open your authenticator app and enter the 6-digit code for corpgroup.com.</p>
        <MfaChallenge next="/admin" scope="admin" />
      </div>
    </div>
  );
}
