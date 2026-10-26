import { redirect } from "next/navigation";
import { getUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import AuthLayout from "@/app/(auth)/layout";
import { CompanySignIn } from "@/app/(auth)/login/company-sign-in";

export const metadata = { title: "Sign in" };

// The employee portal. Signed in → the last company used (or the owner view for multi-company owners).
// Signed out → the company sign-in (the same form as /login). HR has /hr, the platform operator /admin.
export default async function Home({ searchParams }: { searchParams: Promise<{ mode?: string; next?: string; pending?: string }> }) {
  const user = await getUser();
  if (user) {
    const supabase = await createClient();
    const [{ data: members }, { data: profile }] = await Promise.all([
      supabase.from("company_members").select("company_id, role").eq("user_id", user.id).eq("active", true),
      supabase.from("profiles").select("last_company_id").eq("id", user.id).maybeSingle(),
    ]);
    if (!members?.length) {
      const { data: sa } = await supabase.rpc("is_super_admin");
      redirect(sa ? "/admin" : "/onboarding");
    }
    const owned = members.filter((m) => m.role === "owner");
    if (owned.length >= 2 && !profile?.last_company_id) redirect("/owner");
    const pick = members.find((m) => m.company_id === profile?.last_company_id) ?? members[0];
    redirect(`/c/${pick.company_id}/dashboard`);
  }

  return <AuthLayout><CompanySignIn {...(await searchParams)} base="/" /></AuthLayout>;
}
