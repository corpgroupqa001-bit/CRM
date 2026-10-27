import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { Document, Page, StyleSheet, Text, View, renderToBuffer } from "@react-pdf/renderer";
import { PDFDocument } from "@cantoo/pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import { APP_NAME, fmtMonth, rupeesInWords } from "@/lib/format";

// SAL-12 / SAL-20: branded payslip that shows the calculation. Generated on demand, never stored.

const s = StyleSheet.create({
  page: { padding: 32, fontSize: 9, fontFamily: "Helvetica", color: "#0f172a" },
  head: { flexDirection: "row", justifyContent: "space-between", borderBottom: "2 solid #4338ca", paddingBottom: 10, marginBottom: 12 },
  company: { fontSize: 15, fontFamily: "Helvetica-Bold", color: "#1e1b4b" },
  muted: { color: "#64748b" },
  title: { fontSize: 11, fontFamily: "Helvetica-Bold", marginBottom: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", marginBottom: 12 },
  cell: { width: "33%", paddingVertical: 3 },
  label: { color: "#64748b", fontSize: 8 },
  tables: { flexDirection: "row", gap: 12 },
  table: { flex: 1, border: "1 solid #e2e8f0" },
  th: { flexDirection: "row", backgroundColor: "#eef2ff", padding: 5, fontFamily: "Helvetica-Bold" },
  tr: { flexDirection: "row", padding: 5, borderTop: "1 solid #f1f5f9" },
  c1: { flex: 3 }, c2: { flex: 1.4, textAlign: "right" }, c3: { flex: 1.4, textAlign: "right" },
  total: { flexDirection: "row", padding: 5, borderTop: "1 solid #cbd5e1", fontFamily: "Helvetica-Bold" },
  net: { marginTop: 14, padding: 10, backgroundColor: "#eef2ff", borderRadius: 4 },
  netAmt: { fontSize: 16, fontFamily: "Helvetica-Bold", color: "#3730a3" },
  foot: { position: "absolute", bottom: 24, left: 32, right: 32, fontSize: 7, color: "#94a3b8", textAlign: "center" },
});

const rs = (n: number | string | null | undefined) => `Rs ${Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

type PayslipEmployee = {
  first_name: string; last_name: string | null; emp_code: string; email: string | null; pan_last4: string | null; uan: string | null;
  bank_last4: string | null; ifsc: string | null; date_of_joining: string | null;
  departments: { name: string } | null; designations: { name: string } | null;
};

/**
 * A payslip with its lines, company and employee details, read with the caller's own rights (RLS).
 * Salaries roles, or the employee for their own approved payslip (RLS on payslips). Employee details
 * come from the pay-related view, or from the employee's own record.
 */
export async function loadPayslip(db: SupabaseClient, slipId: string) {
  const { data: slip, error } = await db.from("payslips")
    .select("*, companies(name, legal_name, address, logo_url, pf_reg_no, esi_reg_no, payslip_password)")
    .eq("id", slipId).maybeSingle();
  if (error || !slip) return null;
  const cols = "first_name, last_name, emp_code, email, pan_last4, uan, bank_last4, ifsc, date_of_joining";
  const [{ data: lines }, { data: pay }, { data: dir }] = await Promise.all([
    db.from("payslip_lines").select("*").eq("payslip_id", slipId).order("sort"),
    db.from("employee_pay_fields").select(cols).eq("id", slip.employee_id).maybeSingle(),
    db.from("employee_directory").select("department, designation").eq("id", slip.employee_id).maybeSingle(),
  ]);
  // an employee reading their own payslip (SAL-12) has no pay-fields view; their own record has the same columns
  const own = pay ? null : (await db.from("employees").select(cols).eq("id", slip.employee_id).maybeSingle()).data;
  const base = (pay ?? own) as Omit<PayslipEmployee, "departments" | "designations"> | null;
  const employees: PayslipEmployee = {
    ...(base ?? { first_name: "", last_name: null, emp_code: "", email: null, pan_last4: null, uan: null, bank_last4: null, ifsc: null, date_of_joining: null }),
    departments: dir?.department ? { name: dir.department } : null,
    designations: dir?.designation ? { name: dir.designation } : null,
  };
  return { slip: { ...slip, employees }, lines: lines ?? [] };
}

type Loaded = NonNullable<Awaited<ReturnType<typeof loadPayslip>>>;

function PayslipDoc({ slip, lines }: Loaded) {
  const e = slip.employees as Record<string, unknown> & { departments: { name: string } | null; designations: { name: string } | null };
  const c = slip.companies as Record<string, string | null>;
  const earn = lines.filter((l) => l.kind === "earning");
  const ded = lines.filter((l) => l.kind === "deduction");
  const info: [string, string][] = [
    ["Employee", `${e.first_name} ${e.last_name ?? ""}`], ["Code", String(e.emp_code)], ["Designation", e.designations?.name ?? "—"],
    ["Department", e.departments?.name ?? "—"], ["PAN", e.pan_last4 ? `XXXXXX${e.pan_last4}` : "—"], ["UAN", String(e.uan ?? "—")],
    ["Bank A/c", e.bank_last4 ? `XXXX${e.bank_last4}` : "—"], ["IFSC", String(e.ifsc ?? "—")], ["Date of joining", String(e.date_of_joining)],
  ];
  const calc: [string, string][] = [
    ["Salary days", String(Number(slip.salary_days))], ["Payable days", String(Number(slip.payable_days))], ["LOP days", String(Number(slip.lop_days))],
    ["Late marks", String(slip.late_marks)], ["OT hours (approved)", String(Number(slip.ot_hours))],
    ["Proration", `${Number(slip.payable_days)} / ${Number(slip.salary_days)} = ${(Number(slip.ratio) * 100).toFixed(2)}%`],
  ];
  return (
    <Document title={`Payslip ${fmtMonth(slip.month)}`} author={APP_NAME}>
      <Page size="A4" style={s.page}>
        <View style={s.head}>
          <View><Text style={s.company}>{c.legal_name ?? c.name}</Text><Text style={s.muted}>{c.address ?? ""}</Text>
            <Text style={s.muted}>{[c.pf_reg_no && `PF ${c.pf_reg_no}`, c.esi_reg_no && `ESI ${c.esi_reg_no}`].filter(Boolean).join("  ·  ")}</Text></View>
          <View style={{ alignItems: "flex-end" }}><Text style={s.title}>PAYSLIP</Text><Text>{fmtMonth(slip.month)}</Text></View>
        </View>
        <View style={s.grid}>{info.map(([k, v]) => <View key={k} style={s.cell}><Text style={s.label}>{k}</Text><Text>{v}</Text></View>)}</View>
        <Text style={s.title}>Attendance & calculation</Text>
        <View style={s.grid}>{calc.map(([k, v]) => <View key={k} style={s.cell}><Text style={s.label}>{k}</Text><Text>{v}</Text></View>)}</View>
        <View style={s.tables}>
          <View style={s.table}>
            <View style={s.th}><Text style={s.c1}>Earnings</Text><Text style={s.c2}>Full month</Text><Text style={s.c3}>Earned</Text></View>
            {earn.map((l) => <View key={l.id} style={s.tr}><Text style={s.c1}>{l.name}</Text><Text style={s.c2}>{l.full_amount != null ? rs(Math.round(Number(l.full_amount))) : ""}</Text><Text style={s.c3}>{rs(l.amount)}</Text></View>)}
            <View style={s.total}><Text style={s.c1}>Gross earnings</Text><Text style={s.c2}>{rs(Math.round(Number(slip.monthly_gross)))}</Text><Text style={s.c3}>{rs(slip.gross_payable)}</Text></View>
          </View>
          <View style={s.table}>
            <View style={s.th}><Text style={s.c1}>Deductions</Text><Text style={s.c3}>Amount</Text></View>
            {ded.map((l) => <View key={l.id} style={s.tr}><Text style={s.c1}>{l.name}</Text><Text style={s.c3}>{rs(l.amount)}</Text></View>)}
            <View style={s.total}><Text style={s.c1}>Total deductions</Text><Text style={s.c3}>{rs(slip.total_deductions)}</Text></View>
          </View>
        </View>
        <View style={s.net}>
          <Text style={s.label}>NET PAY</Text>
          <Text style={s.netAmt}>{rs(slip.net_pay)}</Text>
          <Text>{rupeesInWords(Number(slip.net_pay))}</Text>
          {Number(slip.recovery_carry) > 0 && <Text style={{ marginTop: 4, color: "#b91c1c" }}>Unrecovered amount carried to next month: {rs(slip.recovery_carry)}</Text>}
        </View>
        <Text style={s.foot}>Computer-generated payslip from {APP_NAME}; no signature required. Employer PF {rs(slip.employer_pf)} · Employer ESI {rs(slip.employer_esi)}.</Text>
      </Page>
    </Document>
  );
}

/** The payslip password: date of birth as DDMMYYYY, or the employee code when no DOB is on file. */
export function payslipPassword(e: { dob?: string | null; emp_code: string }) {
  return e.dob ? `${e.dob.slice(8, 10)}${e.dob.slice(5, 7)}${e.dob.slice(0, 4)}` : e.emp_code;
}

export async function renderPayslipPdf(db: SupabaseClient, slipId: string): Promise<{ pdf: Buffer; protectedWith: string | null }> {
  const data = await loadPayslip(db, slipId);
  if (!data) throw new Error("Payslip not found");
  const pdf = await renderToBuffer(<PayslipDoc {...data} />);
  const company = data.slip.companies as { payslip_password?: boolean };
  if (!company.payslip_password) return { pdf, protectedWith: null };
  // SAL-12: AES-256 encryption; printing allowed, editing and copying not. The date of birth is
  // read server-side only for the password and never sent to the browser.
  const { data: person } = await createAdminClient().from("employees").select("dob, emp_code").eq("id", data.slip.employee_id).maybeSingle();
  const e = { dob: person?.dob ?? null, emp_code: person?.emp_code ?? data.slip.employees.emp_code };
  const password = payslipPassword(e);
  const doc = await PDFDocument.load(pdf);
  doc.encrypt({ userPassword: password, ownerPassword: `${process.env.OTP_PEPPER ?? ""}:${slipId}`, permissions: { printing: "highResolution", copying: false, modifying: false } });
  return { pdf: Buffer.from(await doc.save()), protectedWith: e.dob ? "date of birth (DDMMYYYY)" : "employee code" };
}
