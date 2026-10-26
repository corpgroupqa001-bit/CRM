"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { attempt, must, str, type ActionState } from "@/lib/actions";

const rv = (cid: string) => revalidatePath(`/c/${cid}/tasks`, "layout");

export async function createTask(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const r = await attempt(async () => {
    const { supabase, user } = await getCtx(cid);
    const due = str(fd, "due_at");
    const t = must(await supabase.from("tasks").insert({
      company_id: cid, project_id: str(fd, "project_id"), title: str(fd, "title"), description: str(fd, "description"),
      priority: str(fd, "priority") ?? "medium", due_at: due ? new Date(`${due}+05:30`).toISOString() : null,
      labels: (str(fd, "labels") ?? "").split(",").map((s) => s.trim()).filter(Boolean), created_by: user.id,
      status: str(fd, "status") ?? "todo", recurrence: str(fd, "recurrence"), parent_id: str(fd, "parent_id"),
      source_message_id: str(fd, "from_message"),
    }).select("id").single());
    id = t.id;
    const assignees = fd.getAll("assignees").map(String).filter(Boolean);
    if (assignees.length) {
      must(await supabase.from("task_assignees").insert(assignees.map((employee_id) => ({ task_id: id, employee_id, company_id: cid }))));
    }
    // TSK-10: link back to the chat message the task came from
    const msg = str(fd, "from_message");
    if (msg) await supabase.from("task_comments").insert({ task_id: id, company_id: cid, body: `Created from a chat message: “${(str(fd, "from_message_text") ?? "").slice(0, 300)}”` });
    // TSK-11: a template's checklist is copied onto the new task
    const tpl = str(fd, "template_id");
    if (tpl) {
      const { data: t } = await supabase.from("task_templates").select("checklist").eq("id", tpl).maybeSingle();
      if (t?.checklist?.length) await supabase.from("task_checklist").insert(t.checklist.map((item: string, i: number) => ({ task_id: id, company_id: cid, item, position: i })));
    }
  });
  if (r?.error) return r;
  rv(cid);
  redirect(`/c/${cid}/tasks/${id}`);
}

export async function updateTask(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const due = str(fd, "due_at");
    must(await supabase.from("tasks").update({
      title: str(fd, "title"), description: str(fd, "description"), priority: str(fd, "priority"), status: str(fd, "status"),
      project_id: str(fd, "project_id"), due_at: due ? new Date(`${due}+05:30`).toISOString() : null,
      labels: (str(fd, "labels") ?? "").split(",").map((s) => s.trim()).filter(Boolean), recurrence: str(fd, "recurrence"),
    }).eq("id", tid));
    rv(cid);
    return "Saved.";
  });
}

export async function setTaskStatus(cid: string, tid: string, status: string) {
  const { supabase } = await getCtx(cid);
  const { error } = await supabase.from("tasks").update({ status }).eq("id", tid);
  if (error) throw new Error(error.message);
  rv(cid);
}

export async function deleteTask(cid: string, tid: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("tasks").delete().eq("id", tid);
  rv(cid);
  redirect(`/c/${cid}/tasks`);
}

export async function setAssignees(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const want = new Set(fd.getAll("assignees").map(String).filter(Boolean));
    const { data: cur } = await supabase.from("task_assignees").select("employee_id").eq("task_id", tid);
    const have = new Set((cur ?? []).map((c) => c.employee_id));
    const add = [...want].filter((x) => !have.has(x));
    const remove = [...have].filter((x) => !want.has(x));
    if (add.length) must(await supabase.from("task_assignees").insert(add.map((employee_id) => ({ task_id: tid, employee_id, company_id: cid }))));
    if (remove.length) must(await supabase.from("task_assignees").delete().eq("task_id", tid).in("employee_id", remove));
    rv(cid);
    return "Assignees updated.";
  });
}

// TSK-05 comments with @mentions: "@Priya" matches a colleague by first or full name
export async function addComment(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const body = str(fd, "body");
    if (!body) throw new Error("Write a comment.");
    const { data: people } = await supabase.from("employee_directory").select("id, first_name, full_name").eq("company_id", cid);
    const lower = body.toLowerCase();
    const mentions = (people ?? []).filter((p) => lower.includes(`@${p.full_name.toLowerCase()}`) || new RegExp(`@${p.first_name.toLowerCase()}\\b`).test(lower)).map((p) => p.id);
    must(await supabase.from("task_comments").insert({ task_id: tid, company_id: cid, body, mentions }));
    rv(cid);
    return { ok: "Comment added." };
  });
}

