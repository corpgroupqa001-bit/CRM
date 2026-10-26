import { redirect } from "next/navigation";
import { getUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { CompanySignIn } from "../login/company-sign-in";

export const metadata = { title: "HR sign-in" };

// HR portal: the company sign-in limited to HR Managers of the selected company (checked on the server
// in loginPassword). HR works in the company app (/c/[cid]/…) with the company session, so an HR Manager
// who is already signed in goes straight to their company's dashboard; anyone else sees the HR sign-in.
export default async function HrPortal({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const user = await getUser();
  if (user) {
    const supabase = await createClient();
    const { data: profile } = await supabase.from("profiles").select("last_company_id").eq("id", user.id).maybeSingle();
    if (profile?.last_company_id) {
      const { data: access } = await supabase.rpc("my_access", { cid: profile.last_company_id });
      if ((access as { allowed?: boolean; role?: string } | null)?.allowed && (access as { role: string }).role === "hr") {
        redirect(`/c/${profile.last_company_id}/dashboard`);
      }
    }
  }
  return <CompanySignIn portal="hr" base="/hr" next={next} />;
}
