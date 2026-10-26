import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/** Invited employee: link every employee record with this email to the account and add membership. */
export async function linkInvitedEmployee(userId: string, email: string) {
  const admin = createAdminClient();
  const { data: emps } = await admin.from("employees").select("id, company_id, invite_role, first_name, last_name")
    .ilike("email", email).in("status", ["active", "notice"]).is("user_id", null);
  for (const e of emps ?? []) {
    await admin.from("employees").update({ user_id: userId }).eq("id", e.id);
    await admin.from("company_members").upsert(
      { company_id: e.company_id, user_id: userId, role: e.invite_role ?? "employee", active: true },
      { onConflict: "company_id,user_id" });
    await admin.from("profiles").update({ full_name: [e.first_name, e.last_name].filter(Boolean).join(" "), consent_at: new Date().toISOString() }).eq("id", userId);
  }
  return emps?.length ?? 0;
}
