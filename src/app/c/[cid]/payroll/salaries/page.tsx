import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDate, money, todayIST } from "@/lib/format";
import { PayrollTabs, ViewOnlyNote } from "../tabs";
import { assignCtc } from "../actions";

export const metadata = { title: "Salaries" };

export default async function Salaries({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ employee?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const canManage = ctx.perms.has("salaries.manage");   // HR: view only (approved BRD matrix)
  const { supabase } = ctx;
  const [{ data: people }, { data: ctcs }, { data: structures }] = await Promise.all([
    supabase.from("employee_directory").select("id, full_name, emp_code, designation").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("employee_ctc").select("employee_id, annual_ctc, effective_from, salary_structures(name)").eq("company_id", cid).order("effective_from", { ascending: false }),
    supabase.from("salary_structures").select("id, name").eq("company_id", cid).order("name"),
  ]);
  const today = todayIST();
  const current = new Map<string, { annual_ctc: number; effective_from: string; structure: string; upcoming?: boolean }>();
  for (const c of ctcs ?? []) {
    if (c.effective_from <= today && !current.has(c.employee_id)) {
      current.set(c.employee_id, { annual_ctc: c.annual_ctc, effective_from: c.effective_from, structure: (c.salary_structures as unknown as { name: string })?.name });
    }
  }
  const total = [...current.values()].reduce((s, c) => s + Number(c.annual_ctc), 0);

  return (
    <>
      <PageHeader title="Salaries" subtitle={`Annual payroll cost ${money(total)} · monthly ${money(total / 12)}`} />
      <PayrollTabs cid={cid} active="salaries" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card pad={false} className="lg:col-span-2">
          <Table head={["Employee", "Designation", "Annual gross", "Monthly", "Structure", "Since"]}>
            {(people ?? []).map((p) => {
              const c = current.get(p.id);
              return (
                <tr key={p.id} className={sp.employee === p.id ? "bg-brand-50" : ""}>
                  <td className="td"><Link href={`/c/${cid}/employees/${p.id}?tab=salary`} className="font-medium hover:underline">{p.full_name}</Link> <span className="text-xs text-slate-500">{p.emp_code}</span></td>
                  <td className="td">{p.designation ?? "—"}</td>
                  <td className="td">{c ? money(c.annual_ctc) : <span className="text-rose-600">Not assigned</span>}</td>
                  <td className="td">{c ? money(Number(c.annual_ctc) / 12) : "—"}</td><td className="td">{c?.structure ?? "—"}</td><td className="td">{c ? fmtDate(c.effective_from) : "—"}</td>
                </tr>
              );
            })}
          </Table>
        </Card>
        {!canManage ? <div><ViewOnlyNote what="Salaries" /></div> : <Card title="Assign or revise salary">
          <ActionForm action={assignCtc.bind(null, cid)} className="space-y-3">
            <Field label="Employee"><select name="employee_id" className="input" defaultValue={sp.employee} required>
              {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.emp_code})</option>)}</select></Field>
            <Field label="Annual gross (CTC), ₹"><input name="annual_ctc" type="number" min={0} className="input" required /></Field>
            <Field label="Structure"><select name="structure_id" className="input">{(structures ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
            <Field label="Effective from" hint="A date inside a month is prorated; a past date pays arrears in the next run.">
              <input name="effective_from" type="date" className="input" defaultValue={today} required /></Field>
            <Field label="Note"><input name="note" className="input" placeholder="e.g. Annual increment" /></Field>
            <SubmitButton className="btn-primary w-full">Save</SubmitButton>
          </ActionForm>
        </Card>}
      </div>
    </>
  );
}
