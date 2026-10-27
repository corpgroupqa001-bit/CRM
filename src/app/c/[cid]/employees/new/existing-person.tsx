"use client";
import { useMemo, useState } from "react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { DepartmentDesignation } from "@/components/department-designation";
import { Field } from "@/components/ui";
import { ASSIGNABLE_ROLES, ROLE_LABEL } from "@/lib/rbac";
import { addExistingPerson } from "../actions";

export type ExistingPerson = {
  employee_id: string; full_name: string; email: string; has_login: boolean;
  companies: { company_id: string; company: string; employee_id: string; code: string; owner: boolean }[];
};
type Option = { id: string; name: string };

/**
 * Add someone who already works in another company I manage: keep them there ("Add"), or move them
 * out of the companies chosen ("Move"). Only name, email and phone come across (BRD §7.2).
 */
export function ExistingPersonForm({ cid, people, departments, designations, managers }: {
  cid: string; people: ExistingPerson[]; departments: Option[]; designations: (Option & { department_id: string | null })[];
  managers: { id: string; full_name: string }[];
}) {
  const [pick, setPick] = useState("");
  const [mode, setMode] = useState<"add" | "move">("add");
  const [all, setAll] = useState(true);
  const person = useMemo(() => people.find((p) => p.employee_id === pick), [people, pick]);
  const today = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

  return (
    <ActionForm action={addExistingPerson.bind(null, cid)} className="space-y-4">
      <Field label="Person">
        <select name="person" className="input" required value={pick} onChange={(e) => { setPick(e.target.value); setAll(true); }}>
          <option value="" disabled>Choose someone from your other companies…</option>
          {people.map((p) => <option key={p.employee_id} value={p.employee_id}>{p.full_name} · {p.email} · {p.companies.map((c) => c.company).join(", ")}</option>)}
        </select>
      </Field>
      {person && (
        <>
          <p className="text-sm text-slate-600">Works in {person.companies.map((c) => `${c.company} (${c.code})`).join(", ")}.{" "}
            {person.has_login ? "Their login will open this company too." : "They have no login yet; invite them from their new record."}</p>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="label">What should happen</legend>
            {(["add", "move"] as const).map((m) => (
              <label key={m} className={`flex cursor-pointer gap-3 rounded-xl border p-3 text-sm ${mode === m ? "border-brand-500 bg-brand-50" : "border-slate-200"}`}>
                <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="mt-0.5" />
                <span><span className="block font-medium text-slate-900">{m === "add" ? "Add here, keep them there" : "Move here"}</span>
                  <span className="text-slate-600">{m === "add" ? "They work in both; nothing changes in their current company." : "They leave the companies you choose the day before joining here."}</span></span>
              </label>
            ))}
          </fieldset>
          {mode === "move" && (
            <fieldset className="space-y-2 rounded-xl border border-slate-200 p-3">
              <legend className="label px-1">Leave which companies</legend>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-900"><input type="checkbox" name="leave_all" checked={all} onChange={(e) => setAll(e.target.checked)} /> All companies</label>
              {!all && person.companies.map((c) => (
                <label key={c.company_id} className="flex items-center gap-2 pl-1 text-sm text-slate-700">
                  <input type="checkbox" name="leave" value={c.company_id} disabled={c.owner} /> {c.company} {c.owner && <span className="text-xs text-slate-500">(owner: can&apos;t leave)</span>}
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="System role here"><select name="role" className="input" defaultValue="employee">
              {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
            <Field label="Date of joining here"><input type="date" name="date_of_joining" className="input" defaultValue={today} required /></Field>
            <DepartmentDesignation departments={departments} designations={designations} required={false} />
            <Field label="Reporting manager"><select name="reporting_manager_id" className="input" defaultValue="">
              <option value="">None</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</select></Field>
          </div>
          <p className="text-xs text-slate-500">Only name, work email and phone are copied. Salary, PAN, bank details and attendance stay in each company; HR / Payroll sets the salary here.</p>
          <SubmitButton pendingText="Saving…">{mode === "move" ? "Move to this company" : "Add to this company"}</SubmitButton>
        </>
      )}
    </ActionForm>
  );
}
