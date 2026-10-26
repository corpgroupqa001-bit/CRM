import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtMonth, label, money, todayIST } from "@/lib/format";
import { directory, fullName } from "@/lib/employees";
import { PayrollTabs, ViewOnlyNote } from "../tabs";
import { addInput, addLoan, deleteInput, uploadInputs } from "../actions";

export const metadata = { title: "Variable pay & loans" };

type Emp = { first_name: string; last_name: string | null; emp_code: string };

export default async function Inputs({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ month?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const canManage = ctx.perms.has("salaries.manage");   // HR: view only (approved BRD matrix)
  const { supabase } = ctx;
  const month = sp.month ?? todayIST().slice(0, 7);
  const [{ data: people }, { data: inputs }, { data: loans }, { data: recov }] = await Promise.all([
    supabase.from("employee_directory").select("id, full_name, emp_code").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("variable_inputs").select("*").eq("company_id", cid).eq("month", `${month}-01`).order("created_at"),
    supabase.from("loans").select("*").eq("company_id", cid).order("created_at", { ascending: false }),
    supabase.from("recovery_balances").select("amount, employee_id").eq("company_id", cid).gt("amount", 0),
  ]);
  const dir = await directory(supabase, cid);
  const empSelect = <select name="employee_id" className="input" required>{(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.emp_code})</option>)}</select>;

  return (
    <>
      <PageHeader title="Variable pay & loans" actions={<form className="flex gap-2"><input type="month" name="month" defaultValue={month} className="input w-44" /><button className="btn-secondary">Show</button></form>} />
      <PayrollTabs cid={cid} active="inputs" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card title={`Inputs for ${fmtMonth(`${month}-01`)}`} pad={false}>
            <Table head={["Employee", "Type", "Amount", "Note", ""]} empty="No bonus, incentive, reimbursement or deduction this month.">
              {(inputs ?? []).map((i) => (
                <tr key={i.id}><td className="td">{fullName(dir.get(i.employee_id) as Emp)}</td><td className="td">{label(i.kind)}</td><td className="td">{money(i.amount)}</td>
                  <td className="td">{i.note}</td><td className="td text-right">{canManage && <form action={deleteInput.bind(null, cid, i.id)}><button className="text-sm text-rose-600">Delete</button></form>}</td></tr>
              ))}
            </Table>
          </Card>
          <Card title="Loans & salary advances" pad={false}>
            <Table head={["Employee", "Type", "Principal", "EMI", "Balance", "From", "Status"]}>
              {(loans ?? []).map((l) => (
                <tr key={l.id}><td className="td">{fullName(dir.get(l.employee_id) as Emp)}</td><td className="td">{label(l.kind)}</td><td className="td">{money(l.principal)}</td>
                  <td className="td">{money(l.emi)}</td><td className="td">{money(l.balance)}</td><td className="td">{fmtMonth(l.start_month)}</td><td className="td"><Badge value={l.status} /></td></tr>
              ))}
            </Table>
          </Card>
          {!!recov?.length && (
            <Card title="Recovery balances carried forward" pad={false}>
              <Table head={["Employee", "Amount to recover"]}>
                {recov.map((r, i) => <tr key={i}><td className="td">{fullName(dir.get(r.employee_id) as Emp)}</td><td className="td text-rose-700">{money(r.amount)}</td></tr>)}
              </Table>
            </Card>
          )}
        </div>
        {!canManage ? <div><ViewOnlyNote what="Variable pay and loans" /></div> : <div className="space-y-6">
          <Card title="Add input">
            <ActionForm action={addInput.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="month" value={month} />
              <Field label="Employee">{empSelect}</Field>
              <Field label="Type"><select name="kind" className="input"><option value="bonus">Bonus</option><option value="incentive">Incentive</option>
                <option value="reimbursement">Reimbursement (non-taxable)</option><option value="deduction">One-time deduction</option></select></Field>
              <Field label="Amount, ₹"><input name="amount" type="number" min={0} step="0.01" className="input" required /></Field>
              <Field label="Note"><input name="note" className="input" /></Field>
              <SubmitButton className="btn-primary w-full">Add</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="Bulk upload">
            <p className="mb-2 text-xs text-slate-500">Columns: emp_code, kind (bonus / incentive / reimbursement / deduction), amount, note</p>
            <ActionForm action={uploadInputs.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <input type="hidden" name="month" value={month} />
              <input type="file" name="file" accept=".csv,.xlsx,.xls" className="input" required />
              <SubmitButton className="btn-secondary w-full">Upload</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="New loan / advance">
            <ActionForm action={addLoan.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <Field label="Employee">{empSelect}</Field>
              <Field label="Type"><select name="kind" className="input"><option value="advance">Salary advance</option><option value="loan">Loan</option></select></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Amount, ₹"><input name="principal" type="number" min={1} className="input" required /></Field>
                <Field label="Monthly EMI, ₹"><input name="emi" type="number" min={1} className="input" required /></Field>
              </div>
              <Field label="Deduct from"><input name="start_month" type="month" defaultValue={month} className="input" required /></Field>
              <SubmitButton className="btn-primary w-full">Save</SubmitButton>
            </ActionForm>
          </Card>
        </div>}
      </div>
    </>
  );
}
