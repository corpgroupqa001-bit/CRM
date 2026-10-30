import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { ASSIGNABLE_ROLES, ROLE_LABEL } from "@/lib/rbac";
import { approveSignup, decideProject, rejectSignup } from "./actions";

export const metadata = { title: "Requests" };

type Signup = { id: string; company_id: string; user_id: string; full_name: string; email: string; phone: string | null; status: string;
  created_at: string; decided_at: string | null; decision_note: string | null; companies: { name: string } | null };
type ProjectReq = { id: string; company_id: string; project_id: string; user_id: string; status: string; created_at: string;
  decided_at: string | null; decision_note: string | null; companies: { name: string } | null; projects: { name: string } | null };

// COM-15 / AUTH-19 (revised BRD, 30 Oct; 0056): one list of sign-ups and project requests across every
// company the viewer approves in (the Owner: their companies; the Admin: all), filtered by company and project.
// RLS decides what is listed; each decision is checked again for the request's own company.
export default async function Requests({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ company?: string; project?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "projects.manage_all", "employees.assign_role");
  const { supabase } = ctx;
  const [{ data: s }, { data: p }] = await Promise.all([
    supabase.from("join_requests").select("id, company_id, user_id, full_name, email, phone, status, created_at, decided_at, decision_note, companies(name)")
      .order("created_at", { ascending: false }).limit(300),
    supabase.from("project_requests").select("id, company_id, project_id, user_id, status, created_at, decided_at, decision_note, companies(name), projects(name)")
      .order("created_at", { ascending: false }).limit(500),
  ]);
  let signups = (s ?? []) as unknown as Signup[];
  let projects = (p ?? []) as unknown as ProjectReq[];
  // filter choices come from what this viewer can see
  const companies = new Map([...signups, ...projects].map((r) => [r.company_id, r.companies?.name ?? ""]));
  const projectNames = new Map(projects.filter((r) => !sp.company || r.company_id === sp.company).map((r) => [r.project_id, r.projects?.name ?? ""]));
  if (sp.company) { signups = signups.filter((r) => r.company_id === sp.company); projects = projects.filter((r) => r.company_id === sp.company); }
  if (sp.project) projects = projects.filter((r) => r.project_id === sp.project);
  // the requester's name (names only, read on the server)
  const ids = [...new Set(projects.map((r) => r.user_id))];
  const { data: people } = ids.length ? await createAdminClient().from("profiles").select("id, full_name, email").in("id", ids) : { data: [] };
  const who = new Map((people ?? []).map((x) => [x.id, x.full_name || x.email]));
  const signedUp = new Set(signups.filter((r) => r.status === "approved").map((r) => `${r.company_id}|${r.user_id}`));
  const pendingS = signups.filter((r) => r.status === "pending");
  const pendingP = projects.filter((r) => r.status === "pending");
  const decided = [
    ...signups.filter((r) => r.status !== "pending").map((r) => ({ id: r.id, at: r.decided_at, who: r.full_name, company: r.companies?.name, what: "Account", status: r.status, note: r.decision_note })),
    ...projects.filter((r) => r.status !== "pending").map((r) => ({ id: r.id, at: r.decided_at, who: who.get(r.user_id), company: r.companies?.name, what: `Project: ${r.projects?.name}`, status: r.status, note: r.decision_note })),
  ].sort((a, b) => (b.at ?? "").localeCompare(a.at ?? "")).slice(0, 40);

  return (
    <>
      <PageHeader title="Requests" subtitle={`${pendingS.length} sign-up(s) and ${pendingP.length} project request(s) waiting · all your companies`} />
      <form className="mb-6 flex flex-wrap gap-2">
        <select name="company" defaultValue={sp.company ?? ""} className="input w-56" aria-label="Company"><option value="">All companies</option>
          {[...companies].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <select name="project" defaultValue={sp.project ?? ""} className="input w-56" aria-label="Project"><option value="">All projects</option>
          {[...projectNames].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
        <button className="btn-secondary">Filter</button>
        {(sp.company || sp.project) && <Link href="?" className="btn-ghost">Clear</Link>}
      </form>

      <Card pad={false} title="New sign-ups" description="People who signed up with a company's link or code. They can't see anything until you approve them; HR then completes their record (device ID and so on)." className="mb-6">
        <Table head={["Person", "Company", "Signed up", ""]} empty="No sign-ups waiting.">
          {pendingS.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="td"><div className="font-medium text-slate-900">{r.full_name}</div><div className="text-xs text-slate-500">{r.email}{r.phone ? ` · ${r.phone}` : ""}</div></td>
              <td className="td">{r.companies?.name}</td>
              <td className="td text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
              <td className="td">
                <ActionForm action={approveSignup.bind(null, cid, r.company_id, r.id)} className="flex flex-wrap items-center justify-end gap-2 [&>p]:basis-full">
                  <select name="role" defaultValue="employee" className="input h-8 w-36 text-sm" aria-label="Access role">
                    {ASSIGNABLE_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}</select>
                  <SubmitButton className="btn-primary btn-sm">Approve account</SubmitButton>
                </ActionForm>
                <ActionForm action={rejectSignup.bind(null, cid, r.company_id, r.id)} className="mt-2 flex flex-wrap items-center justify-end gap-2 [&>p]:basis-full" confirm={`Reject ${r.full_name}?`}>
                  <input name="note" placeholder="Reason (shown to them)" className="input h-8 w-44 text-xs" />
                  <SubmitButton className="btn-ghost btn-sm text-rose-600">Reject</SubmitButton>
                </ActionForm>
              </td>
            </tr>
          ))}
        </Table>
      </Card>

      <Card pad={false} title="Project requests" description="Decide each project separately. A project can be approved once the person's account is approved." className="mb-6">
        <Table head={["Person", "Project", "Company", "Asked", ""]} empty="No project requests waiting.">
          {pendingP.map((r) => {
            const accountOk = signedUp.has(`${r.company_id}|${r.user_id}`) || !pendingS.some((x) => x.company_id === r.company_id && x.user_id === r.user_id);
            return (
              <tr key={r.id} className="align-top">
                <td className="td font-medium text-slate-900">{who.get(r.user_id) ?? "—"}</td>
                <td className="td">{r.projects?.name}</td><td className="td">{r.companies?.name}</td>
                <td className="td text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
                <td className="td">
                  <div className="flex flex-wrap items-start justify-end gap-2">
                    {accountOk ? <ActionForm action={decideProject.bind(null, cid, r.company_id, r.id, true)} className="[&>p]:mt-1"><SubmitButton className="btn-primary btn-sm">Approve</SubmitButton></ActionForm>
                      : <span className="text-xs text-slate-500">Approve the account first</span>}
                    <ActionForm action={decideProject.bind(null, cid, r.company_id, r.id, false)} className="flex flex-wrap items-center gap-2 [&>p]:basis-full">
                      <input name="note" placeholder="Reason (optional)" className="input h-8 w-36 text-xs" />
                      <SubmitButton className="btn-ghost btn-sm text-rose-600">Reject</SubmitButton>
                    </ActionForm>
                  </div>
                </td>
              </tr>
            );
          })}
        </Table>
      </Card>

      <Card pad={false} title="Recently decided">
        <Table head={["When", "Person", "Request", "Company", "Decision"]} empty="Nothing decided yet.">
          {decided.map((d) => (
            <tr key={d.id}><td className="td text-xs text-slate-500">{d.at ? fmtDateTime(d.at) : ""}</td><td className="td">{d.who ?? "—"}</td>
              <td className="td">{d.what}</td><td className="td">{d.company}</td>
              <td className="td"><Badge value={d.status} />{d.note && <div className="text-xs text-slate-500">{d.note}</div>}</td></tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
