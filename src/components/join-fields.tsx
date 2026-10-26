import Link from "next/link";
import { Field } from "@/components/ui";
import { DepartmentDesignation } from "@/components/department-designation";
import type { JoinOptions } from "@/lib/join";

/** Step 1: choose the company (a plain GET form, so the next step can list its designations). */
export function CompanyPicker({ options, path }: { options: JoinOptions; path: string }) {
  return (
    <form method="get" action={path} className="mt-6 space-y-4">
      <Field label="Company you work for">
        <select className="input" name="company" required defaultValue="">
          <option value="" disabled>Choose your company</option>
          {options.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <button className="btn-primary w-full">Continue</button>
    </form>
  );
}

/** Step 2 fields inside the sign-up / request form: department, then designation (which decides the access the admin confirms). */
export function JoinFields({ options, path }: { options: JoinOptions; path: string }) {
  if (!options.company) return null;
  return (
    <>
      <input type="hidden" name="company" value={options.company.id} />
      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
        <span>Company: <b>{options.company.name}</b></span>
        <Link href={path} className="text-xs font-medium text-brand-600 hover:underline">Change</Link>
      </div>
      <DepartmentDesignation departments={options.departments} designations={options.designations}
        designationHint="Your access is set from your designation once an administrator approves you." />
      <Field label="Mobile number"><input className="input" name="phone" type="tel" required autoComplete="tel" placeholder="98480 22338" /></Field>
      <Field label="Anything the administrator should know (optional)"><input className="input" name="note" placeholder="e.g. joined on 1 Nov, reporting to Priya" /></Field>
    </>
  );
}
