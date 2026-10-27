import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDate, label } from "@/lib/format";
import { createTask, deleteTemplate, saveTemplate } from "./actions";
import { Board } from "./board";

export const metadata = { title: "Tasks" };

type Search = { view?: string; mine?: string; project?: string; status?: string; filter?: string; q?: string; new?: string; month?: string;
  from_message?: string; text?: string; template?: string; parent?: string };
const BASE_STATUSES = ["todo", "in_progress", "in_review", "done", "blocked"];

export default async function Tasks({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<Search> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "tasks.use", "tasks.read_all");
  const { supabase, employee, perms } = ctx;
  const view = sp.view ?? "list";

  // RLS returns only the tasks this user may see
  let q = supabase.from("tasks").select("*, task_assignees(employee_id), projects(name, task_statuses)").eq("company_id", cid);
  if (sp.project) q = q.eq("project_id", sp.project);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.q) q = q.ilike("title", `%${sp.q}%`);
  if (sp.filter === "overdue") q = q.neq("status", "done").lt("due_at", new Date().toISOString());
  const [{ data: raw }, { data: people }, { data: projects }, { data: templates }] = await Promise.all([
    q.order("due_at", { ascending: true, nullsFirst: false }).limit(500),
    supabase.from("employee_directory").select("id, full_name, first_name").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("projects").select("id, name, task_statuses").eq("company_id", cid).eq("archived", false).order("name"),
    supabase.from("task_templates").select("*").eq("company_id", cid).order("name"),
  ]);
  const tpl = sp.template ? (templates ?? []).find((t) => t.id === sp.template) : null;
  const names = new Map((people ?? []).map((p) => [p.id, p.full_name]));
  type TaskRow = { id: string; title: string; status: string; priority: string; due_at: string | null; labels: string[];
    project_id: string | null; assigneeIds: string[]; projectName: string | null };
  let tasks: TaskRow[] = (raw ?? []).map((t) => ({
    ...t, assigneeIds: (t.task_assignees as { employee_id: string }[]).map((a) => a.employee_id) as string[],
    projectName: (t.projects as { name: string } | null)?.name ?? null,
  }));
  if (sp.mine && employee) tasks = tasks.filter((t) => t.assigneeIds.includes(employee.id));
  const project = sp.project ? (projects ?? []).find((p) => p.id === sp.project) : null;
  const columns = project?.task_statuses ?? BASE_STATUSES;
  const now = new Date().toISOString();
  const qs = (patch: Partial<Search>) => `?${new URLSearchParams(Object.fromEntries(Object.entries({ ...sp, ...patch, new: undefined }).filter(([, v]) => v)) as Record<string, string>)}`;
  const canAssignOthers = perms.has("tasks.manage");
  const canCreate = canAssignOthers || perms.has("tasks.create_own");   // BRD §5.3: an Employee creates tasks for themselves

  let body: React.ReactNode;
  if (view === "board") {
    body = <Board cid={cid} columns={columns} tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, due_at: t.due_at,
      project: t.projectName, assignees: t.assigneeIds.map((id) => names.get(id) ?? "").filter(Boolean) }))} />;
  } else if (view === "calendar") {
    const month = sp.month ?? now.slice(0, 7);
    const first = new Date(`${month}-01T00:00:00`);
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const lead = (first.getDay() + 6) % 7; // Monday first
    const prevM = new Date(first.getFullYear(), first.getMonth() - 1, 1), nextM = new Date(first.getFullYear(), first.getMonth() + 1, 1);
    const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const byDay = new Map<number, typeof tasks>();
    for (const t of tasks) if (t.due_at) {
      const d = new Date(new Date(t.due_at).getTime() + 5.5 * 3600000).toISOString();
      if (d.slice(0, 7) === month) byDay.set(Number(d.slice(8, 10)), [...(byDay.get(Number(d.slice(8, 10))) ?? []), t]);
    }
    body = (
      <Card title={<span className="flex items-center gap-3"><Link href={qs({ month: ym(prevM) })} className="btn-ghost btn-sm">←</Link>
        {first.toLocaleDateString("en-IN", { month: "long", year: "numeric" })}<Link href={qs({ month: ym(nextM) })} className="btn-ghost btn-sm">→</Link></span>}>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 text-xs">
          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="bg-slate-50 px-2 py-1.5 font-semibold text-slate-500">{d}</div>)}
          {Array.from({ length: lead }, (_, i) => <div key={`x${i}`} className="min-h-24 bg-surface/60" />)}
          {Array.from({ length: days }, (_, i) => (
            <div key={i} className="min-h-24 bg-surface p-1.5">
              <div className="mb-1 font-medium text-slate-500">{i + 1}</div>
              {(byDay.get(i + 1) ?? []).map((t) => (
                <Link key={t.id} href={`/c/${cid}/tasks/${t.id}`} className={`mb-1 block truncate rounded px-1.5 py-0.5 ${t.status === "done" ? "bg-emerald-50 text-emerald-700 line-through" : t.due_at! < now ? "bg-rose-50 text-rose-700" : "bg-brand-50 text-brand-700"}`}>{t.title}</Link>
              ))}
            </div>
          ))}
        </div>
      </Card>
    );
  } else if (view === "templates") {
    body = (
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Task templates" description="Reusable tasks for repeating processes, e.g. onboarding" pad={false} className="lg:col-span-2">
          <Table head={["Template", "Task title", "Checklist", ""]} empty="No templates yet.">
            {(templates ?? []).map((t) => (
              <tr key={t.id}><td className="td font-medium text-slate-900">{t.name}</td><td className="td">{t.title}</td><td className="td text-xs text-slate-500">{t.checklist.length} item(s)</td>
                <td className="td text-right"><span className="flex justify-end gap-2"><Link href={`?new=1&template=${t.id}`} className="btn-secondary btn-sm">Use</Link>
                  {canAssignOthers && <form action={deleteTemplate.bind(null, cid, t.id)}><button className="btn-ghost btn-sm text-rose-600">Delete</button></form>}</span></td></tr>
            ))}
          </Table>
        </Card>
        {canAssignOthers && (
          <Card title="New template">
            <ActionForm action={saveTemplate.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <Field label="Template name"><input className="input" name="name" placeholder="New joiner onboarding" required /></Field>
              <Field label="Task title"><input className="input" name="title" placeholder="Onboard new joiner" required /></Field>
              <Field label="Priority"><select className="input" name="priority" defaultValue="medium">{["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
              <Field label="Description"><textarea className="input" name="description" rows={2} /></Field>
              <Field label="Checklist" hint="One item per line"><textarea className="input" name="checklist" rows={5} placeholder={"Laptop issued\nEmail account created\nBiometric ID mapped"} /></Field>
              <SubmitButton className="btn-primary w-full">Save template</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    );
  } else if (view === "reports") {
    // TSK-09 reports
    const byStatus = BASE_STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length] as const);
    const overdueBy = new Map<string, number>();
    const perEmp = new Map<string, { total: number; done: number }>();
    for (const t of tasks) for (const a of t.assigneeIds) {
      const p = perEmp.get(a) ?? { total: 0, done: 0 };
      p.total++; if (t.status === "done") p.done++;
      perEmp.set(a, p);
      if (t.status !== "done" && t.due_at && t.due_at < now) overdueBy.set(a, (overdueBy.get(a) ?? 0) + 1);
    }
    const perProject = (projects ?? []).map((p) => {
      const ts = tasks.filter((t) => t.project_id === p.id);
      return { name: p.name, total: ts.length, done: ts.filter((t) => t.status === "done").length };
    }).filter((p) => p.total);
    body = (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-5">{byStatus.map(([s, n]) => <Stat key={s} label={label(s)} value={n} />)}</div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Completion by employee (workload)" pad={false}>
            <Table head={["Employee", "Assigned", "Done", "Rate", "Overdue"]}>
              {[...perEmp.entries()].sort((a, b) => b[1].total - a[1].total).map(([id, p]) => (
                <tr key={id}><td className="td">{names.get(id) ?? "—"}</td><td className="td">{p.total}</td><td className="td">{p.done}</td>
                  <td className="td">{Math.round((p.done / p.total) * 100)}%</td><td className={`td ${overdueBy.get(id) ? "font-semibold text-rose-600" : ""}`}>{overdueBy.get(id) ?? 0}</td></tr>
              ))}
            </Table>
          </Card>
          <Card title="Completion by project" pad={false}>
            <Table head={["Project", "Tasks", "Done", "Rate"]}>
              {perProject.map((p) => <tr key={p.name}><td className="td">{p.name}</td><td className="td">{p.total}</td><td className="td">{p.done}</td><td className="td">{Math.round((p.done / p.total) * 100)}%</td></tr>)}
            </Table>
          </Card>
        </div>
      </div>
    );
  } else {
    body = (
      <Card pad={false}>
        <Table head={["Task", "Project", "Assignees", "Priority", "Due", "Status"]} empty="No tasks match.">
          {tasks.map((t) => (
            <tr key={t.id} className="hover:bg-slate-50">
              <td className="td"><Link href={`/c/${cid}/tasks/${t.id}`} className="font-medium text-slate-900 hover:underline">{t.title}</Link>
                {t.labels?.length > 0 && <div className="mt-0.5 flex gap-1">{t.labels.map((l: string) => <span key={l} className="rounded bg-slate-100 px-1.5 text-[11px] text-slate-600">{l}</span>)}</div>}</td>
              <td className="td">{t.projectName ?? "—"}</td>
              <td className="td text-xs">{t.assigneeIds.map((id) => names.get(id)).filter(Boolean).join(", ") || "—"}</td>
              <td className="td"><Badge value={t.priority} /></td>
              <td className={`td whitespace-nowrap ${t.due_at && t.due_at < now && t.status !== "done" ? "font-medium text-rose-600" : ""}`}>{t.due_at ? fmtDate(t.due_at) : "—"}</td>
              <td className="td"><Badge value={t.status} /></td>
            </tr>
          ))}
        </Table>
      </Card>
    );
  }

  const views = [["list", "List"], ["board", "Board"], ["calendar", "Calendar"], ["reports", "Reports"], ["templates", "Templates"]];
  return (
    <>
      <PageHeader title="Tasks" actions={<>
        {canAssignOthers && !!templates?.length && <Link href="?view=templates" className="btn-secondary">From template</Link>}
        {canCreate && <Link href={`${qs({})}&new=1`} className="btn-primary">+ New task</Link>}</>} />
      {sp.new && canCreate && (
        <Card title="New task" className="mb-6">
          <ActionForm action={createTask.bind(null, cid)} className="grid gap-4 md:grid-cols-4">
            {sp.from_message && <input type="hidden" name="from_message" value={sp.from_message} />}
            {sp.from_message && <input type="hidden" name="from_message_text" value={sp.text ?? ""} />}
            {tpl && <input type="hidden" name="template_id" value={tpl.id} />}
            {sp.parent && <input type="hidden" name="parent_id" value={sp.parent} />}
            {tpl && <p className="rounded-lg bg-brand-50 px-3 py-2 text-sm text-brand-800 md:col-span-4">From template <b>{tpl.name}</b>{tpl.checklist.length ? ` — ${tpl.checklist.length} checklist item(s) will be added` : ""}.</p>}
            <Field label="Title" className="md:col-span-2"><input className="input" name="title" required autoFocus defaultValue={tpl?.title ?? sp.text?.slice(0, 120)} /></Field>
            <Field label="Project"><select className="input" name="project_id" defaultValue={sp.project ?? ""}><option value="">No project</option>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Priority"><select className="input" name="priority" defaultValue={tpl?.priority ?? "medium"}>{["low", "medium", "high", "urgent"].map((p) => <option key={p} value={p}>{label(p)}</option>)}</select></Field>
            <Field label="Description" className="md:col-span-2"><textarea className="input" name="description" rows={3} defaultValue={tpl?.description ?? sp.text} /></Field>
            <Field label={canAssignOthers ? "Assignees" : "Assignee"} hint={canAssignOthers ? "Ctrl / ⌘ to pick several" : "You can create tasks for yourself"}>
              <select className="input h-24" name="assignees" multiple={canAssignOthers} defaultValue={employee ? (canAssignOthers ? [employee.id] : employee.id) : undefined}>
                {(canAssignOthers ? people ?? [] : (people ?? []).filter((p) => p.id === employee?.id)).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>
            <div className="space-y-4">
              <Field label="Due"><input className="input" type="datetime-local" name="due_at" /></Field>
              <Field label="Labels" hint="comma separated"><input className="input" name="labels" /></Field>
              <Field label="Repeat"><select className="input" name="recurrence" defaultValue=""><option value="">Does not repeat</option><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></Field>
            </div>
            <div className="flex gap-2 md:col-span-4"><SubmitButton>Create task</SubmitButton><Link href={qs({})} className="btn-ghost">Cancel</Link></div>
          </ActionForm>
        </Card>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <nav aria-label="Task views" className="thin-scroll flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-surface p-1 text-sm shadow-(--shadow-card)">
          {views.map(([k, l]) => <Link key={k} href={qs({ view: k })} aria-current={view === k ? "page" : undefined} className={`whitespace-nowrap rounded-[9px] px-3 py-1.5 font-medium ${view === k ? "bg-brand-50 text-brand-700" : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"}`}>{l}</Link>)}
        </nav>
        <form className="flex flex-wrap gap-2">
          <input type="hidden" name="view" value={view} />
          <input name="q" defaultValue={sp.q} placeholder="Search" className="input w-[calc(50%-4px)] sm:w-44" aria-label="Search tasks" />
          <select name="project" defaultValue={sp.project ?? ""} className="input w-[calc(50%-4px)] sm:w-44" aria-label="Project"><option value="">All projects</option>{(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          {view === "list" && <select name="status" defaultValue={sp.status ?? ""} className="input w-36"><option value="">Any status</option>{BASE_STATUSES.map((s) => <option key={s} value={s}>{label(s)}</option>)}</select>}
          <select name="filter" defaultValue={sp.filter ?? ""} className="input w-32"><option value="">All</option><option value="overdue">Overdue</option></select>
          <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" name="mine" value="1" defaultChecked={!!sp.mine} /> My tasks</label>
          <button className="btn-secondary">Apply</button>
        </form>
      </div>
      {body}
    </>
  );
}
