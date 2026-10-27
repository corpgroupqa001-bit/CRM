import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type JoinOptions = {
  companies: { id: string; name: string }[];
  company: { id: string; name: string } | null;
  designations: { id: string; name: string; department_id: string }[];
  departments: { id: string; name: string }[];
};

/**
 * What a candidate may pick when asking to join: active companies, and the chosen company's active
 * departments with their active designations (a department with no designation to pick is left
 * out). Read on the server (the visitor may not be signed in yet); only names and ids leave the
 * server. submit_join_request() checks the pair again.
 */
export async function joinOptions(companyId?: string | null): Promise<JoinOptions> {
  const admin = createAdminClient();
  const { data: companies } = await admin.from("companies").select("id, name").eq("status", "active").order("name");
  const company = (companies ?? []).find((c) => c.id === companyId) ?? null;
  if (!company) return { companies: companies ?? [], company: null, designations: [], departments: [] };
  const [{ data: desigs }, { data: deps }] = await Promise.all([
    admin.from("designations").select("id, name, department_id").eq("company_id", company.id).eq("active", true)
      .not("department_id", "is", null).order("name"),
    admin.from("departments").select("id, name").eq("company_id", company.id).eq("active", true).order("name"),
  ]);
  const departments = (deps ?? []).filter((d) => (desigs ?? []).some((g) => g.department_id === d.id));
  const designations = (desigs ?? []).filter((g) => departments.some((d) => d.id === g.department_id)) as JoinOptions["designations"];
  return { companies: companies ?? [], company, designations, departments };
}
