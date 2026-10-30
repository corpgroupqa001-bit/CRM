"use server";
import { revalidatePath } from "next/cache";
import { assertPerm, getCtx } from "@/lib/context";
import { attempt, must, str, type ActionState } from "@/lib/actions";

// COM-15 / AUTH-19: the Owner or the Admin decides sign-ups and project requests of any company they can
// approve in, from one list. Each decision is checked again in the database for the request's own company.
const done = (viewCid: string) => revalidatePath(`/c/${viewCid}/requests`);

export async function approveSignup(viewCid: string, cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account", "employees.assign_role");
    must(await ctx.supabase.rpc("approve_join_request", { p_request: id, p_role: str(fd, "role") ?? "employee" }));
    done(viewCid);
    return "Account approved. Now decide their projects; HR completes the employee record.";
  });
}

export async function rejectSignup(viewCid: string, cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account");
    must(await ctx.supabase.rpc("reject_join_request", { p_request: id, p_note: str(fd, "note") ?? null }));
    done(viewCid);
    return "Rejected.";
  });
}

export async function decideProject(viewCid: string, cid: string, id: string, approve: boolean, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "projects.manage_all");
    must(await ctx.supabase.rpc("decide_project_request", { p_id: id, p_approve: approve, p_note: str(fd, "note") }));
    done(viewCid);
    return approve ? "Project approved." : "Project rejected.";
  });
}
