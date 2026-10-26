export const IMPORT_COLUMNS = [
  "emp_code", "first_name", "last_name", "email", "phone", "date_of_joining", "employment_type", "department",
  "designation", "branch", "manager_email", "pan", "uan", "ifsc", "bank_account", "annual_ctc",
];

export const fullName = (e: { first_name: string; last_name?: string | null } | null | undefined) =>
  e ? `${e.first_name} ${e.last_name ?? ""}`.trim() : "—";

type Db = { from: (t: string) => any };   // eslint-disable-line @typescript-eslint/no-explicit-any
export type DirEntry = { id: string; first_name: string; last_name: string | null; emp_code: string; email: string; department: string | null; designation: string | null };

/**
 * Names and codes for a company's people from employee_directory, which every active member can
 * read. Payroll and other modules use this instead of joining `employees`, whose rows Finance and
 * other limited roles may not read.
 */
/**
 * The employee export: full rows from `employees` (RLS limits them to roles that may read every
 * record; the scheduled report uses the server client). Not from the directory, which no longer
 * carries phone or joining date.
 */
export async function employeeExportRows(db: Db, cid: string): Promise<Record<string, unknown>[]> {
  const { data } = await db.from("employees")
    .select("emp_code, first_name, last_name, email, phone, date_of_joining, status, departments(name), designations(name), branches(name)")
    .eq("company_id", cid).order("emp_code");
  type R = { emp_code: string; first_name: string; last_name: string | null; email: string; phone: string | null; date_of_joining: string; status: string;
    departments: { name: string } | null; designations: { name: string } | null; branches: { name: string } | null };
  return ((data ?? []) as R[]).map((e) => ({
    emp_code: e.emp_code, full_name: fullName(e), email: e.email, phone: e.phone, department: e.departments?.name ?? null,
    designation: e.designations?.name ?? null, branch: e.branches?.name ?? null, date_of_joining: e.date_of_joining, status: e.status,
  }));
}

export async function directory(supabase: Db, cid: string): Promise<Map<string, DirEntry>> {
  const { data } = await supabase.from("employee_directory")
    .select("id, first_name, last_name, emp_code, email, department, designation").eq("company_id", cid);
  return new Map(((data ?? []) as DirEntry[]).map((d) => [d.id, d]));
}
