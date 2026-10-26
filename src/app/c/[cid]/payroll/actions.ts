"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { assertPerm, getCtx } from "@/lib/context";
import { attempt, bool, must, numOrNull, str, type ActionState } from "@/lib/actions";
import { createAdminClient } from "@/lib/supabase/admin";
import { payslipEmail, sendMail } from "@/lib/email/mailer";
import { renderPayslipPdf } from "@/lib/payslip-pdf";
import { fmtMonth } from "@/lib/format";
import { directory } from "@/lib/employees";

const rv = (cid: string) => revalidatePath(`/c/${cid}/payroll`, "layout");

export async function precheck(cid: string, month: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "salaries.read");
  const { supabase } = ctx;
  const { data, error } = await supabase.rpc("payroll_precheck", { p_company: cid, p_month: month });
  if (error) return [{ level: "error", code: "rpc", message: error.message }];
  return data as { level: string; code: string; message: string }[];
}

export async function runPayroll(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  let runId = "";
  const r = await attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    runId = must(await supabase.rpc("run_payroll", { p_company: cid, p_month: `${str(fd, "month")}-01` })) as string;
  });
  if (r?.error) return r;
  rv(cid);
  redirect(`/c/${cid}/payroll/${runId}`);
}

export async function approveRun(cid: string, runId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.approve");
    const { supabase } = ctx;
    must(await supabase.rpc("approve_payroll", { p_run: runId }));
    rv(cid);
    return "Payroll approved and finalized. It is now read-only.";
  });
}

export async function reopenRun(cid: string, runId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    // Owner / Administrator only (not Finance, not Super Admin); the database also checks the typed month
    if (!["owner", "company_admin"].includes(ctx.role)) throw new Error("Only the owner or a company administrator can reopen payroll.");
    const { supabase } = ctx;
    must(await supabase.rpc("reopen_payroll", { p_run: runId, p_reason: str(fd, "reason"), p_confirm: str(fd, "confirm") }));
    rv(cid);
    return "Payroll reopened and attendance for the month unlocked. Make the corrections, lock attendance and run payroll again.";
  });
}

// SAL-10 hold / release, SAL-29 payment status
export async function setHold(cid: string, slipId: string, held: boolean) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "salaries.manage");
  const { supabase } = ctx;
  await supabase.from("payslips").update({ held, payment_status: held ? "on_hold" : "pending" }).eq("id", slipId);
  rv(cid);
}

export async function setPaymentStatus(cid: string, runId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const status = str(fd, "status")!;
    const ids = fd.getAll("slip").map(String);
    let q = supabase.from("payslips").update({ payment_status: status }).eq("run_id", runId).eq("held", false);
    if (ids.length) q = q.in("id", ids);
    must(await q);
    rv(cid);
    return `Marked ${ids.length || "all"} payslip(s) as ${status}.`;
  });
}

// SAL-12 email payslips (PDF generated on demand, never stored — NFR-13)
export async function emailPayslips(cid: string, runId: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const [{ data: slips }, dir] = await Promise.all([
      supabase.from("payslips").select("id, month, employee_id").eq("run_id", runId).eq("held", false), directory(supabase, cid)]);
    let sent = 0;
    const failed: string[] = [];
    for (const s of slips ?? []) {
      const e = dir.get(s.employee_id) ?? { first_name: "", email: "" };
      const { pdf, protectedWith } = await renderPayslipPdf(createAdminClient(), s.id);
      const r = await sendMail(payslipEmail(e.email, e.first_name, fmtMonth(s.month), pdf, protectedWith));
      if (r.ok) sent++; else failed.push(e.email);
    }
    return failed.length ? { error: `Sent ${sent}; failed for ${failed.join(", ")}. Try again.` } : `Emailed ${sent} payslip(s).`;
  });
}

// SAL-02 / SAL-25 CTC assignment and revision
export async function assignCtc(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const effective = str(fd, "effective_from");
    must(await supabase.from("employee_ctc").upsert({
      company_id: cid, employee_id: str(fd, "employee_id"), structure_id: str(fd, "structure_id"),
      annual_ctc: numOrNull(fd, "annual_ctc"), effective_from: effective, note: str(fd, "note"),
    }, { onConflict: "employee_id,effective_from" }));
    rv(cid);
    const backdated = effective && effective < new Date().toISOString().slice(0, 8) + "01";
    return backdated ? "Salary saved. Arrears for earlier locked months will be paid in the next payroll run." : "Salary saved.";
  });
}

// SAL-06 variable inputs
export async function addInput(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    must(await supabase.from("variable_inputs").insert({
      company_id: cid, employee_id: str(fd, "employee_id"), month: `${str(fd, "month")}-01`, kind: str(fd, "kind"),
      amount: numOrNull(fd, "amount"), note: str(fd, "note") }));
    rv(cid);
    return "Added.";
  });
}

export async function deleteInput(cid: string, id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "salaries.manage");
  const { supabase } = ctx;
  await supabase.from("variable_inputs").delete().eq("id", id);
  rv(cid);
}

