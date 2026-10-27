import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/guard";
import { decrypt } from "@/lib/crypto";
import { employeeExportRows, IMPORT_COLUMNS } from "@/lib/employees";
import { EXPORT_PERMISSION } from "@/lib/rbac";
import { fmtMonth } from "@/lib/format";
import { attendanceReport, attendanceView } from "@/lib/attendance-report";
import { payrollReport, payrollReportKind } from "@/lib/payroll-report";
import { dayFilters, filterLabel, monthFilters } from "@/lib/report-filters";
import { csv, format, tableDownload, text, xlsx, type Row } from "@/lib/report-output";

export const runtime = "nodejs";

type Emp = { first_name: string; last_name: string | null; emp_code: string; email?: string; uan?: string | null; esi_no?: string | null;
  pan_last4?: string | null; ifsc?: string | null; bank_account_enc?: string | null; bank_name?: string | null; departments?: { name: string } | null };

const name = (e: Emp) => `${e.first_name} ${e.last_name ?? ""}`.trim();

// X-03 report exports. Every query runs as the signed-in user, so RLS limits the data.
export async function GET(req: Request, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  const url = new URL(req.url);
  const cid = url.searchParams.get("company") ?? "";
  const runId = url.searchParams.get("run");
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase, user } = auth;
  if (report === "companies") {
    // COM-14 export of the owner's companies list
    const { data: m } = await supabase.from("company_members").select("role, companies(name, legal_name, gstin, pan, state, plan, status, created_at)")
      .eq("user_id", user.id).eq("active", true).in("role", ["owner", "company_admin"]);
    return xlsx((m ?? []).map((r) => ({ ...(r.companies as unknown as Row), my_role: r.role })), "companies");
  }

  // every export needs a named permission, loaded server-side (my_access); unknown reports are refused
  const need = EXPORT_PERMISSION[report];
  if (!need) return NextResponse.json({ error: "Unknown report" }, { status: 404 });
  const { data: access } = await supabase.rpc("my_access", { cid });
  const a = access as { allowed: boolean; permissions?: string[] } | null;
  if (!a?.allowed || !(a.permissions ?? []).includes(need)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  if (report === "employee-template") {
    return xlsx([Object.fromEntries(IMPORT_COLUMNS.map((c) => [c, c === "date_of_joining" ? "2026-11-01" : c === "employment_type" ? "full_time" : ""]))], "employee-import-template");
  }

  if (report === "employees") {
    return xlsx((await employeeExportRows(supabase, cid)) as Row[], "employees");
  }

  if (report === "attendance" || report === "payroll-report") {
    // X-03: the filtered report on screen (branch, department, date range) as Excel, CSV or PDF
    const get = (k: string) => url.searchParams.get(k);
    const f = report === "attendance" ? dayFilters(get) : monthFilters(get);
    const [t, { data: company }, { data: branches }, { data: departments }] = await Promise.all([
      report === "attendance" ? attendanceReport(supabase, cid, f, attendanceView(get("view"))) : payrollReport(supabase, cid, f, payrollReportKind(get("type"))),
      supabase.from("companies").select("name").eq("id", cid).single(),
      supabase.from("branches").select("id, name").eq("company_id", cid),
      supabase.from("departments").select("id, name").eq("company_id", cid),
    ]);
    const file = `${report === "attendance" ? attendanceView(get("view")) : payrollReportKind(get("type"))}-${f.from}-to-${f.to}`;
    return tableDownload(t, format(get("format")), file, company?.name ?? "", filterLabel(f, branches ?? [], departments ?? []));
  }

  if (report === "chat") {
    // COMMS-12 compliance export; export_conversation() checks owner / admin and writes the audit log
    const conv = url.searchParams.get("conversation") ?? "";
    const { data, error } = await supabase.rpc("export_conversation", { p_conv: conv });
    if (error) return NextResponse.json({ error: error.message }, { status: 403 });
    return text(csv(((data ?? []) as Row[]).map((r) => ({ ...r, sent_at: String(r.sent_at) }))), `chat-${conv.slice(0, 8)}.csv`);
  }

  if (report === "projects") {
    const [{ data: projects }, { data: people }] = await Promise.all([
      supabase.from("projects").select("name, client, manager_id, start_date, end_date, status, archived").eq("company_id", cid).order("name"),
      supabase.from("employee_directory").select("id, full_name").eq("company_id", cid),
    ]);
    const n = new Map((people ?? []).map((p) => [p.id, p.full_name]));
    return xlsx((projects ?? []).map(({ manager_id, archived, ...p }) => ({ ...p, manager: n.get(manager_id) ?? "", archived: archived ? "yes" : "no" })), "projects");
  }

  if (report === "form16") {
    // SAL-15 Form 16 Part B data per employee for a financial year (from locked payslips)
    const fy = Number(url.searchParams.get("fy") ?? new Date().getFullYear());
    const [{ data: ytd }, { data: people }, { data: decl }, { data: st }] = await Promise.all([
      supabase.from("payslip_ytd").select("*").eq("company_id", cid).eq("fy_start_year", fy),
      supabase.from("employees").select("id, emp_code, first_name, last_name, pan_last4").eq("company_id", cid),
      supabase.from("tax_declarations").select("employee_id, regime, declared_total").eq("company_id", cid).eq("fy_start_year", fy),
      supabase.from("statutory_settings").select("standard_deduction, standard_deduction_old").eq("company_id", cid).maybeSingle(),
    ]);
    return xlsx((ytd ?? []).map((y) => {
      const e = (people ?? []).find((p) => p.id === y.employee_id)!;
      const d = (decl ?? []).find((x) => x.employee_id === y.employee_id);
      const regime = d?.regime ?? "new";
      const sd = Number(regime === "old" ? st?.standard_deduction_old ?? 50000 : st?.standard_deduction ?? 75000);
      const chapter6 = regime === "old" ? Number(d?.declared_total ?? 0) : 0;
      return { "Employee code": e.emp_code, Name: `${e.first_name} ${e.last_name ?? ""}`.trim(), PAN: e.pan_last4 ? `XXXXXX${e.pan_last4}` : "",
        Regime: regime, "Gross salary": Number(y.gross), "Taxable salary": Number(y.taxable), "Standard deduction": sd,
        "Chapter VI-A deductions": chapter6, "Net taxable income": Math.max(0, Number(y.taxable) - sd - chapter6),
        "Professional tax": Number(y.pt), "Employee PF": Number(y.pf), "TDS deducted": Number(y.tds) };
    }), `form16-partB-FY${fy}-${String(fy + 1).slice(2)}`, "Part B");
  }

  // ---- payroll reports, by run ----
  if (!runId) return NextResponse.json({ error: "run is required" }, { status: 400 });
  const { data: run } = await supabase.from("payroll_runs").select("month, status").eq("id", runId).eq("company_id", cid).maybeSingle();
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  const { data: slips } = await supabase.from("payslips")
    .select("*").eq("run_id", runId);
  // pay-related employee fields (incl. the encrypted account for the bank file) from the view the
  // Salaries roles may read, and department names from the directory; no join on employees
  const [{ data: payRows }, { data: dirRows }] = await Promise.all([
    supabase.from("employee_pay_fields").select("id, first_name, last_name, emp_code, email, uan, esi_no, pan_last4, ifsc, bank_account_enc, bank_name").eq("company_id", cid),
    supabase.from("employee_directory").select("id, department").eq("company_id", cid),
  ]);
  const deptOf = new Map((dirRows ?? []).map((d) => [d.id, d.department]));
  const empOf = new Map((payRows ?? []).map((e) => [e.id, { ...e, departments: deptOf.get(e.id) ? { name: deptOf.get(e.id)! } : null } as Emp]));
  const { data: lines } = await supabase.from("payslip_lines").select("payslip_id, code, name, kind, amount").in("payslip_id", (slips ?? []).map((s) => s.id));
  const { data: st } = await supabase.from("statutory_settings").select("pf_employee_rate, pf_wage_ceiling").eq("company_id", cid).maybeSingle();
  const line = (sid: string, code: string) => Number((lines ?? []).find((l) => l.payslip_id === sid && l.code === code)?.amount ?? 0);
  const tag = fmtMonth(run.month).replace(" ", "-");
  const list = (slips ?? []).map((s) => ({ s, e: empOf.get(s.employee_id) ?? ({ first_name: "", last_name: null, emp_code: "" } as Emp) }));

  switch (report) {
    case "salary-register": {
      const codes = [...new Set((lines ?? []).map((l) => `${l.kind}:${l.code}:${l.name}`))];
      return xlsx(list.map(({ s, e }) => {
        const r: Row = { code: e.emp_code, name: name(e), department: e.departments?.name ?? "", payable_days: Number(s.payable_days), lop_days: Number(s.lop_days),
          ot_hours: Number(s.ot_hours), monthly_gross: Math.round(Number(s.monthly_gross)) };
        for (const c of codes) { const [, code, n] = c.split(":"); r[n] = line(s.id, code); }
        Object.assign(r, { gross: Number(s.gross_payable), deductions: Number(s.total_deductions), net_pay: Number(s.net_pay), employer_pf: Number(s.employer_pf), employer_esi: Number(s.employer_esi), carried_forward: Number(s.recovery_carry), status: s.held ? "on_hold" : s.payment_status });
        return r;
      }), `salary-register-${tag}`, "Register");
    }
    case "bank-file": {
      // SAL-13 generic bulk NEFT/IMPS upload file; most Indian banks accept this column set (adjust per bank template)
      const rows = list.filter(({ s }) => !s.held && Number(s.net_pay) > 0).map(({ s, e }) => ({
        "Transaction Type": "NEFT", "Beneficiary Name": name(e), "Beneficiary Account Number": decrypt(e.bank_account_enc) ?? "",
        "IFSC": e.ifsc ?? "", "Amount": Number(s.net_pay), "Narration": `Salary ${tag}`, "Beneficiary Email": e.email ?? "", "Employee Code": e.emp_code,
      }));
      return text(csv(rows), `bank-transfer-${tag}.csv`);
    }
    case "pf-ecr": {
      // EPFO ECR 2.0 text format, fields separated by #~#
      const rate = Number(st?.pf_employee_rate ?? 12) / 100;
      const ceiling = Number(st?.pf_wage_ceiling ?? 15000);
      const body = list.filter(({ s }) => line(s.id, "PF") > 0).map(({ s, e }) => {
        const pf = line(s.id, "PF");
        const epfWages = Math.round(pf / rate);
        const epsWages = Math.min(epfWages, ceiling);
        const eps = Math.round(epsWages * 0.0833);
        return [e.uan ?? "", name(e).toUpperCase(), Math.round(Number(s.gross_payable)), epfWages, epsWages, epsWages, pf, eps, Math.round(Number(s.employer_pf)) - eps, Math.round(Number(s.lop_days)), 0].join("#~#");
      }).join("\n");
      return text(body, `ECR-${tag}.txt`, "text/plain");
    }
    case "esi":
      return xlsx(list.filter(({ s }) => line(s.id, "ESI") > 0).map(({ s, e }) => ({
        "IP Number": e.esi_no ?? "", "IP Name": name(e), "No of Days": Number(s.payable_days), "Total Monthly Wages": Number(s.gross_payable),
        "Employee Contribution": line(s.id, "ESI"), "Employer Contribution": Number(s.employer_esi) })), `ESI-${tag}`);
    case "pt":
      return xlsx(list.map(({ s, e }) => ({ code: e.emp_code, name: name(e), gross: Number(s.gross_payable), professional_tax: line(s.id, "PT") })), `PT-${tag}`);
    case "tds":
      return xlsx(list.map(({ s, e }) => ({ code: e.emp_code, name: name(e), pan: e.pan_last4 ? `XXXXXX${e.pan_last4}` : "", taxable_income: Math.round(Number(s.taxable_income)), tds: line(s.id, "TDS") })), `TDS-${tag}`);
    case "ctc-vs-actual":
      return xlsx(list.map(({ s, e }) => ({ code: e.emp_code, name: name(e), monthly_ctc: Math.round(Number(s.monthly_gross)), actual_gross: Number(s.gross_payable),
        difference: Number(s.gross_payable) - Math.round(Number(s.monthly_gross)), lop_days: Number(s.lop_days), employer_cost: Number(s.gross_payable) + Number(s.employer_pf) + Number(s.employer_esi) })), `ctc-vs-actual-${tag}`);
    case "journal": {
      // SAL-16 accounting journal (Tally / Zoho Books import): one balanced voucher for the run
      const sum = (f: (s: (typeof list)[number]["s"]) => number) => list.reduce((t, { s }) => t + f(s), 0);
      const L = (code: string) => list.reduce((t, { s }) => t + line(s.id, code), 0);
      const gross = sum((s) => Number(s.gross_payable)), net = sum((s) => Number(s.net_pay));
      const erPf = sum((s) => Number(s.employer_pf)), erEsi = sum((s) => Number(s.employer_esi));
      const date = String(run.month).slice(0, 10);
      const narration = `Salary for ${tag}`;
      const rows: Row[] = [
        { Date: date, Voucher: "Journal", Ledger: "Salaries & Wages", Debit: gross, Credit: 0, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "Employer PF Contribution", Debit: erPf, Credit: 0, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "Employer ESI Contribution", Debit: erEsi, Credit: 0, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "Salary Payable", Debit: 0, Credit: net, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "PF Payable", Debit: 0, Credit: L("PF") + erPf, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "ESI Payable", Debit: 0, Credit: L("ESI") + erEsi, Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "Professional Tax Payable", Debit: 0, Credit: L("PT"), Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "LWF Payable", Debit: 0, Credit: L("LWF"), Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "TDS Payable (Salary)", Debit: 0, Credit: L("TDS"), Narration: narration },
        { Date: date, Voucher: "Journal", Ledger: "Employee Loans & Advances", Debit: 0, Credit: L("RECOVERY"), Narration: narration },
      ].filter((r) => Number(r.Debit) || Number(r.Credit));
      return text(csv(rows), `journal-${tag}.csv`);
    }
    case "department-cost": {
      const by = new Map<string, Row>();
      for (const { s, e } of list) {
        const d = e.departments?.name ?? "Unassigned";
        const r = by.get(d) ?? { department: d, employees: 0, gross: 0, employer_pf: 0, employer_esi: 0, total_cost: 0 };
        r.employees = Number(r.employees) + 1; r.gross = Number(r.gross) + Number(s.gross_payable);
        r.employer_pf = Number(r.employer_pf) + Number(s.employer_pf); r.employer_esi = Number(r.employer_esi) + Number(s.employer_esi);
        r.total_cost = Number(r.gross) + Number(r.employer_pf) + Number(r.employer_esi);
        by.set(d, r);
      }
      return xlsx([...by.values()], `department-cost-${tag}`);
    }
  }
  return NextResponse.json({ error: "Unknown report" }, { status: 404 });
}
