"use server";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { attempt, must, str, type ActionState } from "@/lib/actions";

// One person, several companies (migration 0023). The Super Admin adds an existing person to other
// companies, edits each company's details, and switches one company's access off or on. Every rule
// (Super Admin only, never on yourself, same-company department / designation / manager, owner
// protected, audit) is enforced by the sa_* database functions; these actions only pass the form on.

async function superAdmin(cid: string) {
  const ctx = await getCtx(cid);
  const { data } = await ctx.supabase.rpc("is_super_admin");
  if (!data) throw new Error("Only the Super Admin manages company assignments.");
  return ctx;
}

const details = (fd: FormData) => ({
  p_role: str(fd, "role"), p_department: str(fd, "department_id"), p_designation: str(fd, "designation_id"),
  p_manager: str(fd, "reporting_manager_id"), p_joining: str(fd, "date_of_joining"),
});

const done = (cid: string, eid: string, msg: string) => { revalidatePath(`/c/${cid}/employees/${eid}`); return msg; };

export async function assignCompany(cid: string, eid: string, userId: string, company: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await superAdmin(cid);
    must(await supabase.rpc("sa_assign_company", { p_user: userId, p_company: company, ...details(fd) }));
    // they may have been blocked when every company had been switched off
    await createAdminClient().auth.admin.updateUserById(userId, { ban_duration: "none" });
    return done(cid, eid, "Company assigned. They use the same login and password there.");
  });
}

export async function updateAssignment(cid: string, eid: string, userId: string, company: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await superAdmin(cid);
    must(await supabase.rpc("sa_update_assignment", { p_user: userId, p_company: company, ...details(fd) }));
    return done(cid, eid, "Saved for this company.");
  });
}

export async function setAssignmentActive(cid: string, eid: string, userId: string, company: string, active: boolean, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await superAdmin(cid);
    const left = must(await supabase.rpc("sa_set_assignment_active", { p_user: userId, p_company: company, p_active: active, p_reason: str(fd, "reason") })) as number;
    // the login itself is blocked only when no company is left; otherwise only this company closes
    await createAdminClient().auth.admin.updateUserById(userId, { ban_duration: left > 0 ? "none" : "876000h" });
    return done(cid, eid, active ? "Access to this company is back on." : left > 0
      ? "Access to this company is off. Their other companies are unchanged."
      : "Access to this company is off. It was their last company, so their login is blocked.");
  });
}