export async function uploadAttachment(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file.");
    if (file.size > 50 * 1024 * 1024) throw new Error("Files must be 50 MB or smaller.");
    const path = `${cid}/${tid}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
    must(await supabase.storage.from("tasks").upload(path, file, { contentType: file.type }));
    must(await supabase.from("task_attachments").insert({ task_id: tid, company_id: cid, name: file.name, storage_path: path }));
    rv(cid);
    return "Attached.";
  });
}

export async function attachmentUrl(cid: string, path: string) {
  const { supabase } = await getCtx(cid);
  const { data } = await supabase.storage.from("tasks").createSignedUrl(path, 60);
  if (data?.signedUrl) redirect(data.signedUrl);
}

// TSK-03 checklists
export async function addChecklistItem(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const item = str(fd, "item");
    if (!item) throw new Error("Write the checklist item.");
    must(await supabase.from("task_checklist").insert({ task_id: tid, company_id: cid, item, position: Date.now() % 1_000_000 }));
    rv(cid);
    return { ok: "Added." };
  });
}

export async function toggleChecklistItem(cid: string, id: string, done: boolean) {
  const { supabase } = await getCtx(cid);
  await supabase.from("task_checklist").update({ done }).eq("id", id);
  rv(cid);
}

export async function deleteChecklistItem(cid: string, id: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("task_checklist").delete().eq("id", id);
  rv(cid);
}

// TSK-03 sub-tasks
export async function addSubtask(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, user } = await getCtx(cid);
    const title = str(fd, "title");
    if (!title) throw new Error("Give the sub-task a title.");
    const { data: parent } = await supabase.from("tasks").select("project_id").eq("id", tid).single();
    const sub = must(await supabase.from("tasks").insert({ company_id: cid, parent_id: tid, project_id: parent?.project_id, title, created_by: user.id }).select("id").single());
    const assignee = str(fd, "assignee");
    if (assignee) await supabase.from("task_assignees").insert({ task_id: sub.id, employee_id: assignee, company_id: cid });
    rv(cid);
    return { ok: "Sub-task added." };
  });
}

// TSK-03 dependencies ("blocked by")
export async function addDependency(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.from("task_dependencies").insert({ task_id: tid, blocked_by: str(fd, "blocked_by"), company_id: cid }));
    rv(cid);
    return { ok: "Dependency added." };
  });
}

export async function removeDependency(cid: string, tid: string, blockedBy: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("task_dependencies").delete().eq("task_id", tid).eq("blocked_by", blockedBy);
  rv(cid);
}

// TSK-08 time tracking: start / stop timer, or log time manually
export async function startTimer(cid: string, tid: string) {
  const { supabase, employee } = await getCtx(cid);
  if (!employee) throw new Error("No employee record.");
  // one running timer per person: stop any other first
  await supabase.from("task_time_logs").update({ ended_at: new Date().toISOString() }).eq("employee_id", employee.id).is("ended_at", null);
  await supabase.from("task_time_logs").insert({ task_id: tid, company_id: cid, employee_id: employee.id });
  rv(cid);
}

export async function stopTimer(cid: string, logId: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("task_time_logs").update({ ended_at: new Date().toISOString() }).eq("id", logId);
  rv(cid);
}

export async function logTime(cid: string, tid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, employee } = await getCtx(cid);
    if (!employee) throw new Error("No employee record.");
    const minutes = Math.round(Number(str(fd, "hours") ?? 0) * 60);
    if (!(minutes > 0)) throw new Error("Enter the time spent.");
    const date = str(fd, "date") ?? new Date().toISOString().slice(0, 10);
    const start = new Date(`${date}T09:00:00+05:30`);
    must(await supabase.from("task_time_logs").insert({ task_id: tid, company_id: cid, employee_id: employee.id,
      started_at: start.toISOString(), ended_at: new Date(start.getTime() + minutes * 60000).toISOString(), note: str(fd, "note") }));
    rv(cid);
    return { ok: "Time logged." };
  });
}

// TSK-11 templates
export async function saveTemplate(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const name = str(fd, "name"), title = str(fd, "title");
    if (!name || !title) throw new Error("Template name and task title are required.");
    must(await supabase.from("task_templates").insert({ company_id: cid, name, title, description: str(fd, "description"),
      priority: str(fd, "priority") ?? "medium", checklist: (str(fd, "checklist") ?? "").split("\n").map((x) => x.trim()).filter(Boolean) }));
    rv(cid);
    return { ok: "Template saved." };
  });
}

export async function deleteTemplate(cid: string, id: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("task_templates").delete().eq("id", id);
  rv(cid);
}
