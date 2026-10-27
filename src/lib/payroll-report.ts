import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fmtMonth } from "@/lib/format";
import { allRows, inFilter, type ReportFilters } from "@/lib/report-filters";
import type { Cell, ReportTable } from "@/lib/attendance-report";

// X-03 payroll reports over a range of months, by branch and department. Only locked (final) runs count,
// one per month. Government and bank files (PF ECR, ESI, PT, NEFT) stay whole-company in each payroll run.
// Reads run as the signed-in user (RLS: Salaries R).

export const PAYROLL_REPORTS = { register: "Salary register", "ctc-vs-actual": "CTC vs actual", "department-cost": "Department cost", tds: "TDS summary" } as const;
export type PayrollReport = keyof typeof PAYROLL_REPORTS;
export const payrollReportKind = (v: string | null | undefined): PayrollReport => (v && v in PAYROLL_REPORTS ? v as PayrollReport : "register");

type Person = { id: string; full_name: string; emp_code: string; department: string | null; branch: string | null; branch_id: string | null; department_id: string | null };
type Slip = { id: string; employee_id: string; month: string; salary_days: number; payable_days: number; lop_days: number; late_marks: number; ot_hours: number;
  ratio: number; day_value: number; monthly_gross: number; earned_gross: number; gross_payable: number; total_deductions: number; net_pay: number;
  recovery_carry: number; employer_pf: number; employer_esi: number; taxable_income: number; held: boolean; payment_status: string };
type Line = { payslip_id: string; code: string; name: string; kind: string; amount: number; sort: number };

// BRD §7.5.2 order of operations: the structure's prorated components, then these earnings, then deductions
// in the order PF, ESI, PT, LWF, TDS, loans and recoveries. Statutory columns follow the company's on/off
// switches (SAL-03); the rest always show, at 0 when nobody has them.
const EXTRA_EARNINGS: [string, string, "always" | "if-any"][] = [
  ["ARREARS", "Arrears", "always"], ["OT", "Overtime", "always"], ["BONUS", "Bonus", "always"], ["INCENTIVE", "Incentive", "always"],
  ["ENCASH", "Leave encashment", "if-any"], ["GRATUITY", "Gratuity", "if-any"], ["REIMB", "Reimbursements (non-taxable)", "always"],
];
const DEDUCTIONS: [string, string, "pf_enabled" | "esi_enabled" | "pt_enabled" | "lwf_enabled" | null][] = [
  ["PF", "Provident Fund", "pf_enabled"], ["ESI", "ESI", "esi_enabled"], ["PT", "Professional Tax", "pt_enabled"], ["LWF", "Labour Welfare Fund", "lwf_enabled"],
  ["TDS", "TDS", null], ["RECOVERY", "Loan / advance and recoveries", null],
];
const STATUS: Record<string, string> = { pending: "Pending", paid: "Paid", failed: "Failed", on_hold: "On hold" };

const n = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;

