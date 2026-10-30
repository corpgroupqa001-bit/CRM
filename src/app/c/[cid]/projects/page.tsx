import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { SavedFilters } from "@/components/saved-filters";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { saveProject } from "./actions";

export const metadata = { title: "Projects" };

type Search = { q?: string; status?: string; manager?: string; from?: string; to?: string; archived?: string; page?: string; new?: string };
const PAGE = 25;

// COM-12 projects list
export default async function Projects({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<Search> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "projects.use", "projects.manage_all");
  const { supabase, perms } = ctx;
  const page = Math.max(1, Number(sp.page ?? 1));

  let q = supabase.from("projects").select("*, project_members(count)", { count: "exact" }).eq("company_id", cid).eq("archived", sp.archived === "1");
  if (sp.q) q = q.or(`name.ilike.%${sp.q}%,client.ilike.%${sp.q}%`);
  if (sp.status) q = q.eq("status", sp.status);
  if (sp.manager) q = q.eq("manager_id", sp.manager);
  if (sp.from) q = q.gte("end_date", sp.from);
  if (sp.to) q = q.lte("start_date", sp.to);
  const [{ data: projects, count }, { data: people }, { data: tasks }] = await Promise.all([
    q.order("end_date", { ascending: true, nullsFirst: false }).range((page - 1) * PAGE, page * PAGE - 1),
    supabase.from("employee_directory").select("id, full_name").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("tasks").select("project_id, status").eq("company_id", cid).not("project_id", "is", null),
  ]);
  const names = new Map((people ?? []).map((p) => [p.id, p.full_name]));
  const stats = (pid: string) => {
    const t = (tasks ?? []).filter((x) => x.project_id === pid);
    const done = t.filter((x) => x.status === "done").length;
    return { open: t.length - done, pct: t.length ? Math.round((done / t.length) * 100) : 0 };
  };
  // Owner: any project; Manager: projects they lead (they become its manager)
  const canCreate = perms.has("projects.manage_all");
  const leadsOwn = !perms.has("projects.manage_all");
  const exportHref = `/api/export/projects?company=${cid}`;

  return (
    <>
      <PageHeader title="Projects" subtitle={`${count ?? 0} project(s)`} actions={<>
        {perms.has("projects.manage_all") && <a className="btn-secondary" href={exportHref}>Export</a>}
        {canCreate && <Link href="?new=1" className="btn-primary">+ New project</Link>}</>} />
      {sp.new && canCreate && (
        <Card title="New project" className="mb-6">
          <ActionForm action={saveProject.bind(null, cid)} className="grid gap-4 md:grid-cols-3">
            <Field label="Name"><input className="input" name="name" required autoFocus /></Field>
            <Field label="Client"><input className="input" name="client" /></Field>
            {leadsOwn ? <Field label="Project manager"><input className="input" value="You" disabled /></Field>
              : <Field label="Project manager"><select className="input" name="manager_id"><option value="">—</option>{(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>}
            <Field label="Start"><input className="input" type="date" name="start_date" /></Field>
            <Field label="End"><input className="input" type="date" name="end_date" /></Field>
            <Field label="Status"><select className="input" name="status"><option value="planned">Planned</option><option value="active">Active</option><option value="on_hold">On hold</option><option value="completed">Completed</option></select></Field>
            <Field label="Description" className="md:col-span-3"><textarea className="input" name="description" rows={2} /></Field>
            <div className="md:col-span-3 flex gap-2"><SubmitButton>Create project</SubmitButton><Link href="?" className="btn-ghost">Cancel</Link></div>
          </ActionForm>
        </Card>
      )}
      <SavedFilters cid={cid} page="projects" query={new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "new") as [string, string][]).toString()} />
      <Card pad={false} title={
        <form className="flex flex-wrap gap-2">
          <input name="q" defaultValue={sp.q} placeholder="Search name or client" className="input w-52" />
          <select name="status" defaultValue={sp.status ?? ""} className="input w-36"><option value="">All statuses</option>
            {["planned", "active", "on_hold", "completed"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}</select>
          <select name="manager" defaultValue={sp.manager ?? ""} className="input w-44"><option value="">Any manager</option>{(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select>
          <input type="date" name="from" defaultValue={sp.from} className="input w-40" title="Ending after" />
          <input type="date" name="to" defaultValue={sp.to} className="input w-40" title="Starting before" />
          <select name="archived" defaultValue={sp.archived ?? ""} className="input w-32"><option value="">Current</option><option value="1">Archived</option></select>
          <button className="btn-secondary">Filter</button>
        </form>
      }>
        <Table head={["Project", "Client", "Manager", "Members", "Start", "End", "Status", "Open tasks", "Done"]}
          empty={<span>No projects yet.{canCreate && <> <Link href="?new=1" className="text-brand-600 hover:underline">Create the first one</Link>.</>}</span>}>
          {(projects ?? []).map((p) => {
            const s = stats(p.id);
            return (
              <tr key={p.id} className="hover:bg-slate-50">
                <td className="td"><Link href={`/c/${cid}/projects/${p.id}`} className="font-medium text-slate-900 hover:underline">{p.name}</Link></td>
                <td className="td">{p.client ?? "—"}</td><td className="td">{names.get(p.manager_id) ?? "—"}</td>
                <td className="td">{(p.project_members as { count: number }[])[0]?.count ?? 0}</td>
                <td className="td">{fmtDate(p.start_date)}</td><td className="td">{fmtDate(p.end_date)}</td><td className="td"><Badge value={p.status} /></td>
                <td className="td">{s.open}</td>
                <td className="td"><div className="flex items-center gap-2"><div className="h-1.5 w-16 rounded bg-slate-100"><div className="h-1.5 rounded bg-emerald-500" style={{ width: `${s.pct}%` }} /></div><span className="text-xs">{s.pct}%</span></div></td>
              </tr>
            );
          })}
        </Table>
        {(count ?? 0) > PAGE && (
          <div className="flex justify-end gap-2 border-t border-slate-100 px-4 py-3">
            {page > 1 && <Link className="btn-secondary" href={`?${new URLSearchParams({ ...sp, page: String(page - 1) } as Record<string, string>)}`}>Previous</Link>}
            {page * PAGE < (count ?? 0) && <Link className="btn-secondary" href={`?${new URLSearchParams({ ...sp, page: String(page + 1) } as Record<string, string>)}`}>Next</Link>}
          </div>
        )}
      </Card>
    </>
  );
}
