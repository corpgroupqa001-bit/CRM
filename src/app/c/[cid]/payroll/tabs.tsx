import { Tabs } from "@/components/ui";

export function PayrollTabs({ cid, active }: { cid: string; active: string }) {
  const b = `/c/${cid}/payroll`;
  return <Tabs active={active} tabs={[
    { key: "runs", label: "Payroll runs", href: b },
    { key: "salaries", label: "Salaries", href: `${b}/salaries` },
    { key: "inputs", label: "Variable pay & loans", href: `${b}/inputs` },
    { key: "setup", label: "Structures & statutory", href: `${b}/setup` },
    { key: "tax", label: "Tax declarations", href: `${b}/tax` },
    { key: "reports", label: "Reports", href: `${b}/reports` },
  ]} />;
}

/** Shown in place of editing controls for roles with view-only salaries (HR Manager, approved BRD matrix). */
export function ViewOnlyNote({ what = "Payroll" }: { what?: string }) {
  return (
    <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
      {what} is view-only for your role. HR / Payroll makes changes.
    </p>
  );
}
