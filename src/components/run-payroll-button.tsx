"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { Loader2, X } from "lucide-react";
import { runPayrollNow, type PayrollResult } from "@/app/c/[cid]/dashboard/actions";

// Dashboard "Run payroll": calls calculate_payroll_run for last month and reports the result.
export function RunPayrollButton({ cid }: { cid: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<PayrollResult | null>(null);

  const run = () => {
    const ist = new Date(Date.now() + 5.5 * 3600000);
    const label = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
    if (!window.confirm(`Calculate payroll for ${label}? This saves a new draft run; nothing is paid until it's approved.`)) return;
    setResult(null);
    start(async () => {
      try { setResult(await runPayrollNow(cid)); }
      catch { setResult({ ok: false, month: "", message: "Couldn't reach the server. Try again." }); }
    });
  };

  return (
    <div className="relative">
      <button type="button" onClick={run} disabled={pending} aria-busy={pending} className="btn-primary">
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {pending ? "Running payroll…" : "Run payroll"}
      </button>
      {result && (
        <div role={result.ok ? "status" : "alert"}
          className={`absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border p-3 text-sm shadow-(--shadow-pop) ${result.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-rose-200 bg-rose-50 text-rose-800"}`}>
          <button onClick={() => setResult(null)} className="absolute right-2 top-2 rounded p-0.5 opacity-60 hover:opacity-100" aria-label="Dismiss"><X className="h-3.5 w-3.5" /></button>
          <p className="pr-5">{result.ok ? "✓ " : "⚠ "}{result.message}</p>
          {result.ok && result.runId && <Link href={`/c/${cid}/payroll/${result.runId}`} className="mt-2 inline-block font-medium underline">Review payroll →</Link>}
          {!result.ok && result.fix && <Link href={result.fix.href} className="mt-2 inline-block font-medium underline">{result.fix.label} →</Link>}
        </div>
      )}
    </div>
  );
}