export async function payrollReport(supabase: SupabaseClient, cid: string, f: ReportFilters, kind: PayrollReport): Promise<ReportTable> {
  const { data: runs } = await supabase.from("payroll_runs").select("id, month").eq("company_id", cid).eq("status", "locked")
    .gte("month", `${f.from}-01`).lte("month", `${f.to}-01`).order("month");
  const runIds = (runs ?? []).map((r) => r.id);
  const [people, slips] = await Promise.all([
    allRows<Person>((a, b) => supabase.from("employee_directory").select("id, full_name, emp_code, department, branch, branch_id, department_id")
      .eq("company_id", cid).order("emp_code").order("id").range(a, b)),
    runIds.length ? allRows<Slip>((a, b) => supabase.from("payslips").select("id, employee_id, month, salary_days, payable_days, lop_days, late_marks, ot_hours, ratio, day_value, monthly_gross, earned_gross, gross_payable, total_deductions, net_pay, recovery_carry, employer_pf, employer_esi, taxable_income, held, payment_status")
      .in("run_id", runIds).order("month").order("id").range(a, b)) : [],
  ]);
  const who = new Map(people.filter((p) => inFilter(p, f)).map((p) => [p.id, p]));
  const list = slips.filter((s) => who.has(s.employee_id))
    .sort((a, b) => a.month.localeCompare(b.month) || who.get(a.employee_id)!.emp_code.localeCompare(who.get(b.employee_id)!.emp_code));
  const lines = kind === "register" || kind === "tds"
    ? (await Promise.all(chunk(list.map((s) => s.id), 200).map((ids) => allRows<Line>((a, b) => supabase.from("payslip_lines")
        .select("payslip_id, code, name, kind, amount, sort").in("payslip_id", ids).order("payslip_id").order("code").range(a, b))))).flat()
    : [];
  const amount = new Map(lines.map((l) => [`${l.payslip_id}|${l.code}`, Number(l.amount)]));
  const line = (sid: string, code: string) => amount.get(`${sid}|${code}`) ?? 0;
  const title = `${PAYROLL_REPORTS[kind]} · ${fmtMonth(`${f.from}-01`)} to ${fmtMonth(`${f.to}-01`)}`;
  const empty = runIds.length ? "No payslips for these filters." : "No locked payroll in these months yet.";
  const person = (s: Slip) => { const p = who.get(s.employee_id)!; return [fmtMonth(s.month), p.emp_code, p.full_name, p.department ?? "", p.branch ?? ""]; };
  const base = ["Month", "Code", "Employee", "Department", "Branch"];

  if (kind === "ctc-vs-actual") {
    return { title, empty, columns: [...base, "Monthly CTC", "Actual gross", "Difference", "LOP days", "Employer cost"],
      rows: list.map((s) => [...person(s), Math.round(Number(s.monthly_gross)), n(s.gross_payable), n(Number(s.gross_payable) - Math.round(Number(s.monthly_gross))),
        n(s.lop_days), n(Number(s.gross_payable) + Number(s.employer_pf) + Number(s.employer_esi))]) };
  }
  if (kind === "tds") {
    return { title, empty, columns: [...base, "Taxable income", "TDS"],
      rows: list.map((s) => [...person(s), Math.round(Number(s.taxable_income)), n(line(s.id, "TDS"))]) };
  }
  if (kind === "department-cost") {
    const by = new Map<string, { month: string; dept: string; people: number; gross: number; pf: number; esi: number }>();
    for (const s of list) {
      const dept = who.get(s.employee_id)!.department ?? "Unassigned";
      const k = `${s.month}|${dept}`;
      const r = by.get(k) ?? { month: s.month, dept, people: 0, gross: 0, pf: 0, esi: 0 };
      r.people++; r.gross += Number(s.gross_payable); r.pf += Number(s.employer_pf); r.esi += Number(s.employer_esi);
      by.set(k, r);
    }
    return { title, empty, columns: ["Month", "Department", "Employees", "Gross", "Employer PF", "Employer ESI", "Total cost"],
      rows: [...by.values()].sort((a, b) => a.month.localeCompare(b.month) || a.dept.localeCompare(b.dept))
        .map((r) => [fmtMonth(r.month), r.dept, r.people, n(r.gross), n(r.pf), n(r.esi), n(r.gross + r.pf + r.esi)]) };
  }
  // salary register (SAL-14), showing the calculation the payslip shows (SAL-20, §7.5.2)
  const { data: st } = await supabase.from("statutory_settings").select("pf_enabled, esi_enabled, pt_enabled, lwf_enabled").eq("company_id", cid).maybeSingle();
  const used = new Set(lines.map((l) => l.code));
  const known = new Set([...EXTRA_EARNINGS.map(([c]) => c), ...DEDUCTIONS.map(([c]) => c)]);
  const byCode = (kind: string) => [...new Map(lines.filter((l) => l.kind === kind && !known.has(l.code))
    .sort((a, b) => a.sort - b.sort).map((l) => [l.code, l.name])).entries()];
  const earnings = [...byCode("earning"), ...EXTRA_EARNINGS.filter(([c, , when]) => when === "always" || used.has(c)).map(([c, n]) => [c, n] as [string, string])];
  const components = byCode("earning").length;
  const deductions = [...DEDUCTIONS.filter(([c, , flag]) => !flag || (st?.[flag] ?? true) || used.has(c)).map(([c, n]) => [c, n] as [string, string]), ...byCode("deduction")];
  return { title, empty, columns: [...base, "Salary days", "Payable days", "LOP days", "Late marks", "OT hours", "Proration ratio", "Day value", "Monthly gross",
      ...earnings.slice(0, components).map(([, n]) => n), "Earned gross", ...earnings.slice(components).map(([, n]) => n), "Gross",
      ...deductions.map(([, n]) => n), "Total deductions", "Net pay", "Recovery carried to next month", "Employer PF", "Employer ESI", "Status"],
    rows: list.map((s): Cell[] => [...person(s), n(s.salary_days), n(s.payable_days), n(s.lop_days), s.late_marks, n(s.ot_hours),
      Math.round(Number(s.ratio) * 10000) / 10000, n(s.day_value), Math.round(Number(s.monthly_gross)),
      ...earnings.slice(0, components).map(([code]) => n(line(s.id, code))), n(s.earned_gross),
      ...earnings.slice(components).map(([code]) => n(line(s.id, code))), n(s.gross_payable),
      ...deductions.map(([code]) => n(line(s.id, code))), n(s.total_deductions), n(s.net_pay), n(s.recovery_carry), n(s.employer_pf), n(s.employer_esi),
      s.held ? "On hold" : STATUS[s.payment_status] ?? s.payment_status]) };
}

function chunk<T>(xs: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}
