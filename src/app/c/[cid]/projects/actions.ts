"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertPerm, getCtx } from "@/lib/context";
import { attempt, must, str, type ActionState } from "@/lib/actions";

// Projects (confirmed mapping): Administrator full; a Manager creates and runs the projects they lead;
// members read. RLS (can_manage_project) decides per project; these checks fail early and clearly.
async function managerCtx(cid: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "projects.manage_all", "projects.create");
  return ctx;
}
const changed = (rows: unknown[] | null) => { if (!rows?.length) throw new Error("You can only change projects you manage."); };

export async function saveProject(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  let id = str(fd, "id");
  const r = await attempt(async () => {
    const ctx = await managerCtx(cid);
    const { supabase } = ctx;
    const row = {
      company_id: cid, name: str(fd, "name"), client: str(fd, "client"), description: str(fd, "description"),
      start_date: str(fd, "start_date"), end_date: str(fd, "end_date"), manager_id: str(fd, "manager_id"), status: str(fd, "status") ?? "planned",
    };
    if (!row.name) throw new Error("Project name is required.");
    // a Manager's projects are always led by them
    if (!ctx.perms.has("projects.manage_all")) {
      if (!ctx.employee) throw new Error("You need an employee record to lead a project.");
      row.manager_id = ctx.employee.id;
    }
    if (id) changed(must(await supabase.from("projects").update(row).eq("id", id).select("id")));
    else id = must(await supabase.from("projects").insert(row).select("id").single()).id;
  });
  if (r?.error) return r;
  revalidatePath(`/c/${cid}/projects`, "layout");
  redirect(`/c/${cid}/projects/${id}`);
}

export async function setProjectStatus(cid: string, pid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await managerCtx(cid);
    changed(must(await supabase.from("projects").update({ status: str(fd, "status") }).eq("id", pid).select("id")));
    revalidatePath(`/c/${cid}/projects`, "layout");
    return "Status updated.";
  });
}

export async function archiveProject(cid: string, pid: string, archived: boolean) {
  const { supabase } = await managerCtx(cid);
  await supabase.from("projects").update({ archived }).eq("id", pid);
  revalidatePath(`/c/${cid}/projects`, "layout");
}

export async function addMember(cid: string, pid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await managerCtx(cid);
    const ids = fd.getAll("employee_id").map(String).filter(Boolean);
    if (!ids.length) throw new Error("Choose at least one person.");
    must(await supabase.from("project_members").upsert(ids.map((employee_id) => ({ project_id: pid, employee_id, company_id: cid })), { onConflict: "project_id,employee_id" }));
    revalidatePath(`/c/${cid}/projects/${pid}`);
    return "Added. They also joined the project chat channel.";
  });
}

export async function removeMember(cid: string, pid: string, eid: string) {
  const { supabase } = await managerCtx(cid);
  await supabase.from("project_members").delete().eq("project_id", pid).eq("employee_id", eid);
  revalidatePath(`/c/${cid}/projects/${pid}`);
}
