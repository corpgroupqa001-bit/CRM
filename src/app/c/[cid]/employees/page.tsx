import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { SavedFilters } from "@/components/saved-filters";
import { Avatar, Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Employees" };

type Search = { q?: string; department?: string; branch?: string; status?: string; page?: string };
const PAGE = 25;

// EMP-12 directory with search and filters
export default async function Employees({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<Search> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "employees.read_all", "employees.read_team", "employees.pay_fields");
  const { supabase, perms, employee } = ctx;
  const page = Math.max(1, Number(sp.page ?? 1));

  let q = supabase.from("employee_directory").select("*", { count: "exact" }).eq("company_id", cid);
  if (sp.q) q = q.or(`full_name.ilike.%${sp.q}%,emp_code.ilike.%${sp.q}%,email.ilike.%${sp.q}%`);
  if (sp.department) q = q.eq("department_id", sp.department);
  if (sp.branch) q = q.eq("branch_id", sp.branch);
  q = q.eq("status", sp.status || "active");
  // a manager's list is their team (direct reports) and themself; HR / Admin and Finance see the company
  if (!perms.has("employees.read_all") && !perms.has("employees.pay_fields")) {
    q = q.or(`reporting_manager_id.eq.${employee?.id ?? "00000000-0000-0000-0000-000000000000"},id.eq.${employee?.id ?? "00000000-0000-0000-0000-000000000000"}`);
  }
  const [{ data: rows, count }, { data: deps }, { data: branches }, { count: pending }] = await Promise.all([
    q.order("first_name").range((page - 1) * PAGE, page * PAGE - 1),
    supabase.from("departments").select("id, name").eq("company_id", cid).order("name"),
    supabase.from("branches").select("id, name").eq("company_id", cid).order("name"),
    perms.has("employees.update")
      ? supabase.from("employee_change_requests").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending")
      : Promise.resolve({ count: 0 }),
  ]);
  // joining date isn't in the directory: read it from the records this role may see
  const ids = (rows ?? []).map((e) => e.id);
  const { data: joined } = ids.length
    ? await (perms.has("employees.pay_fields") && !perms.has("employees.read_all") ? supabase.from("employee_pay_fields") : supabase.from("employees"))
        .select("id, date_of_joining").in("id", ids)
    : { data: [] };
  const doj = new Map((joined ?? []).map((j) => [j.id, j.date_of_joining]));
  const { count: signups } = perms.has("employees.account")
    ? await supabase.from("join_requests").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending")
    : { count: 0 };
  const qs = (p: number) => `?${new URLSearchParams({ ...sp, page: String(p) } as Record<string, string>)}`;

  return (
    <>
      <PageHeader title="Employees" subtitle={`${count ?? 0} ${sp.status || "active"} employee(s)`}
        actions={<>
          {perms.has("employees.account") && <Link href={`/c/${cid}/employees/approvals`} className="btn-secondary">Sign-up approvals{(signups ?? 0) > 0 && <> <Badge value="pending" text={String(signups)} /></>}</Link>}
          {perms.has("employees.update") && (pending ?? 0) > 0 && <Link href={`/c/${cid}/employees/requests`} className="btn-secondary">Change requests <Badge value="pending" text={String(pending)} /></Link>}
          {(perms.has("employees.read_all") || perms.has("employees.read_team")) && <Link href={`/c/${cid}/employees/org`} className="btn-secondary">Org chart</Link>}
          {perms.has("employees.read_all") && <a href={`/api/export/employees?company=${cid}`} className="btn-secondary">Export</a>}
          {perms.has("employees.create") && <Link href={`/c/${cid}/employees/import`} className="btn-secondary">Bulk import</Link>}
          {perms.has("employees.create") && <Link href={`/c/${cid}/employees/new`} className="btn-primary">+ Add employee</Link>}
        </>} />
      <SavedFilters cid={cid} page="employees" query={new URLSearchParams(Object.entries(sp).filter(([k, v]) => v && k !== "new") as [string, string][]).toString()} />
      <Card pad={false} title={
        <form className="flex flex-wrap gap-2">
          <input name="q" defaultValue={sp.q} placeholder="Search name, code or email" className="input w-64" />
          <select name="department" defaultValue={sp.department ?? ""} className="input w-44"><option value="">All departments</option>{(deps ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="branch" defaultValue={sp.branch ?? ""} className="input w-40"><option value="">All branches</option>{(branches ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="status" defaultValue={sp.status ?? "active"} className="input w-36">
            {["active", "notice", "exited", "inactive"].map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}</select>
          <button className="btn-secondary">Filter</button>
        </form>
      }>
        <Table head={["Employee", "Code", "Department", "Designation", "Branch", "Joined", "Status"]} empty="No employees match these filters.">
          {(rows ?? []).map((e) => (
            <tr key={e.id} className="hover:bg-slate-50">
              <td className="td"><Link href={`/c/${cid}/employees/${e.id}`} className="flex items-center gap-2 font-medium text-slate-900 hover:underline">
                <Avatar name={e.full_name} url={e.photo_url} size={28} />{e.full_name}</Link>
                <div className="pl-9 text-xs text-slate-500">{e.email}</div></td>
              <td className="td">{e.emp_code}</td><td className="td">{e.department ?? "—"}</td><td className="td">{e.designation ?? "—"}</td>
              <td className="td">{e.branch ?? "—"}</td><td className="td">{fmtDate(doj.get(e.id))}</td><td className="td"><Badge value={e.status} /></td>
            </tr>
          ))}
        </Table>
        {(count ?? 0) > PAGE && (
          <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3 text-sm">
            <span className="text-slate-500">Page {page} of {Math.ceil((count ?? 0) / PAGE)}</span>
            <span className="flex gap-2">
              {page > 1 && <Link href={qs(page - 1)} className="btn-secondary">Previous</Link>}
              {page * PAGE < (count ?? 0) && <Link href={qs(page + 1)} className="btn-secondary">Next</Link>}
            </span>
          </div>
        )}
      </Card>
    </>
  );
}
