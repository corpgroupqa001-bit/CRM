import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { Avatar, Card, PageHeader } from "@/components/ui";

export const metadata = { title: "Org chart" };

type Node = { id: string; full_name: string; designation: string | null; department: string | null; photo_url: string | null; reporting_manager_id: string | null };

// EMP-08 org chart generated from each employee's reporting manager
export default async function OrgChart({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "employees.read_all", "employees.read_team");
  const { data } = await ctx.supabase.from("employee_directory").select("id, full_name, designation, department, photo_url, reporting_manager_id")
    .eq("company_id", cid).in("status", ["active", "notice"]).order("first_name");
  const people = (data ?? []) as Node[];
  const ids = new Set(people.map((p) => p.id));
  const kids = new Map<string, Node[]>();
  for (const p of people) {
    const k = p.reporting_manager_id && ids.has(p.reporting_manager_id) ? p.reporting_manager_id : "root";
    kids.set(k, [...(kids.get(k) ?? []), p]);
  }
  const count = (id: string): number => (kids.get(id) ?? []).reduce((n, c) => n + 1 + count(c.id), 0);

  const Tree = ({ id, depth }: { id: string; depth: number }) => {
    const list = kids.get(id) ?? [];
    if (!list.length || depth > 12) return null;
    return (
      <ul className={depth ? "ml-5 border-l border-slate-200 pl-5" : ""}>
        {list.map((p) => (
          <li key={p.id} className="relative py-1.5">
            {depth > 0 && <span className="absolute -left-5 top-6 h-px w-5 bg-slate-200" />}
            <Link href={`/c/${cid}/employees/${p.id}`} className="inline-flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-(--shadow-card) transition hover:border-brand-300">
              <Avatar name={p.full_name} url={p.photo_url} size={34} />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-900">{p.full_name}</span>
                <span className="block text-xs text-slate-500">{[p.designation, p.department].filter(Boolean).join(" · ") || "—"}</span>
              </span>
              {count(p.id) > 0 && <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">{count(p.id)} report{count(p.id) > 1 ? "s" : ""}</span>}
            </Link>
            <Tree id={p.id} depth={depth + 1} />
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <PageHeader title="Org chart" subtitle={`${people.length} people · built from each employee's reporting manager`}
        actions={<Link href={`/c/${cid}/employees`} className="btn-ghost">← Employees</Link>} />
      <Card><div className="thin-scroll overflow-x-auto pb-2"><Tree id="root" depth={0} /></div></Card>
    </>
  );
}
