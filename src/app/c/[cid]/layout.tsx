import { getCtx } from "@/lib/context";
import { NAV, NAV_GROUPS, ROLE_LABEL } from "@/lib/rbac";
import { Shell } from "@/components/shell";
import { switcherCompanies } from "@/lib/company-switcher";
import { logout } from "@/app/(auth)/actions";

export default async function CompanyLayout({ children, params }: { children: React.ReactNode; params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  const { supabase, user, role, perms, company, employee } = ctx;

  const [{ data: memberships }, { data: myRecords }, { count: unread }, { data: profile }, { data: superAdmin }] = await Promise.all([
    supabase.from("company_members").select("role, companies(id, name)").eq("user_id", user.id).eq("active", true),
    supabase.from("employees").select("company_id, status, removed_at").eq("user_id", user.id),
    supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", user.id).is("read_at", null).neq("kind", "chat"),
    supabase.from("profiles").select("full_name, idle_timeout_min, last_company_id").eq("id", user.id).maybeSingle(),
    supabase.rpc("is_super_admin"),
  ]);
  if (profile && profile.last_company_id !== cid) {
    await supabase.from("profiles").update({ last_company_id: cid }).eq("id", user.id);
  }
  const companies = switcherCompanies(memberships, myRecords);   // only companies this person can open
  const name = employee ? `${employee.first_name} ${employee.last_name ?? ""}`.trim() : profile?.full_name ?? user.email ?? "";

  return (
    <Shell
      companyId={cid}
      companyName={company.name}
      logoUrl={company.logo_url}
      userName={name}
      userEmail={user.email ?? ""}
      groups={NAV_GROUPS}
      roleLabel={ROLE_LABEL[role]}
      nav={NAV.filter((n) => n.show(perms)).map(({ href, label, icon, group }) => ({ href, label, icon, group }))}
      companies={companies}
      isMultiOwner={companies.filter((c) => c.role === "owner").length >= 2}
      canAddCompany={!!superAdmin}
      unread={unread ?? 0}
      userId={user.id}
      idleMinutes={profile?.idle_timeout_min ?? 30}
      logout={logout}
    >
      {children}
    </Shell>
  );
}
