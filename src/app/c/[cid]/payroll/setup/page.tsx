import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader, Table } from "@/components/ui";
import { StatutorySwitch } from "@/components/statutory-switch";
import { PayrollTabs, ViewOnlyNote } from "../tabs";
import { addStructure, deleteComponent, saveComponent, saveStatutorySettings } from "../actions";

export const metadata = { title: "Structures & statutory" };

const CALC: Record<string, string> = { fixed: "Fixed ₹ / month", pct_ctc: "% of gross", pct_basic: "% of Basic", balance: "Balance (remainder)" };

export default async function Setup({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "salaries.read");
  const canManage = ctx.perms.has("salaries.manage");   // HR: view only (approved BRD matrix)
  const { supabase } = ctx;
  const [{ data: structures }, { data: comps }, { data: st }] = await Promise.all([
    supabase.from("salary_structures").select("*").eq("company_id", cid).order("name"),
    supabase.from("salary_components").select("*").eq("company_id", cid).order("sort"),
    supabase.from("statutory_settings").select("*").eq("company_id", cid).maybeSingle(),
  ]);
  const compForm = (structureId: string, c?: Record<string, string | number | boolean>) => (
    <ActionForm action={saveComponent.bind(null, cid)} className="grid grid-cols-2 gap-2 sm:grid-cols-8" resetOnSuccess={!c}>
      <input type="hidden" name="structure_id" value={structureId} />{c && <input type="hidden" name="id" value={String(c.id)} />}
      <input name="code" className="input" placeholder="CODE" defaultValue={String(c?.code ?? "")} required />
      <input name="name" className="input sm:col-span-2" placeholder="Name" defaultValue={String(c?.name ?? "")} required />
      <select name="calc" className="input sm:col-span-2" defaultValue={String(c?.calc ?? "fixed")}>{Object.entries(CALC).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <input name="value" type="number" step="0.01" className="input" placeholder="Value" defaultValue={Number(c?.value ?? 0)} />
      <input name="sort" type="number" className="input" placeholder="Order" defaultValue={Number(c?.sort ?? 0)} />
      <SubmitButton className="btn-secondary">{c ? "Save" : "Add"}</SubmitButton>
      <div className="col-span-2 flex gap-4 text-xs sm:col-span-8">
        <label className="flex items-center gap-1"><input type="checkbox" name="taxable" defaultChecked={c ? !!c.taxable : true} /> Taxable</label>
        <label className="flex items-center gap-1"><input type="checkbox" name="pf" defaultChecked={!!c?.pf} /> PF wage</label>
        <label className="flex items-center gap-1"><input type="checkbox" name="esi" defaultChecked={c ? !!c.esi : true} /> ESI wage</label>
      </div>
    </ActionForm>
  );
  const s = st ?? {};

  return (
    <>
      <PageHeader title="Structures & statutory settings" />
      <PayrollTabs cid={cid} active="setup" />
      <div className="space-y-6">
        {(structures ?? []).map((str) => (
          <Card key={str.id} title={`Structure: ${str.name}`}>
            {str.description && <p className="mb-3 text-sm text-slate-500">{str.description}</p>}
            <Table head={["Code", "Component", "Calculation", "Taxable", "PF", "ESI", ""]}>
              {(comps ?? []).filter((c) => c.structure_id === str.id).map((c) => (
                <tr key={c.id}><td className="td font-mono">{c.code}</td><td className="td">{c.name}</td>
                  <td className="td">{c.calc === "balance" ? CALC.balance : `${c.calc === "fixed" ? "₹" : ""}${Number(c.value)}${c.calc === "fixed" ? "" : "%"} ${c.calc === "fixed" ? "per month" : CALC[c.calc].replace("% ", "")}`}</td>
                  <td className="td">{c.taxable ? "✓" : ""}</td><td className="td">{c.pf ? "✓" : ""}</td><td className="td">{c.esi ? "✓" : ""}</td>
                  <td className="td text-right">{canManage && <form action={deleteComponent.bind(null, cid, c.id)}><button className="text-xs text-rose-600">Remove</button></form>}</td></tr>
              ))}
            </Table>
            {canManage && <div className="mt-4 border-t border-slate-100 pt-4">{compForm(str.id)}</div>}
            <p className="mt-2 text-xs text-slate-500">Use code BASIC for basic pay; “% of Basic” components refer to it. One “Balance” component takes whatever is left of the gross.</p>
          </Card>
        ))}
        {!canManage && <ViewOnlyNote what="Salary structures and statutory settings" />}
        {canManage && <Card title="New structure">
          <ActionForm action={addStructure.bind(null, cid)} className="flex flex-wrap gap-2" resetOnSuccess>
            <input name="name" className="input w-56" placeholder="Name" required />
            <input name="description" className="input flex-1" placeholder="Description" />
            <SubmitButton>Add structure</SubmitButton>
          </ActionForm>
        </Card>}

        <Card title="Statutory settings">
          <div className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
            These defaults are placeholders. Rates, ceilings and slabs change with the law — verify every value with the company&apos;s CA before the first payroll and record the date below.
          </div>
          <ActionForm action={saveStatutorySettings.bind(null, cid)} className="space-y-6">
            {/* view-only roles see the values, read-only */}
            <fieldset disabled={!canManage} className="space-y-6">
            <fieldset className="grid gap-3 sm:grid-cols-5">
              <legend className="mb-2 text-sm font-semibold">Provident Fund</legend>
              <StatutorySwitch name="pf_enabled" defaultChecked={s.pf_enabled} />
              <Field label="Employee %"><input className="input" name="pf_employee_rate" type="number" step="0.01" defaultValue={s.pf_employee_rate} /></Field>
              <Field label="Employer %"><input className="input" name="pf_employer_rate" type="number" step="0.01" defaultValue={s.pf_employer_rate} /></Field>
              <Field label="Wage ceiling ₹"><input className="input" name="pf_wage_ceiling" type="number" defaultValue={s.pf_wage_ceiling} /></Field>
              <label className="flex items-center gap-2 pt-5 text-sm"><input type="checkbox" name="pf_cap_at_ceiling" defaultChecked={s.pf_cap_at_ceiling} /> Cap at ceiling</label>
            </fieldset>
            <fieldset className="grid gap-3 sm:grid-cols-5">
              <legend className="mb-2 text-sm font-semibold">ESI</legend>
              <StatutorySwitch name="esi_enabled" defaultChecked={s.esi_enabled} />
              <Field label="Employee %"><input className="input" name="esi_employee_rate" type="number" step="0.01" defaultValue={s.esi_employee_rate} /></Field>
              <Field label="Employer %"><input className="input" name="esi_employer_rate" type="number" step="0.01" defaultValue={s.esi_employer_rate} /></Field>
              <Field label="Wage ceiling ₹"><input className="input" name="esi_wage_ceiling" type="number" defaultValue={s.esi_wage_ceiling} /></Field>
            </fieldset>
            <fieldset className="grid gap-3 sm:grid-cols-4">
              <legend className="mb-2 text-sm font-semibold">Professional Tax & Labour Welfare Fund</legend>
              <StatutorySwitch name="pt_enabled" defaultChecked={s.pt_enabled} label="PT enabled" />
              <Field label="PT slabs (JSON)" className="sm:col-span-3" hint='[{"min":0,"max":15000,"amount":0}, …] — optional "feb_amount" for February'>
                <textarea className="input font-mono text-xs" name="pt_slabs" rows={3} defaultValue={JSON.stringify(s.pt_slabs)} /></Field>
              <StatutorySwitch name="lwf_enabled" defaultChecked={s.lwf_enabled} label="LWF enabled" />
              <Field label="LWF employee ₹"><input className="input" name="lwf_employee" type="number" defaultValue={s.lwf_employee} /></Field>
              <Field label="LWF employer ₹"><input className="input" name="lwf_employer" type="number" defaultValue={s.lwf_employer} /></Field>
              <Field label="LWF months" hint="e.g. 6, 12"><input className="input" name="lwf_months" defaultValue={(s.lwf_months ?? []).join(", ")} /></Field>
            </fieldset>
            <fieldset className="grid gap-3 sm:grid-cols-4">
              <legend className="mb-2 text-sm font-semibold">Income tax (TDS)</legend>
              <StatutorySwitch name="tds_enabled" defaultChecked={s.tds_enabled} />
              <Field label="Standard deduction ₹"><input className="input" name="standard_deduction" type="number" defaultValue={s.standard_deduction} /></Field>
              <Field label="Rebate up to income ₹"><input className="input" name="rebate_limit" type="number" defaultValue={s.rebate_limit} /></Field>
              <Field label="Max rebate ₹"><input className="input" name="rebate_max" type="number" defaultValue={s.rebate_max} /></Field>
              <Field label="Cess %"><input className="input" name="cess_pct" type="number" step="0.01" defaultValue={s.cess_pct} /></Field>
              <Field label="Slabs (JSON)" className="sm:col-span-3" hint='[{"upto":400000,"rate":0}, …, {"upto":null,"rate":30}]'>
                <textarea className="input font-mono text-xs" name="tds_slabs" rows={3} defaultValue={JSON.stringify(s.tds_slabs)} /></Field>
            </fieldset>
            <div className="flex flex-wrap items-end gap-4">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="gratuity_enabled" defaultChecked={s.gratuity_enabled} /> Pay gratuity on exit (5+ years)</label>
              <Field label="Verified with CA on"><input className="input" type="date" name="verified_on" defaultValue={s.verified_on ?? ""} /></Field>
              {canManage && <SubmitButton>Save statutory settings</SubmitButton>}
            </div>
            </fieldset>
          </ActionForm>
        </Card>
      </div>
    </>
  );
}