export async function uploadInputs(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const file = fd.get("file");
    const month = `${str(fd, "month")}-01`;
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file.");
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()));
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    const { data: emps } = await supabase.from("employees").select("id, emp_code").eq("company_id", cid);
    const byCode = new Map((emps ?? []).map((e) => [e.emp_code, e.id]));
    const errors: string[] = [];
    const ok: Record<string, unknown>[] = [];
    rows.forEach((r, i) => {
      const id = byCode.get(String(r.emp_code).trim());
      const kind = String(r.kind).trim().toLowerCase();
      const amount = Number(r.amount);
      if (!id) errors.push(`Row ${i + 2}: unknown emp_code ${r.emp_code}`);
      else if (!["bonus", "incentive", "reimbursement", "deduction"].includes(kind)) errors.push(`Row ${i + 2}: kind must be bonus, incentive, reimbursement or deduction`);
      else if (!(amount >= 0)) errors.push(`Row ${i + 2}: amount must be a positive number`);
      else ok.push({ company_id: cid, employee_id: id, month, kind, amount, note: r.note || null });
    });
    if (errors.length) return { error: `Nothing imported. ${errors.slice(0, 10).join(" · ")}${errors.length > 10 ? " …" : ""}` };
    must(await supabase.from("variable_inputs").insert(ok));
    rv(cid);
    return `Imported ${ok.length} input(s).`;
  });
}

// SAL-07 loans and advances
export async function addLoan(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const principal = numOrNull(fd, "principal");
    must(await supabase.from("loans").insert({
      company_id: cid, employee_id: str(fd, "employee_id"), kind: str(fd, "kind") ?? "advance", principal,
      emi: numOrNull(fd, "emi"), balance: principal, start_month: `${str(fd, "start_month")}-01`, note: str(fd, "note") }));
    rv(cid);
    return "Saved. The EMI is deducted from the start month.";
  });
}

// SAL-01 structures and components
export async function addStructure(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    must(await supabase.from("salary_structures").insert({ company_id: cid, name: str(fd, "name"), description: str(fd, "description") }));
    rv(cid);
    return "Structure added. Add its components below.";
  });
}

export async function saveComponent(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const row = {
      company_id: cid, structure_id: str(fd, "structure_id"), code: str(fd, "code")?.toUpperCase(), name: str(fd, "name"),
      calc: str(fd, "calc"), value: numOrNull(fd, "value") ?? 0, taxable: bool(fd, "taxable"), pf: bool(fd, "pf"), esi: bool(fd, "esi"),
      sort: numOrNull(fd, "sort") ?? 0,
    };
    const id = str(fd, "id");
    must(id ? await supabase.from("salary_components").update(row).eq("id", id) : await supabase.from("salary_components").insert(row));
    rv(cid);
    return "Component saved.";
  });
}

export async function deleteComponent(cid: string, id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "salaries.manage");
  const { supabase } = ctx;
  await supabase.from("salary_components").delete().eq("id", id);
  rv(cid);
}

// SAL-03 statutory settings
export async function saveStatutorySettings(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const json = (k: string) => {
      try { return JSON.parse(str(fd, k) ?? "[]"); } catch { throw new Error(`${k} is not valid JSON.`); }
    };
    const n = (k: string) => numOrNull(fd, k) ?? 0;
    must(await supabase.from("statutory_settings").update({
      pf_enabled: bool(fd, "pf_enabled"), pf_employee_rate: n("pf_employee_rate"), pf_employer_rate: n("pf_employer_rate"),
      pf_wage_ceiling: n("pf_wage_ceiling"), pf_cap_at_ceiling: bool(fd, "pf_cap_at_ceiling"),
      esi_enabled: bool(fd, "esi_enabled"), esi_employee_rate: n("esi_employee_rate"), esi_employer_rate: n("esi_employer_rate"),
      esi_wage_ceiling: n("esi_wage_ceiling"), pt_enabled: bool(fd, "pt_enabled"), pt_slabs: json("pt_slabs"),
      lwf_enabled: bool(fd, "lwf_enabled"), lwf_employee: n("lwf_employee"), lwf_employer: n("lwf_employer"),
      lwf_months: (str(fd, "lwf_months") ?? "").split(/[\s,]+/).filter(Boolean).map(Number),
      tds_enabled: bool(fd, "tds_enabled"), tds_slabs: json("tds_slabs"), standard_deduction: n("standard_deduction"),
      rebate_limit: n("rebate_limit"), rebate_max: n("rebate_max"), cess_pct: n("cess_pct"),
      gratuity_enabled: bool(fd, "gratuity_enabled"), verified_on: str(fd, "verified_on"), updated_at: new Date().toISOString(),
    }).eq("company_id", cid));
    rv(cid);
    return "Statutory settings saved.";
  });
}

// SAL-04 tax declarations
export async function saveDeclaration(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    // declarations are recorded in the Salaries module only (RLS enforces the same)
    assertPerm(ctx, "salaries.manage");
    const { supabase } = ctx;
    const empId = str(fd, "employee_id");
    if (!empId) throw new Error("Choose an employee.");
    const items: Record<string, number> = {};
    for (const k of ["80C", "80D", "80CCD1B", "HRA", "24B", "80E", "other"]) {
      const v = Number(str(fd, `item_${k}`) ?? 0);
      if (v > 0) items[k] = v;
    }
    const row: Record<string, unknown> = { company_id: cid, employee_id: empId, fy_start_year: Number(str(fd, "fy")), regime: str(fd, "regime") ?? "new", items };
    if (fd.has("verified")) row.verified = fd.get("verified") === "on";
    must(await supabase.from("tax_declarations").upsert(row, { onConflict: "employee_id,fy_start_year" }));
    rv(cid);
    return "Declaration saved. It is used from the next payroll run.";
  });
}

export async function verifyDeclaration(cid: string, id: string, verified: boolean) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "salaries.manage");
  const { supabase, user } = ctx;
  await supabase.from("tax_declarations").update({ verified, verified_by: verified ? user.id : null }).eq("id", id);
  rv(cid);
}
