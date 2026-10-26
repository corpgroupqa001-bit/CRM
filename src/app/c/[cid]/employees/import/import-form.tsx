"use client";
import { useActionState } from "react";
import { SubmitButton } from "@/components/action-form";
import { importEmployees } from "../actions";

export function ImportForm({ cid }: { cid: string }) {
  const [state, action] = useActionState(importEmployees.bind(null, cid), null);
  const errors = (state?.data?.errors as string[] | undefined) ?? [];
  return (
    <form action={action} className="space-y-4">
      <input className="input" type="file" name="file" accept=".xlsx,.xls,.csv" required />
      <fieldset className="space-y-1 text-sm">
        <label className="flex items-center gap-2"><input type="radio" name="mode" value="all_or_nothing" defaultChecked /> Import only if every row is valid</label>
        <label className="flex items-center gap-2"><input type="radio" name="mode" value="valid_only" /> Import valid rows only and skip the rest</label>
      </fieldset>
      <SubmitButton pendingText="Validating…">Validate & import</SubmitButton>
      {state?.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{state.error}</p>}
      {state?.ok && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{state.ok}</p>}
      {errors.length > 0 && (
        <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50/50 p-3 text-xs text-rose-800">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
    </form>
  );
}
