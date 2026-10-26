import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { currentUser, needsSecondFactor } from "@/lib/auth/guard";
import type { Perm, Perms, Role } from "@/lib/rbac";

// The signed-in user from the verified session token: checked locally (ES256 keys), no request to
// Supabase Auth, and shared by the layout and page of one request (React cache).
export const getUser = cache(async () => currentUser(await createClient()));

/** Signed in, with the two-factor step done when the user has an authenticator app (AUTH-14). */
export async function requireUser() {
  const user = await getUser();
  if (!user) redirect("/login");
  if (needsSecondFactor(user)) redirect("/mfa");
  return user;
}

export type Company = {
  id: string; name: string; legal_name: string | null; logo_url: string | null; address: string | null; state: string | null;
  gstin: string | null; pan: string | null; tan: string | null; pf_reg_no: string | null; esi_reg_no: string | null;
  emp_code_prefix: string; weekly_offs: number[]; salary_days_basis: string; sandwich_paid: boolean; ot_multiplier: number;
  late_marks_to_half_day: number; payable_map: Record<string, number>; status: string; plan: string; timezone: string;
  owner_id: string; fy_start_month: number; renewal_date: string | null; employee_limit: number | null;
  payslip_password: boolean; chat_cross_dept: boolean; chat_retention_days: number;
};

// exactly the Company fields pages use (no select("*"): skips internals like next_emp_seq and timestamps)
const COMPANY_COLUMNS = "id, name, legal_name, logo_url, address, state, gstin, pan, tan, pf_reg_no, esi_reg_no, emp_code_prefix, " +
  "weekly_offs, salary_days_basis, sandwich_paid, ot_multiplier, late_marks_to_half_day, payable_map, status, plan, timezone, owner_id, " +
  "fy_start_month, renewal_date, employee_limit, payslip_password, chat_cross_dept, chat_retention_days";

/** The current user's membership, company and employee record for a company route. */
type Access = { allowed: boolean; reason?: string; role?: Role; permissions?: string[] };

/**
 * The current user's company, role, permissions and employee record for a company route.
 * Role and permissions come from the database (my_access → company_members + role_permissions),
 * never from the browser. Non-members, disabled memberships and inactive / exited employees are
 * sent to the access-denied page.
 */
export const getCtx = cache(async (companyId: string) => {
  const user = await requireUser();
  const supabase = await createClient();
  const [{ data: access, error: accessError }, { data: company }, { data: employee }] = await Promise.all([
    supabase.rpc("my_access", { cid: companyId }),
    supabase.from("companies").select(COMPANY_COLUMNS).eq("id", companyId).maybeSingle(),
    supabase.from("employees").select("id, first_name, last_name, emp_code, branch_id, department_id, mobile_attendance, status, photo_url")
      .eq("company_id", companyId).eq("user_id", user.id).maybeSingle(),
  ]);
  // fail closed: if the permission check itself fails (e.g. migration 0018 not applied), nobody gets in
  if (accessError) redirect("/denied?reason=unavailable");
  const a = access as Access | null;
  if (!a?.allowed || !a.role || !company) redirect(`/denied?reason=${a?.reason ?? "not_member"}`);
  const perms: Perms = new Set(a.permissions ?? []);
  // a platform super admin acting in a company they don't belong to: the visit itself is audited
  // (their writes are audited by the database)
  if (a.role === "super_admin") await supabase.rpc("sa_log_access", { cid: companyId });
  return { user, supabase, role: a.role, perms, company: company as unknown as Company, employee, companyId };
});

export type Ctx = Awaited<ReturnType<typeof getCtx>>;

/** true when the user holds any of the permissions */
export const can = (ctx: Pick<Ctx, "perms">, ...need: Perm[]) => need.some((p) => ctx.perms.has(p));

/** Page guard: without the permission the user gets the access-denied screen (the database refuses anyway). */
export function requirePerm(ctx: Ctx, ...need: Perm[]) {
  if (!can(ctx, ...need)) redirect(`/c/${ctx.companyId}/denied`);
}

/** Server-action guard: throws a plain message that ActionForm shows to the user. */
export function assertPerm(ctx: Ctx, ...need: Perm[]) {
  if (!can(ctx, ...need)) throw new Error("You don't have permission to do that.");
}
