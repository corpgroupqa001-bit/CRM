import Link from "next/link";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Table } from "@/components/ui";
import { fmtDateTime, money, todayIST } from "@/lib/format";
import { fullName } from "@/lib/employees";
import { saveDeclaration, verifyDeclaration } from "../actions";


const ITEMS: [string, string, string][] = [
  ["80C", "Section 80C", "PF, PPF, ELSS, life insurance, tuition fees, home-loan principal"],
  ["80D", "Section 80D", "Health insurance premiums"],
  ["80CCD1B", "Section 80CCD(1B)", "Additional NPS contribution"],
  ["HRA", "HRA exemption", "Rent paid (exempt part)"],
  ["24B", "Section 24(b)", "Home-loan interest"],
  ["80E", "Section 80E", "Education-loan interest"],
  ["other", "Other deductions", "Any other eligible deduction"],
];

// SAL-04: the tax regime and investment declarations, kept in the Salaries module: Finance /
// Administrator record and verify them, HR views. Employees have no access until that is approved.
// The payroll run uses the declared amounts in the monthly TDS projection under the old regime.
export async function TaxDeclarationView({ cid, sp }: { cid: string; sp: { employee?: string }; mode: "salaries" }) {
  const { supabase, perms, company } = await getCtx(cid);
  const today = todayIST();
  const m = Number(today.slice(5, 7)), y = Number(today.slice(0, 4));
  const fy = m >= company.fy_start_month ? y : y - 1;
  const hr = perms.has("salaries.read");   // sees everyone's declarations
  const canVerify = perms.has("salaries.manage");
  const empId = hr ? sp.employee : undefined;

  const [{ data: mine }, { data: all }] = await Promise.all([
    empId ? supabase.from("tax_declarations").select("*").eq("employee_id", empId).eq("fy_start_year", fy).maybeSingle() : Promise.resolve({ data: null }),
    hr ? supabase.from("tax_declarations").select("*").eq("company_id", cid).eq("fy_start_year", fy).order("updated_at", { ascending: false })
      : Promise.resolve({ data: [] }),
  ]);
  // names come from the directory, which every role in the Salaries module may read
  const { data: dir } = hr && all?.length ? await supabase.from("employee_directory").select("id, first_name, last_name, emp_code").eq("company_id", cid) : { data: [] };
  const who = new Map((dir ?? []).map((d) => [d.id, d]));
  const items = (mine?.items ?? {}) as Record<string, number>;
  const locked = !canVerify;   // HR: view only

  return (
    <>
      <PageHeader title="Income-tax declaration" subtitle={`Financial year ${fy}–${String(fy + 1).slice(2)}`}
        actions={<Link href={`/c/${cid}/payroll`} className="btn-ghost">← Payroll</Link>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Declaration" className="lg:col-span-2"
          actions={mine && <Badge value={mine.verified ? "approved" : "pending"} text={mine.verified ? "Verified by HR" : "Awaiting verification"} />}>
          {!empId ? <p className="text-sm text-slate-500">Choose an employee from the list to view or record their declaration.</p> : (
            <ActionForm action={saveDeclaration.bind(null, cid)} className="space-y-5">
              <input type="hidden" name="fy" value={fy} />
              <input type="hidden" name="employee_id" value={empId} />
              <fieldset disabled={locked} className="space-y-5">
                <div>
                  <div className="label">Tax regime</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {[["new", "New regime", "Lower slab rates and a higher standard deduction, but no investment deductions."],
                      ["old", "Old regime", "Higher slab rates, but the deductions below reduce your taxable income."]].map(([v, t, d]) => (
                      <label key={v} className="flex cursor-pointer gap-3 rounded-xl border border-slate-200 p-3 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/50">
                        <input type="radio" name="regime" value={v} defaultChecked={(mine?.regime ?? "new") === v} className="mt-0.5" />
                        <span><span className="block text-sm font-medium text-slate-900">{t}</span><span className="block text-xs text-slate-500">{d}</span></span>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="label">Investments and deductions (annual, ₹) — used under the old regime</div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {ITEMS.map(([k, l, d]) => (
                      <Field key={k} label={l} hint={d}><input className="input" type="number" min={0} step="1" name={`item_${k}`} defaultValue={items[k] ?? ""} /></Field>
                    ))}
                  </div>
                </div>
                {canVerify && <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="verified" defaultChecked={!!mine?.verified} /> Proofs verified by HR</label>}
                {!locked && <div className="flex items-center gap-3"><SubmitButton>Save declaration</SubmitButton>
                  {mine && <span className="text-xs text-slate-500">Total declared {money(mine.declared_total)} · updated {fmtDateTime(mine.updated_at)}</span>}</div>}
              </fieldset>
              {locked && <p className="text-sm text-slate-500">HR has verified this declaration. Ask HR if something needs to change.</p>}
            </ActionForm>
          )}
        </Card>
        <Card title="How it's used">
          <ul className="list-disc space-y-2 pl-4 text-sm text-slate-600">
            <li>Each payroll run projects your annual taxable income and spreads the remaining tax over the rest of the year.</li>
            <li>Under the old regime, your declared total is subtracted before tax is worked out.</li>
            <li>Limits per section (for example ₹1.5 lakh under 80C) apply. HR checks your proofs before the year ends.</li>
          </ul>
        </Card>
      </div>
      {hr && (
        <Card title="All declarations" className="mt-6" pad={false}>
          <Table head={["Employee", "Regime", "Declared", "Updated", "Status", ""]} empty="No declarations for this year yet.">
            {(all ?? []).map((d) => {
              const e = who.get(d.employee_id) ?? { first_name: "—", last_name: null, emp_code: "" };
              return <tr key={d.id}><td className="td"><Link href={`?employee=${d.employee_id}`} className="font-medium hover:underline">{fullName(e)}</Link> <span className="text-xs text-slate-500">{e.emp_code}</span></td>
                <td className="td capitalize">{d.regime}</td><td className="td tabular-nums">{money(d.declared_total)}</td><td className="td">{fmtDateTime(d.updated_at)}</td>
                <td className="td"><Badge value={d.verified ? "approved" : "pending"} text={d.verified ? "Verified" : "Pending"} /></td>
                <td className="td text-right">{canVerify && <form action={verifyDeclaration.bind(null, cid, d.id, !d.verified)}><button className="btn-secondary btn-sm">{d.verified ? "Unverify" : "Verify"}</button></form>}</td></tr>;
            })}
          </Table>
        </Card>
      )}
    </>
  );
}
