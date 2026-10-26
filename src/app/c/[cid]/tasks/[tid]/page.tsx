import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Avatar, Badge, Card, Field, PageHeader } from "@/components/ui";
import { fmtDateTime, label } from "@/lib/format";
import {
  addChecklistItem, addComment, addDependency, addSubtask, attachmentUrl, deleteChecklistItem, deleteTask, logTime, removeDependency,
  setAssignees, startTimer, stopTimer, toggleChecklistItem, updateTask, uploadAttachment,
} from "../actions";
import { minutesToHm, todayIST } from "@/lib/format";

export const metadata = { title: "Task" };

const toLocalInput = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 5.5 * 3600000).toISOString().slice(0, 16) : "");

export default async function TaskPage({ params }: { params: Promise<{ cid: string; tid: string }> }) {
  const { cid, tid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "tasks.use", "tasks.read_all");
  const { supabase, perms, user, employee } = ctx;
  const { data: t } = await supabase.from("tasks").select("*, projects(id, name, task_statuses)").eq("id", tid).eq("company_id", cid).maybeSingle();
  if (!t) notFound();
  const [{ data: assignees }, { data: comments }, { data: files }, { data: activity }, { data: people }, { data: projects }, { data: canEdit }] = await Promise.all([
    supabase.from("task_assignees").select("employee_id").eq("task_id", tid),
    supabase.from("task_comments").select("*").eq("task_id", tid).order("created_at"),
    supabase.from("task_attachments").select("*").eq("task_id", tid).order("created_at"),
    supabase.from("task_activity").select("*").eq("task_id", tid).order("at", { ascending: false }).limit(30),
    supabase.from("employee_directory").select("id, user_id, full_name, photo_url").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("projects").select("id, name").eq("company_id", cid).eq("archived", false).order("name"),
    supabase.rpc("can_edit_task", { tid }),
  ]);
  const [{ data: subtasks }, { data: checklist }, { data: deps }, { data: logs }, { data: parent }, { data: candidates }] = await Promise.all([
    supabase.from("tasks").select("id, title, status, task_assignees(employee_id)").eq("parent_id", tid).order("created_at"),
    supabase.from("task_checklist").select("*").eq("task_id", tid).order("position"),
    supabase.from("task_dependencies").select("blocked_by, tasks!task_dependencies_blocked_by_fkey(id, title, status)").eq("task_id", tid),
    supabase.from("task_time_logs").select("*").eq("task_id", tid).order("started_at", { ascending: false }),
    t.parent_id ? supabase.from("tasks").select("id, title").eq("id", t.parent_id).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("tasks").select("id, title").eq("company_id", cid).neq("id", tid).neq("status", "done").order("created_at", { ascending: false }).limit(100),
  ]);
  // the assignee works on the task (status, checklist, comments, time); planning it — sub-tasks,
  // assignees, dependencies, deletion — needs Tasks management
  const canManage = !!canEdit && perms.has("tasks.manage");
  const doneItems = (checklist ?? []).filter((c) => c.done).length;
  const running = (logs ?? []).find((l) => !l.ended_at && l.employee_id === employee?.id);
  const totalMin = (logs ?? []).reduce((s2, l) => s2 + (l.minutes ?? 0), 0);
  const byUser = new Map((people ?? []).map((p) => [p.user_id, p]));
  const byEmp = new Map((people ?? []).map((p) => [p.id, p]));
  const assigned = new Set((assignees ?? []).map((a) => a.employee_id));
  const statuses = (t.projects as { task_statuses: string[] } | null)?.task_statuses ?? ["todo", "in_progress", "in_review", "done", "blocked"];
  const describe = (a: { action: string; details: Record<string, string> }) =>
    a.action === "status" ? `moved it from ${label(a.details.from)} to ${label(a.details.to)}`
    : a.action === "assigned" ? `assigned ${byEmp.get(a.details.employee_id)?.full_name ?? "someone"}`
    : a.action === "commented" ? "commented" : a.action === "created" ? "created the task" : "edited the task";

  return (
    <>
      <PageHeader title={t.title}
        subtitle={<span className="flex items-center gap-2"><Badge value={t.status} /><Badge value={t.priority} />
          {t.projects && <Link href={`/c/${cid}/projects/${(t.projects as { id: string }).id}`} className="text-brand-600 hover:underline">{(t.projects as { name: string }).name}</Link>}
          {parent && <span className="text-slate-500">Sub-task of <Link href={`/c/${cid}/tasks/${parent.id}`} className="text-brand-600 hover:underline">{parent.title}</Link></span>}
          {t.recurrence && <span className="text-xs text-slate-500">↻ repeats {t.recurrence}</span>}</span>}
        actions={<><Link href={`/c/${cid}/tasks`} className="btn-ghost">← Tasks</Link>
          {(perms.has("tasks.manage_all") || (t.created_by === user.id && perms.has("tasks.manage"))) &&
            <form action={deleteTask.bind(null, cid, tid)}><button className="btn-ghost text-rose-600">Delete</button></form>}</>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title="Details">
            <ActionForm action={updateTask.bind(null, cid, tid)} className="grid gap-4 md:grid-cols-2">
              <fieldset disabled={!canEdit} className="contents">
                <Field label="Title" className="md:col-span-2"><input className="input" name="title" defaultValue={t.title} required /></Field>
                <Field label="Description" className="md:col-span-2"><textarea className="input" name="description" rows={5} defaultValue={t.description ?? ""} /></Field>
                <Field label="Status"><select className="input" name="status" defaultValue={t.status}>{statuses.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></Field>
                <Field label="Priority"><select className="input" name="priority" defaultValue={t.priority}>{["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
                <Field label="Due"><input className="input" type="datetime-local" name="due_at" defaultValue={toLocalInput(t.due_at)} /></Field>
                <Field label="Project"><select className="input" name="project_id" defaultValue={t.project_id ?? ""}><option value="">No project</option>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
                <Field label="Labels"><input className="input" name="labels" defaultValue={(t.labels ?? []).join(", ")} /></Field>
                <Field label="Repeat" hint="When done, the next one is created automatically"><select className="input" name="recurrence" defaultValue={t.recurrence ?? ""}>
                  <option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
                {canEdit && <div className="md:col-span-2"><SubmitButton>Save</SubmitButton></div>}
              </fieldset>
            </ActionForm>
          </Card>
          <Card title={`Checklist${checklist?.length ? ` · ${doneItems}/${checklist.length}` : ""}`}>
            {!!checklist?.length && <div className="mb-3 h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-emerald-500" style={{ width: `${Math.round((doneItems / checklist.length) * 100)}%` }} /></div>}
            <ul className="mb-3 space-y-1">
              {(checklist ?? []).map((c) => (
                <li key={c.id} className="group flex items-center gap-2 text-sm">
                  <form action={toggleChecklistItem.bind(null, cid, c.id, !c.done)}><button className={`inline-flex h-4 w-4 items-center justify-center rounded border text-[10px] ${c.done ? "border-emerald-500 bg-emerald-500 text-white" : "border-slate-300 hover:border-slate-400"}`} aria-label="Toggle">{c.done ? "✓" : ""}</button></form>
                  <span className={`flex-1 ${c.done ? "text-slate-400 line-through" : "text-slate-700"}`}>{c.item}</span>
                  {canEdit && <form action={deleteChecklistItem.bind(null, cid, c.id)}><button className="text-xs text-slate-400 opacity-0 hover:text-rose-600 group-hover:opacity-100">Remove</button></form>}
                </li>
              ))}
            </ul>
            {canEdit && <ActionForm action={addChecklistItem.bind(null, cid, tid)} className="flex gap-2" resetOnSuccess>
              <input name="item" className="input" placeholder="Add an item" required /><SubmitButton className="btn-secondary">Add</SubmitButton></ActionForm>}
          </Card>
          <Card title={`Sub-tasks (${subtasks?.length ?? 0})`} pad={false}>
            <ul className="divide-y divide-slate-100">
              {(subtasks ?? []).map((st) => (
                <li key={st.id}><Link href={`/c/${cid}/tasks/${st.id}`} className="flex items-center justify-between gap-2 px-4 py-2.5 text-sm hover:bg-slate-50">
                  <span className={st.status === "done" ? "text-slate-400 line-through" : "font-medium text-slate-800"}>{st.title}</span>
                  <span className="flex items-center gap-2 text-xs text-slate-500">{(st.task_assignees as { employee_id: string }[]).map((a) => byEmp.get(a.employee_id)?.full_name).filter(Boolean).join(", ")}<Badge value={st.status} /></span>
                </Link></li>
              ))}
            </ul>
            {canManage && <div className="border-t border-slate-100 p-3"><ActionForm action={addSubtask.bind(null, cid, tid)} className="flex flex-wrap gap-2" resetOnSuccess>
              <input name="title" className="input min-w-48 flex-1" placeholder="Sub-task title" required />
              <select name="assignee" className="input w-44"><option value="">Unassigned</option>{(perms.has("tasks.manage") ? people ?? [] : (people ?? []).filter((p) => p.user_id === user.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
              <SubmitButton className="btn-secondary">Add sub-task</SubmitButton></ActionForm></div>}
          </Card>
          <Card title={`Comments (${comments?.length ?? 0})`}>
            <ul className="mb-4 space-y-4">
              {(comments ?? []).map((c) => {
                const a = byUser.get(c.author_id);
                return (
                  <li key={c.id} className="flex gap-3">
                    <Avatar name={a?.full_name ?? "?"} url={a?.photo_url} size={30} />
                    <div className="min-w-0 flex-1"><div className="text-sm"><span className="font-medium">{a?.full_name ?? "Someone"}</span> <span className="text-xs text-slate-500">{fmtDateTime(c.created_at)}</span></div>
                      <p className="whitespace-pre-wrap text-sm text-slate-700">{c.body.split(/(@[\w]+(?: [\w]+)?)/g).map((part: string, i: number) => part.startsWith("@") ? <span key={i} className="font-medium text-brand-600">{part}</span> : part)}</p></div>
                  </li>
                );
              })}
            </ul>
            {canEdit ? <ActionForm action={addComment.bind(null, cid, tid)} className="space-y-2" resetOnSuccess>
              <textarea name="body" rows={3} className="input" placeholder="Write a comment… use @Name to mention someone" required />
              <SubmitButton className="btn-secondary">Comment</SubmitButton>
            </ActionForm> : <p className="text-xs text-slate-500">You have view-only access to this task.</p>}
          </Card>
        </div>
        <div className="space-y-6">
          <Card title="Assignees">
            <ActionForm action={setAssignees.bind(null, cid, tid)} className="space-y-2">
              <select name="assignees" multiple className="input h-40" defaultValue={[...assigned]} disabled={!canManage}>
                {(perms.has("tasks.manage") ? people ?? [] : (people ?? []).filter((p) => assigned.has(p.id) || p.user_id === user.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
              </select>
              {canManage && <SubmitButton className="btn-secondary w-full">Update</SubmitButton>}
            </ActionForm>
          </Card>
          <Card title="Time tracked" description={`${minutesToHm(totalMin)} in total`}>
            {employee && canEdit && (running ? (
              <form action={stopTimer.bind(null, cid, running.id)} className="mb-3"><button className="btn-danger w-full">■ Stop timer (started {fmtDateTime(running.started_at)})</button></form>
            ) : (
              <form action={startTimer.bind(null, cid, tid)} className="mb-3"><button className="btn-primary w-full">▶ Start timer</button></form>
            ))}
            {employee && canEdit && <ActionForm action={logTime.bind(null, cid, tid)} className="grid grid-cols-2 gap-2" resetOnSuccess>
              <input name="hours" type="number" step="0.25" min="0.25" className="input" placeholder="Hours" required />
              <input name="date" type="date" className="input" defaultValue={todayIST()} />
              <input name="note" className="input col-span-2" placeholder="Note (optional)" />
              <SubmitButton className="btn-secondary col-span-2">Log time</SubmitButton>
            </ActionForm>}
            {!!logs?.length && <ul className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
              {logs.slice(0, 8).map((l) => <li key={l.id} className="flex justify-between gap-2"><span className="truncate">{byEmp.get(l.employee_id)?.full_name ?? "—"}{l.note ? ` · ${l.note}` : ""}</span>
                <span className="shrink-0 tabular-nums">{l.ended_at ? minutesToHm(l.minutes) : "running"}</span></li>)}
            </ul>}
          </Card>
          <Card title="Blocked by" description="This task can't be marked done until these are done.">
            <ul className="mb-3 space-y-1.5 text-sm">
              {(deps ?? []).map((d) => {
                const b = d.tasks as unknown as { id: string; title: string; status: string };
                return <li key={d.blocked_by} className="flex items-center justify-between gap-2"><Link href={`/c/${cid}/tasks/${b.id}`} className="truncate hover:underline">{b.title}</Link>
                  <span className="flex items-center gap-2"><Badge value={b.status} />{canManage && <form action={removeDependency.bind(null, cid, tid, d.blocked_by)}><button className="text-xs text-slate-400 hover:text-rose-600">✕</button></form>}</span></li>;
              })}
              {!deps?.length && <li className="text-slate-500">Nothing.</li>}
            </ul>
            {canManage && <ActionForm action={addDependency.bind(null, cid, tid)} className="flex gap-2" resetOnSuccess>
              <select name="blocked_by" className="input" required><option value="">Choose a task…</option>{(candidates ?? []).map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}</select>
              <SubmitButton className="btn-secondary">Add</SubmitButton></ActionForm>}
          </Card>
          <Card title="Attachments">
            <ul className="mb-3 space-y-1 text-sm">
              {(files ?? []).map((f) => <li key={f.id}><form action={attachmentUrl.bind(null, cid, f.storage_path)}><button className="text-brand-600 hover:underline">{f.name}</button></form></li>)}
              {!files?.length && <li className="text-slate-500">No files.</li>}
            </ul>
            {canEdit && <ActionForm action={uploadAttachment.bind(null, cid, tid)} className="space-y-2" resetOnSuccess>
              <input type="file" name="file" className="input" required /><SubmitButton className="btn-secondary w-full">Attach</SubmitButton>
            </ActionForm>}
          </Card>
          <Card title="Activity">
            <ul className="space-y-2 text-xs text-slate-600">
              {(activity ?? []).map((a) => <li key={a.id}><span className="font-medium text-slate-800">{byUser.get(a.actor_id)?.full_name ?? "System"}</span> {describe(a)} · {fmtDateTime(a.at)}</li>)}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
