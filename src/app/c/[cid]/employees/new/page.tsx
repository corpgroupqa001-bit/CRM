import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader } from "@/components/ui";
import { createEmployee } from "../actions";
import { JobFields, PersonalFields, StatutoryFields, jobOptions } from "../form-fields";
import { ExistingPersonForm, type ExistingPerson } from "./existing-person";

export const metadata = { title: "Add employee" };

export default async function NewEmployee({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "employees.create");
  const o = await jobOptions(ctx);
  const canAccount = ctx.perms.has("employees.account");   // invitation (HR / Payroll, administrators)
  const canSetRole = ctx.perms.has("employees.assign_role");   // system role (Owner, Company Admin)
  const canSalary = ctx.perms.has("salaries.manage");
  // Owner / Company Admin: people from their other companies, to add or move here (0036)
  const fromOthers = canSetRole ? await Promise.all([
    ctx.supabase.rpc("people_from_my_companies", { p_company: cid }),
    ctx.supabase.from("designations").select("id, name, department_id").eq("company_id", cid).eq("active", true).order("name"),
    ctx.supabase.from("departments").select("id, name").eq("company_id", cid).eq("active", true).order("name"),
  ]) : null;
  const others = (fromOthers?.[0].data ?? []) as ExistingPerson[];
  return (
    <>
      <PageHeader title="Add employee" subtitle="The employee record feeds attendance, payroll, tasks and chat — complete it before the first payroll." />
      {!!others.length && (
        <Card title="Someone from your other companies?" description="Pick a person who already works in a company you manage, then add them here or move them." className="mb-6">
          <ExistingPersonForm cid={cid} people={others} departments={fromOthers![2].data ?? []} designations={fromOthers![1].data ?? []}
            managers={o.managers.map((m) => ({ id: m.id, full_name: m.full_name }))} />
        </Card>
      )}
      <ActionForm action={createEmployee.bind(null, cid)} className="space-y-6">
        <Card title="Personal details"><div className="grid gap-4 md:grid-cols-2"><PersonalFields /></div></Card>
        <Card title="Job details"><div className="grid gap-4 md:grid-cols-3"><JobFields o={o} canSetRole={canSetRole} /></div></Card>
        {/* the starting salary is set by whoever manages salaries (Administrator, Finance / Payroll) */}
        {canSalary && <Card title="Salary">
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Annual gross (CTC), ₹"><input className="input" name="annual_ctc" type="number" min={0} step="1" /></Field>
            <Field label="Salary structure"><select className="input" name="structure_id">{o.structures.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
          </div>
        </Card>}
        <Card title="Statutory and bank details"><div className="grid gap-4 md:grid-cols-3"><StatutoryFields /></div>
          <p className="mt-3 text-xs text-slate-500">PAN, Aadhaar and account numbers are encrypted before they are stored and are always shown masked.</p></Card>
        <div className="flex items-center gap-4">
          <SubmitButton>Create employee</SubmitButton>
          {canAccount
            ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="send_invite" defaultChecked /> Email an invitation to activate their account</label>
            : <span className="text-sm text-slate-500">HR or an administrator sends the invitation.</span>}
        </div>
      </ActionForm>
    </>
  );
}
