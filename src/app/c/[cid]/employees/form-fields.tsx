import { Field } from "@/components/ui";
import { ASSIGNABLE_ROLES, ROLE_LABEL, type Role } from "@/lib/rbac";
import type { Ctx } from "@/lib/context";

export async function jobOptions(ctx: Ctx) {
  const { supabase, companyId: cid } = ctx;
  const [b, d, g, s, m, st] = await Promise.all([
    supabase.from("branches").select("id, name").eq("company_id", cid).order("name"),
    supabase.from("departments").select("id, name, active").eq("company_id", cid).order("name"),
    supabase.from("designations").select("id, name, active").eq("company_id", cid).order("name"),
    supabase.from("shifts").select("id, name").eq("company_id", cid).order("name"),
    supabase.from("employee_directory").select("id, full_name, emp_code").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
    supabase.from("salary_structures").select("id, name").eq("company_id", cid).order("name"),
  ]);
  return { branches: b.data ?? [], departments: d.data ?? [], designations: g.data ?? [], shifts: s.data ?? [], managers: m.data ?? [], structures: st.data ?? [] };
}
export type JobOptions = Awaited<ReturnType<typeof jobOptions>>;

type Emp = Record<string, string | boolean | null | undefined>;

const opt = (rows: { id: string; name?: string; full_name?: string; emp_code?: string }[]) =>
  rows.map((r) => <option key={r.id} value={r.id}>{r.full_name ? `${r.full_name} (${r.emp_code})` : r.name}</option>);

export function PersonalFields({ e = {}, selfOnly = false }: { e?: Emp; selfOnly?: boolean }) {
  const v = (k: string) => (e[k] as string) ?? "";
  return (
    <>
      <Field label="First name"><input className="input" name="first_name" defaultValue={v("first_name")} required disabled={selfOnly} /></Field>
      <Field label="Last name"><input className="input" name="last_name" defaultValue={v("last_name")} disabled={selfOnly} /></Field>
      <Field label="Work email"><input className="input" name="email" type="email" defaultValue={v("email")} required disabled={selfOnly} /></Field>
      <Field label="Phone"><input className="input" name="phone" defaultValue={v("phone")} /></Field>
      <Field label="Date of birth"><input className="input" name="dob" type="date" defaultValue={v("dob")} disabled={selfOnly} /></Field>
      <Field label="Gender"><select className="input" name="gender" defaultValue={v("gender")} disabled={selfOnly}><option value="">—</option><option>Female</option><option>Male</option><option>Other</option></select></Field>
      <Field label="Address" className="md:col-span-2"><textarea className="input" name="address" rows={2} defaultValue={v("address")} /></Field>
      <Field label="Emergency contact name"><input className="input" name="emergency_name" defaultValue={v("emergency_name")} /></Field>
      <Field label="Emergency contact phone"><input className="input" name="emergency_phone" defaultValue={v("emergency_phone")} /></Field>
    </>
  );
}

/** canSetRole: only administrators choose the system role (the database enforces it too) */
export function JobFields({ e = {}, o, canSetRole = false }: { e?: Emp; o: JobOptions; canSetRole?: boolean }) {
  const v = (k: string) => (e[k] as string) ?? "";
  return (
    <>
      <Field label="Employee code" hint="Leave blank to auto-generate"><input className="input" name="emp_code" defaultValue={v("emp_code")} /></Field>
      <Field label="Date of joining"><input className="input" name="date_of_joining" type="date" defaultValue={v("date_of_joining")} required /></Field>
      <Field label="Employment type"><select className="input" name="employment_type" defaultValue={v("employment_type") || "full_time"}>
        <option value="full_time">Full-time</option><option value="contract">Contract</option><option value="intern">Intern</option></select></Field>
      <Field label="Branch"><select className="input" name="branch_id" defaultValue={v("branch_id")}><option value="">—</option>{opt(o.branches)}</select></Field>
      <Field label="Department"><select className="input" name="department_id" defaultValue={v("department_id")}><option value="">—</option>{opt(o.departments.filter((d) => d.active || d.id === e.department_id))}</select></Field>
      <Field label="Designation"><select className="input" name="designation_id" defaultValue={v("designation_id")}><option value="">—</option>{opt(o.designations.filter((d) => d.active || d.id === e.designation_id))}</select></Field>
      <Field label="Reporting manager"><select className="input" name="reporting_manager_id" defaultValue={v("reporting_manager_id")}><option value="">—</option>{opt(o.managers.filter((m) => m.id !== e.id))}</select></Field>
      <Field label="Shift"><select className="input" name="shift_id" defaultValue={v("shift_id")}><option value="">Company default</option>{opt(o.shifts)}</select></Field>
      <Field label="Probation ends"><input className="input" name="probation_end" type="date" defaultValue={v("probation_end")} /></Field>
      {canSetRole ? (
        <Field label="System role" hint="What they can access once they sign in. Designation does not grant access. Changing it here takes them off a custom role (Settings → Users & roles).">
          <select className="input" name="invite_role" defaultValue={v("invite_role") || "employee"}>
            {ASSIGNABLE_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</select></Field>
      ) : (
        <Field label="System role" hint="Set by an administrator"><input className="input" value={ROLE_LABEL[(v("invite_role") || "employee") as Role]} disabled /></Field>
      )}
      <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" name="mobile_attendance" defaultChecked={!!e.mobile_attendance} /> Allow mobile attendance (selfie + GPS)</label>
      <label className="flex items-center gap-2 pt-6 text-sm"><input type="checkbox" name="wfh_eligible" defaultChecked={!!e.wfh_eligible} /> Can work from home (selfie check-in, ATT-21)</label>
    </>
  );
}

export function StatutoryFields({ e = {} }: { e?: Emp }) {
  const masked = (k: string) => (e[`${k}_last4`] ? `•••• ${e[`${k}_last4`]}` : "Not set");
  return (
    <>
      <Field label="PAN" hint={`Current: ${masked("pan")}`}><input className="input uppercase" name="pan" placeholder="ABCDE1234F" autoComplete="off" maxLength={10} pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]" title="PAN: 5 letters, 4 digits, 1 letter (ABCDE1234F)" /></Field>
      <Field label="Aadhaar" hint={`Current: ${masked("aadhaar")}`}><input className="input" name="aadhaar" placeholder="12 digits" inputMode="numeric" autoComplete="off" maxLength={14} pattern="\s*(\d\s*){12}" title="Aadhaar: 12 digits" /></Field>
      <Field label="UAN"><input className="input" name="uan" defaultValue={(e.uan as string) ?? ""} /></Field>
      <Field label="ESI number"><input className="input" name="esi_no" defaultValue={(e.esi_no as string) ?? ""} /></Field>
      <Field label="Bank account" hint={`Current: ${masked("bank")}`}><input className="input" name="bank_account" inputMode="numeric" autoComplete="off" pattern="\s*(\d\s*){6,18}" title="Bank account: 6–18 digits" /></Field>
      <Field label="IFSC"><input className="input uppercase" name="ifsc" defaultValue={(e.ifsc as string) ?? ""} placeholder="HDFC0001234" maxLength={11} pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" title="IFSC: 4 letters, 0, then 6 letters or digits (HDFC0001234)" /></Field>
      <Field label="Bank name"><input className="input" name="bank_name" defaultValue={(e.bank_name as string) ?? ""} /></Field>
    </>
  );
}
