"use client";

const WHAT: Record<string, string> = {
  pf_enabled: "PF", esi_enabled: "ESI", pt_enabled: "Professional Tax", lwf_enabled: "Labour Welfare Fund", tds_enabled: "TDS",
};

/**
 * A statutory deduction's on/off switch. Turning one off asks for confirmation first, because it stops that
 * deduction for every employee from the next payroll run; the Owner and Company Admin are notified (0040).
 */
export function StatutorySwitch({ name, defaultChecked, label = "Enabled" }: { name: keyof typeof WHAT; defaultChecked: boolean; label?: string }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} onChange={(e) => {
        if (e.target.checked) return;
        const ok = window.confirm(`Switch off ${WHAT[name]}?\n\nThis stops ${WHAT[name]} for ALL employees from the next payroll run. `
          + "A CA should confirm this is allowed for your company.\n\nThe Owner and Company Admin will be notified when you save.");
        if (!ok) e.target.checked = true;
      }} /> {label}
    </label>
  );
}
