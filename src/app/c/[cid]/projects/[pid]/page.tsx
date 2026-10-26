import Link from "next/link";
import { notFound } from "next/navigation";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Avatar, Badge, Card, Field, PageHeader, Stat, Table, Tabs } from "@/components/ui";
import { fmtDate, fmtDateTime, minutesToHm, money } from "@/lib/format";
import { addMember, archiveProject, removeMember, saveProject, setProjectStatus } from "../actions";

export const metadata = { title: "Project" };

// COM-13 project detail: overview, members, tasks, chat channel, files
export default async function ProjectPage({ params, searchParams }: { params: Promise<{ cid: string; pid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { cid, pid } = await params;
  const { tab = "overview" } = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "projects.use", "projects.manage_all");
  const { supabase, perms, company } = ctx;
  const { data: p } = await supabase.from("projects").select("*").eq("id", pid).eq("company_id", cid).maybeSingle();
  if (!p) notFound();
  const [{ data: canManage }, { data: members }, { data: people }, { data: tasks }, { data: conv }, { data: files }] = await Promise.all([
    supabase.rpc("can_manage_project", { pid }),
    supabase.from("project_members").select("employee_id, added_at").eq("project_id", pid),
    supabase.from("employee_directory").select("id, full_name, emp_code, designation, photo_url").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("tasks").select("id, title, status, priority, due_at").eq("project_id", pid).order("due_at", { ascending: true, nullsFirst: false }),
    supabase.from("conversations").select("id").eq("project_id", pid).maybeSingle(),
    supabase.from("task_attachments").select("id, name, created_at, task_id, tasks!inner(project_id)").eq("tasks.project_id", pid).order("created_at", { ascending: false }),
  ]);
  const byId = new Map((people ?? []).map((x) => [x.id, x]));
  const memberIds = new Set((members ?? []).map((m) => m.employee_id));
  const manager = byId.get(p.manager_id);
  const done = (tasks ?? []).filter((t) => t.status === "done").length;
  const overdue = (tasks ?? []).filter((t) => t.status !== "done" && t.due_at && t.due_at < new Date().toISOString()).length;
  const base = `/c/${cid}/projects/${pid}`;

  let body: React.ReactNode = null;
  if (tab === "overview") {
    body = (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Stat label="Tasks" value={tasks?.length ?? 0} /><Stat label="Done" value={`${done} (${tasks?.length ? Math.round((done / tasks.length) * 100) : 0}%)`} tone="green" />
          <Stat label="Overdue" value={overdue} tone={overdue ? "red" : "slate"} /><Stat label="Members" value={memberIds.size} />
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Details">
            <dl className="space-y-2 text-sm">
              {[["Client", p.client ?? "—"], ["Manager", manager?.full_name ?? "—"], ["Start", fmtDate(p.start_date)], ["End", fmtDate(p.end_date)]].map(([k, v]) =>
                <div key={k} className="flex justify-between"><dt className="text-slate-500">{k}</dt><dd>{v}</dd></div>)}
            </dl>
            {p.description && <p className="mt-4 whitespace-pre-wrap text-sm text-slate-700">{p.description}</p>}
          </Card>
          {canManage && (
            <Card title="Edit project">
              <ActionForm action={saveProject.bind(null, cid)} className="grid gap-3 sm:grid-cols-2">
                <input type="hidden" name="id" value={pid} />
                <Field label="Name"><input className="input" name="name" defaultValue={p.name} required /></Field>
                <Field label="Client"><input className="input" name="client" defaultValue={p.client ?? ""} /></Field>
                <Field label="Start"><input className="input" type="date" name="start_date" defaultValue={p.start_date ?? ""} /></Field>
                <Field label="End"><input className="input" type="date" name="end_date" defaultValue={p.end_date ?? ""} /></Field>
                <Field label="Manager"><select className="input" name="manager_id" defaultValue={p.manager_id ?? ""}><option value="">—</option>{(people ?? []).map((x) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></Field>
                <Field label="Status"><select className="input" name="status" defaultValue={p.status}>{["planned", "active", "on_hold", "completed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select></Field>
                <Field label="Description" className="sm:col-span-2"><textarea className="input" name="description" rows={3} defaultValue={p.description ?? ""} /></Field>
                <div className="sm:col-span-2 flex justify-between"><SubmitButton>Save</SubmitButton></div>
              </ActionForm>
              <form action={archiveProject.bind(null, cid, pid, !p.archived)} className="mt-3"><button className="text-sm text-slate-500 hover:underline">{p.archived ? "Restore project" : "Archive project"}</button></form>
            </Card>
          )}
        </div>
      </div>
    );
  }
  if (tab === "members") {
    body = (
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Members" pad={false} className="lg:col-span-2">
          <Table head={["Member", "Designation", "Added", ""]}>
            {(members ?? []).map((m) => {
              const e = byId.get(m.employee_id);
              return <tr key={m.employee_id}><td className="td"><span className="flex items-center gap-2"><Avatar name={e?.full_name ?? "?"} url={e?.photo_url} size={26} />{e?.full_name}</span></td>
                <td className="td">{e?.designation ?? "—"}</td><td className="td">{fmtDate(m.added_at)}</td>
                <td className="td text-right">{canManage && <form action={removeMember.bind(null, cid, pid, m.employee_id)}><button className="text-sm text-rose-600">Remove</button></form>}</td></tr>;
            })}
          </Table>
        </Card>
        {canManage && (
          <Card title="Add members">
            <ActionForm action={addMember.bind(null, cid, pid)} className="space-y-3">
              <select name="employee_id" multiple className="input h-56">{(people ?? []).filter((x) => !memberIds.has(x.id)).map((x) => <option key={x.id} value={x.id}>{x.full_name} ({x.emp_code})</option>)}</select>
              <p className="text-xs text-slate-500">Hold Ctrl / ⌘ to select several.</p>
              <SubmitButton className="btn-primary w-full">Add</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    );
  }
  if (tab === "tasks") {
    body = (
      <Card pad={false} actions={<Link href={`/c/${cid}/tasks?project=${pid}&new=1`} className="btn-primary btn-sm">+ Task</Link>} title="Tasks">
        <Table head={["Task", "Priority", "Due", "Status"]}>
          {(tasks ?? []).map((t) => <tr key={t.id}><td className="td"><Link href={`/c/${cid}/tasks/${t.id}`} className="hover:underline">{t.title}</Link></td>
            <td className="td"><Badge value={t.priority} /></td><td className="td">{fmtDate(t.due_at)}</td><td className="td"><Badge value={t.status} /></td></tr>)}
        </Table>
      </Card>
    );
  }
  if (tab === "files") {
    body = (
      <Card pad={false} title="Files from project tasks">
        <Table head={["File", "Task", "Uploaded"]} empty="No files yet. Attach files to the project's tasks.">
          {(files ?? []).map((f) => <tr key={f.id}><td className="td">{f.name}</td><td className="td"><Link href={`/c/${cid}/tasks/${f.task_id}`} className="text-brand-600 hover:underline">Open task</Link></td><td className="td">{fmtDateTime(f.created_at)}</td></tr>)}
        </Table>
      </Card>
    );
  }

  if (tab === "cost") {
    // COM-10: hours from task time logs × each person's hourly cost (monthly gross ÷ salary days ÷ shift hours)
    const { data: logs } = await supabase.from("task_time_logs").select("employee_id, minutes, tasks!inner(project_id)").eq("tasks.project_id", pid).not("minutes", "is", null);
    const byEmpMin = new Map<string, number>();
    for (const l of logs ?? []) byEmpMin.set(l.employee_id, (byEmpMin.get(l.employee_id) ?? 0) + (l.minutes ?? 0));
    const ids = [...byEmpMin.keys()];
    const hr = perms.has("salaries.read");
    const { data: ctcs } = hr && ids.length ? await supabase.from("employee_ctc").select("employee_id, annual_ctc, effective_from").in("employee_id", ids).order("effective_from", { ascending: false }) : { data: [] };
    const { data: shifts } = ids.length ? await supabase.from("employees").select("id, shifts(full_day_hours)").in("id", ids) : { data: [] };
    const salaryDays = company.salary_days_basis === "calendar" ? 30 : Number(company.salary_days_basis);
    const rows = ids.map((id) => {
      const ctc = (ctcs ?? []).find((c) => c.employee_id === id);
      const shift = (shifts ?? []).find((x) => x.id === id)?.shifts as unknown as { full_day_hours: number } | null;
      const hours = Number(shift?.full_day_hours ?? 8);
      const rate = ctc ? Number(ctc.annual_ctc) / 12 / salaryDays / (hours || 8) : null;
      const min = byEmpMin.get(id)!;
      return { id, name: byId.get(id)?.full_name ?? "—", min, rate, cost: rate != null ? (min / 60) * rate : null };
    }).sort((a, b) => b.min - a.min);
    const totalMin = rows.reduce((x, r) => x + r.min, 0);
    const totalCost = rows.reduce((x, r) => x + (r.cost ?? 0), 0);
    body = (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Stat label="Hours logged" value={minutesToHm(totalMin)} />
          {hr && <Stat label="Salary cost" value={money(totalCost)} tone="brand" hint="From logged hours" />}
          <Stat label="People" value={rows.length} />
        </div>
        <Card title="Hours and cost by person" pad={false}>
          <Table head={["Person", "Hours", ...(hr ? ["Hourly cost", "Cost"] : [])]} empty="No time logged on this project's tasks yet. Use the timer on a task.">
            {rows.map((r) => <tr key={r.id}><td className="td font-medium">{r.name}</td><td className="td tabular-nums">{minutesToHm(r.min)}</td>
              {hr && <><td className="td tabular-nums">{r.rate != null ? money(r.rate) : "No salary set"}</td><td className="td tabular-nums">{r.cost != null ? money(r.cost) : "—"}</td></>}</tr>)}
          </Table>
        </Card>
      </div>
    );
  }

  return (
    <>
      <PageHeader title={p.name} subtitle={<span className="flex items-center gap-2">{p.client ?? "Internal"} <Badge value={p.status} />{p.archived && <Badge value="archived" />}</span>}
        actions={<>
          {conv && <Link href={`/c/${cid}/chat/${conv.id}`} className="btn-secondary">Project chat</Link>}
          {canManage && (
            <ActionForm action={setProjectStatus.bind(null, cid, pid)} className="flex gap-2">
              <select name="status" defaultValue={p.status} className="input w-36">{["planned", "active", "on_hold", "completed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
              <SubmitButton className="btn-secondary">Set status</SubmitButton>
            </ActionForm>
          )}
        </>} />
      <Tabs active={tab} tabs={[
        { key: "overview", label: "Overview", href: base }, { key: "members", label: `Members (${memberIds.size})`, href: `${base}?tab=members` },
        { key: "tasks", label: `Tasks (${tasks?.length ?? 0})`, href: `${base}?tab=tasks` }, { key: "files", label: "Files", href: `${base}?tab=files` },
        { key: "cost", label: "Time & cost", href: `${base}?tab=cost` },
      ]} />
      {body}
    </>
  );
}
