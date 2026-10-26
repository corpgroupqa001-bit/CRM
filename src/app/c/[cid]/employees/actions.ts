"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { assertPerm, can, getCtx } from "@/lib/context";
import { createAdminClient } from "@/lib/supabase/admin";
import { decrypt, encrypt, last4 } from "@/lib/crypto";
import { attempt, bool, must, str, type ActionState } from "@/lib/actions";
import { inviteEmail, sendMail } from "@/lib/email/mailer";
import { PASSWORD_RULE, validPassword } from "@/lib/auth/session";

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const AADHAAR_RE = /^\d{12}$/;

const JOB_FIELDS = ["branch_id", "department_id", "designation_id", "reporting_manager_id", "shift_id", "employment_type", "date_of_joining", "probation_end"];
const PERSONAL_FIELDS = ["first_name", "last_name", "email", "phone", "dob", "gender", "address", "emergency_name", "emergency_phone"];

function pick(fd: FormData, keys: string[]) {
  const o: Record<string, unknown> = {};
  for (const k of keys) if (fd.has(k)) o[k] = str(fd, k);
  return o;
}

/** encrypt PAN / Aadhaar / bank account into the *_enc + *_last4 columns */
function sensitive(fd: FormData) {
  const o: Record<string, unknown> = {};
  const pan = str(fd, "pan")?.toUpperCase();
  if (pan) { if (!PAN_RE.test(pan)) throw new Error("PAN must look like ABCDE1234F."); o.pan_enc = encrypt(pan); o.pan_last4 = last4(pan); }
  const aadhaar = str(fd, "aadhaar")?.replace(/\s/g, "");
  if (aadhaar) { if (!AADHAAR_RE.test(aadhaar)) throw new Error("Aadhaar must be 12 digits."); o.aadhaar_enc = encrypt(aadhaar); o.aadhaar_last4 = last4(aadhaar); }
  const acct = str(fd, "bank_account")?.replace(/\s/g, "");
  if (acct) { if (!/^\d{6,18}$/.test(acct)) throw new Error("Bank account must be 6–18 digits."); o.bank_account_enc = encrypt(acct); o.bank_last4 = last4(acct); }
  const ifsc = str(fd, "ifsc")?.toUpperCase();
  if (ifsc) { if (!IFSC_RE.test(ifsc)) throw new Error("IFSC must look like HDFC0001234."); o.ifsc = ifsc; }
  if (fd.has("bank_name")) o.bank_name = str(fd, "bank_name");
  if (fd.has("uan")) o.uan = str(fd, "uan");
  if (fd.has("esi_no")) o.esi_no = str(fd, "esi_no");
  return o;
}

export async function createEmployee(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const res = await attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.create");
    const { supabase } = ctx;
    const row: Record<string, unknown> = {
      company_id: cid, ...pick(fd, PERSONAL_FIELDS), ...pick(fd, JOB_FIELDS), ...sensitive(fd),
      emp_code: str(fd, "emp_code"), mobile_attendance: bool(fd, "mobile_attendance"),
      invite_role: can(ctx, "employees.account") ? str(fd, "invite_role") ?? "employee" : "employee",
    };
    if (!row.first_name || !row.email || !row.date_of_joining) throw new Error("First name, email and date of joining are required.");
    row.email = String(row.email).toLowerCase();
    const data = must(await supabase.from("employees").insert(row).select("id").single());
    id = data.id;
    const ctc = Number(str(fd, "annual_ctc") ?? 0);
    const structure = str(fd, "structure_id");
    if (ctc > 0 && structure && can(ctx, "salaries.manage")) {   // HR creates the record; salary is set by payroll
      must(await supabase.from("employee_ctc").insert({ company_id: cid, employee_id: id, structure_id: structure, annual_ctc: ctc, effective_from: row.date_of_joining }));
    }
    if (bool(fd, "send_invite") && can(ctx, "employees.account")) await sendInvite(cid, id);
  });
  if (res?.error) return res;
  redirect(`/c/${cid}/employees/${id}`);
}

export async function updateEmployee(cid: string, eid: string, section: "personal" | "job", _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    const { supabase } = ctx;
    let patch: Record<string, unknown>;
    if (section === "job") {
      assertPerm(ctx, "employees.update");
      patch = { ...pick(fd, JOB_FIELDS), emp_code: str(fd, "emp_code"), mobile_attendance: bool(fd, "mobile_attendance") };
      // the system role changes only when an administrator submits it
      if (can(ctx, "employees.account") && fd.has("invite_role")) patch.invite_role = str(fd, "invite_role") ?? "employee";
    } else if (can(ctx, "employees.update")) {
      patch = pick(fd, PERSONAL_FIELDS);
    } else {
      // EMP-09 self-service: contact fields only (the database enforces the same rule)
      patch = pick(fd, ["phone", "address", "emergency_name", "emergency_phone"]);
    }
    must(await supabase.from("employees").update(patch).eq("id", eid).eq("company_id", cid));
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Saved.";
  });
}

// EMP-05 / EMP-09: HR saves directly; an employee's own bank / PAN change needs HR approval
export async function saveStatutory(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    const { supabase, employee } = ctx;
    if (can(ctx, "employees.update")) {
      must(await supabase.from("employees").update(sensitive(fd)).eq("id", eid).eq("company_id", cid));
      revalidatePath(`/c/${cid}/employees/${eid}`);
      return "Statutory and bank details saved.";
    }
    if (can(ctx, "employees.pay_fields")) {
      // Finance: pay-related fields only, through the database function that enforces exactly that
      const fields = sensitive(fd);
      delete fields.aadhaar_enc; delete fields.aadhaar_last4;
      must(await supabase.rpc("update_employee_pay_fields", { p_emp: eid, p_fields: fields }));
      revalidatePath(`/c/${cid}/employees/${eid}`);
      return "Pay details saved.";
    }
    if (employee?.id !== eid) throw new Error("You can only request changes to your own details.");
    sensitive(fd); // validates
    const reqs: { field: "pan" | "bank"; payload: Record<string, string | null>; summary: string }[] = [];
    const pan = str(fd, "pan")?.toUpperCase();
    if (pan) reqs.push({ field: "pan", payload: { pan }, summary: `PAN ending ${last4(pan)}` });
    const acct = str(fd, "bank_account")?.replace(/\s/g, "");
    if (acct || str(fd, "ifsc")) {
      reqs.push({ field: "bank", payload: { bank_account: acct ?? null, ifsc: str(fd, "ifsc")?.toUpperCase() ?? null, bank_name: str(fd, "bank_name") },
        summary: `Account ending ${acct ? last4(acct) : "(unchanged)"}, IFSC ${str(fd, "ifsc") ?? "(unchanged)"}` });
    }
    if (!reqs.length) throw new Error("Enter the new PAN or bank details.");
    for (const r of reqs) {
      must(await supabase.from("employee_change_requests").insert({
        company_id: cid, employee_id: eid, field: r.field, payload_enc: encrypt(JSON.stringify(r.payload)), summary: r.summary }));
    }
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Change request sent to HR for approval.";
  });
}

export async function decideChangeRequest(cid: string, id: string, approve: boolean) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "employees.update");
  const { supabase, user } = ctx;
  const req = must(await supabase.from("employee_change_requests").select("*").eq("id", id).single());
  if (approve) {
    const payload = JSON.parse(decrypt(req.payload_enc)!);
    const fd = new FormData();
    for (const [k, v] of Object.entries(payload)) if (v) fd.set(k, String(v));
    must(await supabase.from("employees").update(sensitive(fd)).eq("id", req.employee_id));
  }
  must(await supabase.from("employee_change_requests").update({
    status: approve ? "approved" : "rejected", reviewed_by: user.id, reviewed_at: new Date().toISOString() }).eq("id", id));
  revalidatePath(`/c/${cid}/employees/requests`);
}

// EMP-07 documents with expiry
export async function uploadDocument(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, user } = await getCtx(cid);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file.");
    if (file.size > 50 * 1024 * 1024) throw new Error("Files must be 50 MB or smaller.");
    const path = `${cid}/${eid}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
    must(await supabase.storage.from("documents").upload(path, file, { contentType: file.type }));
    must(await supabase.from("employee_documents").insert({
      company_id: cid, employee_id: eid, name: str(fd, "name") ?? file.name, doc_type: str(fd, "doc_type") ?? "other",
      storage_path: path, expiry_date: str(fd, "expiry_date"), uploaded_by: user.id }));
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Document uploaded.";
  });
}

export async function documentUrl(cid: string, path: string) {
  const { supabase } = await getCtx(cid);
  const { data } = await supabase.storage.from("documents").createSignedUrl(path, 60);
  if (data?.signedUrl) redirect(data.signedUrl);
}

// EMP-06 device user ID mapping
export async function mapDevice(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "attendance.manage");
    const { supabase } = ctx;
    const n = must(await supabase.rpc("map_device_user", { p_device: str(fd, "device_id"), p_device_user_id: str(fd, "device_user_id"), p_emp: eid }));
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return `Mapped. ${n} waiting punch(es) attached.`;
  });
}

export async function unmapDevice(cid: string, eid: string, mapId: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "attendance.manage");
  const { supabase } = ctx;
  await supabase.from("device_user_map").delete().eq("id", mapId);
  revalidatePath(`/c/${cid}/employees/${eid}`);
}

export async function toggleChecklist(cid: string, eid: string, itemId: string, done: boolean) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "employees.update");
  const { supabase } = ctx;
  await supabase.from("onboarding_items").update({ done, done_at: done ? new Date().toISOString() : null }).eq("id", itemId);
  revalidatePath(`/c/${cid}/employees/${eid}`);
}

// AUTH-04 invite: email a link to the activation page
async function sendInvite(cid: string, eid: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "employees.account");   // invitations are an administrator action
  const { supabase, company } = ctx;
  const e = must(await supabase.from("employees").select("first_name, email, user_id").eq("id", eid).single());
  if (e.user_id) throw new Error("This employee has already activated their account.");
  const link = `${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/activate?email=${encodeURIComponent(e.email)}`;
  const sent = await sendMail(inviteEmail(e.email, e.first_name, company.name, link));
  if (!sent.ok) throw new Error(`Invite email failed: ${sent.error}. Try again.`);
  await supabase.from("employees").update({ invited_at: new Date().toISOString() }).eq("id", eid);
}

export async function inviteEmployee(cid: string, eid: string, _: ActionState): Promise<ActionState> {
  return attempt(async () => {
    await sendInvite(cid, eid);
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Invitation sent.";
  });
}

// EMP-10 / EMP-11 lifecycle
export async function lifecycle(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    const { supabase } = ctx;
    const kind = str(fd, "kind")!;
    // HR records transfers, promotions, resignations and exits; switching login access on or off is
    // an administrator action (it uses the service role below)
    assertPerm(ctx, kind === "deactivated" || kind === "reactivated" ? "employees.account" : "employees.update");
    const effective = str(fd, "effective_date") ?? new Date().toISOString().slice(0, 10);
    const emp = must(await supabase.from("employees").select("*").eq("id", eid).single());
    // nobody switches off their own access, and the owner's access can't be switched off from here
    // (the service-role calls below would otherwise bypass the owner protection in RLS)
    if (kind === "deactivated" || kind === "exit") {
      if (emp.user_id === ctx.user.id) throw new Error("You can't deactivate or exit yourself.");
      if (emp.user_id) {
        const { data: m } = await supabase.from("company_members").select("role").eq("company_id", cid).eq("user_id", emp.user_id).maybeSingle();
        if (m?.role === "owner") throw new Error("The company owner can't be deactivated.");
      }
    }
    let patch: Record<string, unknown> = {};
    let details: Record<string, unknown> = { note: str(fd, "note") };

    if (kind === "transfer") {
      patch = pick(fd, ["branch_id", "department_id", "reporting_manager_id"]);
      details = { ...details, from: { branch_id: emp.branch_id, department_id: emp.department_id }, to: patch };
    } else if (kind === "promotion") {
      patch = { designation_id: str(fd, "designation_id") };
      details = { ...details, from: emp.designation_id, to: patch.designation_id };
    } else if (kind === "resignation") {
      patch = { status: "notice", resignation_date: effective, last_working_day: str(fd, "last_working_day") };
      if (!patch.last_working_day) throw new Error("Enter the last working day.");
    } else if (kind === "exit") {
      patch = { status: "exited", last_working_day: str(fd, "last_working_day") ?? effective, exit_reason: str(fd, "note") };
    } else if (kind === "deactivated") {
      patch = { status: "inactive" };
    } else if (kind === "reactivated") {
      patch = { status: "active", last_working_day: null, resignation_date: null };
    }
    must(await supabase.from("employees").update(patch).eq("id", eid));
    must(await supabase.from("employee_events").insert({ company_id: cid, employee_id: eid, kind, effective_date: effective, details }));

    if (kind === "deactivated" || kind === "exit") {
      // EMP-11: login access ends immediately and device IDs are released
      const admin = createAdminClient();
      await admin.from("device_user_map").delete().eq("employee_id", eid);
      if (emp.user_id) {
        await admin.from("company_members").update({ active: false }).eq("company_id", cid).eq("user_id", emp.user_id);
        const { count } = await admin.from("company_members").select("id", { count: "exact", head: true }).eq("user_id", emp.user_id).eq("active", true);
        if (!count) await admin.auth.admin.updateUserById(emp.user_id, { ban_duration: "876000h" });
      }
    }
    if (kind === "reactivated" && emp.user_id) {
      const admin = createAdminClient();
      await admin.from("company_members").update({ active: true }).eq("company_id", cid).eq("user_id", emp.user_id);
      await admin.auth.admin.updateUserById(emp.user_id, { ban_duration: "none" });
    }
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Updated.";
  });
}

// EMP-01 bulk import with row-level validation (columns: see IMPORT_COLUMNS in lib/employees.ts)
export async function importEmployees(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.create");
    const { supabase } = ctx;
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose an Excel or CSV file.");
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { cellDates: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" });
    if (!rows.length) throw new Error("The file has no rows.");

    const [deps, desigs, branches, existing, structure] = await Promise.all([
      supabase.from("departments").select("id, name").eq("company_id", cid),
      supabase.from("designations").select("id, name").eq("company_id", cid),
      supabase.from("branches").select("id, name").eq("company_id", cid),
      supabase.from("employees").select("id, email").eq("company_id", cid),
      supabase.from("salary_structures").select("id").eq("company_id", cid).order("created_at").limit(1).maybeSingle(),
    ]);
    const find = (list: { id: string; name: string }[] | null, v: string) => list?.find((x) => x.name.toLowerCase() === v.toLowerCase())?.id;
    const emails = new Map((existing.data ?? []).map((e) => [e.email.toLowerCase(), e.id]));

    const errors: string[] = [];
    const valid: { row: Record<string, unknown>; ctc: number; managerEmail: string }[] = [];
    rows.forEach((raw, i) => {
      const r: Record<string, string> = {};
      for (const [k, v] of Object.entries(raw)) r[k.trim().toLowerCase().replace(/\s+/g, "_")] = v instanceof Date ? v.toISOString().slice(0, 10) : String(v).trim();
      const line = i + 2;
      const errs: string[] = [];
      if (!r.first_name) errs.push("first_name is required");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.email ?? "")) errs.push("email is invalid");
      else if (emails.has(r.email.toLowerCase())) errs.push("email already exists");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date_of_joining ?? "")) errs.push("date_of_joining must be YYYY-MM-DD");
      if (r.employment_type && !["full_time", "contract", "intern"].includes(r.employment_type)) errs.push("employment_type must be full_time, contract or intern");
      if (r.department && !find(deps.data, r.department)) errs.push(`department "${r.department}" not found`);
      if (r.designation && !find(desigs.data, r.designation)) errs.push(`designation "${r.designation}" not found`);
      if (r.branch && !find(branches.data, r.branch)) errs.push(`branch "${r.branch}" not found`);
      const sfd = new FormData();
      for (const k of ["pan", "ifsc", "bank_account", "uan"]) if (r[k]) sfd.set(k, r[k]);
      let enc: Record<string, unknown> = {};
      try { enc = sensitive(sfd); } catch (e) { errs.push((e as Error).message); }
      if (errs.length) { errors.push(`Row ${line}: ${errs.join("; ")}`); return; }
      emails.set(r.email.toLowerCase(), "pending");
      valid.push({
        row: {
          company_id: cid, emp_code: r.emp_code || null, first_name: r.first_name, last_name: r.last_name || null,
          email: r.email.toLowerCase(), phone: r.phone || null, date_of_joining: r.date_of_joining,
          employment_type: r.employment_type || "full_time", department_id: find(deps.data, r.department ?? "") ?? null,
          designation_id: find(desigs.data, r.designation ?? "") ?? null, branch_id: find(branches.data, r.branch ?? "") ?? null, ...enc,
        },
        ctc: Number(r.annual_ctc || 0), managerEmail: (r.manager_email ?? "").toLowerCase(),
      });
    });
    if (errors.length && fd.get("mode") !== "valid_only") {
      return { error: `${errors.length} row(s) have errors — nothing was imported. Fix them, or choose "Import valid rows only".`, data: { errors } };
    }
    if (!valid.length) return { error: "No valid rows to import.", data: { errors } };
    const inserted = must(await supabase.from("employees").insert(valid.map((v) => v.row)).select("id, email, date_of_joining"));
    const byEmail = new Map(inserted.map((e) => [e.email, e]));
    // managers and salaries after every row exists
    for (const v of valid) {
      const me = byEmail.get(v.row.email as string)!;
      const mgr = v.managerEmail ? (byEmail.get(v.managerEmail)?.id ?? emails.get(v.managerEmail)) : null;
      if (mgr && mgr !== "pending") await supabase.from("employees").update({ reporting_manager_id: mgr }).eq("id", me.id);
      if (v.ctc > 0 && structure.data && can(ctx, "salaries.manage")) {
        await supabase.from("employee_ctc").insert({ company_id: cid, employee_id: me.id, structure_id: structure.data.id, annual_ctc: v.ctc, effective_from: me.date_of_joining });
      }
    }
    revalidatePath(`/c/${cid}/employees`);
    const salariesSkipped = !can(ctx, "salaries.manage") && valid.some((v) => v.ctc > 0);
    return { ok: `Imported ${inserted.length} employee(s).${errors.length ? ` Skipped ${errors.length} row(s) with errors.` : ""}`
      + (salariesSkipped ? " Salaries in the file were not saved: an administrator or Finance / Payroll sets them." : ""), data: { errors } };
  });
}


// HR sets a login password for an employee. If they have not activated yet, this creates their
// account and links it, so they can sign in straight away (useful while email verification is off).
export async function setEmployeePassword(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account");
    const { supabase, user } = ctx;
    const password = String(fd.get("password") ?? "");
    if (!validPassword(password)) throw new Error(PASSWORD_RULE);
    const e = must(await supabase.from("employees").select("id, email, user_id, invite_role, status").eq("id", eid).eq("company_id", cid).single());
    if (!["active", "notice"].includes(e.status)) throw new Error("Reactivate the employee first.");
    const admin = createAdminClient();
    if (e.user_id) {
      const { data: m } = await admin.from("company_members").select("role").eq("company_id", cid).eq("user_id", e.user_id).maybeSingle();
      if (m?.role === "owner" && e.user_id !== user.id) throw new Error("Only the owner can change the owner's password.");
      if (m && ["owner", "company_admin"].includes(m.role) && !can(ctx, "employees.assign_role")) throw new Error("Only an admin can change an admin's password.");
      const { error } = await admin.auth.admin.updateUserById(e.user_id, { password });
      if (error) throw error;
      return "Password updated. Share it with the employee securely and ask them to change it after signing in.";
    }
    // an account with this email already exists (maybe in another company): never set its password
    // from here; that would let one company's administrator take over someone else's login
    const { data: existing } = await admin.from("profiles").select("id").eq("email", e.email.toLowerCase()).maybeSingle();
    if (existing) throw new Error("This email already has an account. Send an invite instead; they sign in with their existing password.");
    const { data, error } = await admin.auth.admin.createUser({ email: e.email.toLowerCase(), password, email_confirm: true });
    if (error) throw error;
    const uid = data.user.id;
    await admin.from("employees").update({ user_id: uid }).eq("id", eid);
    await admin.from("company_members").upsert({ company_id: cid, user_id: uid, role: e.invite_role ?? "employee", active: true }, { onConflict: "company_id,user_id" });
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return `Login created for ${e.email}. Share the password securely; they can change it under Account & security.`;
  });
}

// Candidate sign-ups (migration 0021): approve once with the confirmed access role, or reject.
export async function approveJoin(cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account", "employees.assign_role");
    must(await ctx.supabase.rpc("approve_join_request", { p_request: id, p_role: str(fd, "role") }));
    revalidatePath(`/c/${cid}/employees`, "layout");
    return "Approved. They can sign in now.";
  });
}

export async function rejectJoin(cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account");
    must(await ctx.supabase.rpc("reject_join_request", { p_request: id, p_note: str(fd, "note") ?? null }));
    revalidatePath(`/c/${cid}/employees/approvals`);
    return "Rejected.";
  });
}

// Removing an employee (Administrator): a record created by mistake (no login, no history) is deleted.
// Anyone else is exited today, signed out of this company for good, and hidden from every list;
// their attendance and payroll history stays for the retention period. Written to the audit log.
export async function removeEmployee(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  const r = await attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.delete");
    const { supabase } = ctx;
    const e = must(await supabase.from("employees").select("id, user_id, status, last_working_day").eq("id", eid).eq("company_id", cid).single());
    if (e.user_id === ctx.user.id) throw new Error("You can't remove yourself.");
    const admin = createAdminClient();
    if (e.user_id) {
      const { data: m } = await admin.from("company_members").select("role").eq("company_id", cid).eq("user_id", e.user_id).maybeSingle();
      if (m?.role === "owner") throw new Error("The company owner can't be removed.");
    } else {
      // nothing to keep: delete outright (the database refuses if there is history, and we fall through)
      const { data: gone } = await supabase.from("employees").delete().eq("id", eid).select("id");
      if (gone?.length) return;
    }
    const today = new Date().toISOString().slice(0, 10);
    must(await supabase.from("employees").update({
      status: "exited", last_working_day: e.status === "exited" ? e.last_working_day : today,
      exit_reason: str(fd, "note") ?? "Removed", removed_at: new Date().toISOString(),
    }).eq("id", eid));
    must(await supabase.from("employee_events").insert({ company_id: cid, employee_id: eid, kind: "exit", effective_date: today,
      details: { removed: true, note: str(fd, "note") ?? null } }));
    // access ends now: devices released, membership off, login blocked if they have no other company
    await admin.from("device_user_map").delete().eq("employee_id", eid);
    if (e.user_id) {
      await admin.from("company_members").update({ active: false }).eq("company_id", cid).eq("user_id", e.user_id);
      const { count } = await admin.from("company_members").select("id", { count: "exact", head: true }).eq("user_id", e.user_id).eq("active", true);
      if (!count) await admin.auth.admin.updateUserById(e.user_id, { ban_duration: "876000h" });
    }
  });
  if (r?.error) return r;
  revalidatePath(`/c/${cid}/employees`, "layout");
  redirect(`/c/${cid}/employees`);
}

// EMP-13 assets issued / returned
export async function issueAsset(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.update");
    const { supabase } = ctx;
    must(await supabase.from("assets").insert({ company_id: cid, employee_id: eid, name: str(fd, "name"), serial_no: str(fd, "serial_no"),
      issued_on: str(fd, "issued_on") ?? new Date().toISOString().slice(0, 10) }));
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Asset recorded.";
  });
}

export async function returnAsset(cid: string, eid: string, id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "employees.update");
  const { supabase } = ctx;
  await supabase.from("assets").update({ returned_on: new Date().toISOString().slice(0, 10) }).eq("id", id);
  revalidatePath(`/c/${cid}/employees/${eid}`);
}

// EMP-10 transfer to another company of the same owner: exit here, join there (with salary and app access)
export async function transferCompany(cid: string, eid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.account");
    const { supabase } = ctx;
    const target = str(fd, "target_company")!;
    const effective = str(fd, "effective_date") ?? new Date().toISOString().slice(0, 10);
    const { data: there } = await supabase.rpc("my_access", { cid: target });
    const targetPerms = ((there as { allowed: boolean; permissions?: string[] } | null)?.allowed ? (there as { permissions: string[] }).permissions : []);
    if (!targetPerms.includes("employees.create")) throw new Error("You need administrator rights in both companies.");
    const e = must(await supabase.from("employees").select("*").eq("id", eid).single());
    const admin = createAdminClient();
    const { data: dup } = await admin.from("employees").select("id").eq("company_id", target).ilike("email", e.email).maybeSingle();
    if (dup) throw new Error("This person already has a record in the target company.");
    const lastDay = new Date(Date.parse(effective) - 86400000).toISOString().slice(0, 10);
    const copy = { ...e };
    for (const k of ["id", "emp_code", "branch_id", "department_id", "designation_id", "reporting_manager_id", "shift_id", "created_at", "updated_at", "resignation_date", "last_working_day", "exit_reason"]) delete (copy as Record<string, unknown>)[k];
    const created = must(await supabase.from("employees").insert({ ...copy, company_id: target, date_of_joining: effective, status: "active" }).select("id").single());
    const { data: ctc } = await supabase.from("employee_ctc").select("annual_ctc").eq("employee_id", eid).order("effective_from", { ascending: false }).limit(1).maybeSingle();
    const { data: struct } = await supabase.from("salary_structures").select("id").eq("company_id", target).order("created_at").limit(1).maybeSingle();
    if (ctc && struct) await supabase.from("employee_ctc").insert({ company_id: target, employee_id: created.id, structure_id: struct.id, annual_ctc: ctc.annual_ctc, effective_from: effective, note: "Transfer" });
    if (e.user_id) await admin.from("company_members").upsert({ company_id: target, user_id: e.user_id, role: e.invite_role ?? "employee", active: true }, { onConflict: "company_id,user_id" });
    must(await supabase.from("employees").update({ status: "exited", last_working_day: lastDay, exit_reason: "Transferred" }).eq("id", eid));
    must(await supabase.from("employee_events").insert({ company_id: cid, employee_id: eid, kind: "transfer", effective_date: effective, details: { to_company: target, new_employee_id: created.id } }));
    await supabase.from("employee_events").insert({ company_id: target, employee_id: created.id, kind: "transfer", effective_date: effective, details: { from_company: cid } });
    revalidatePath(`/c/${cid}/employees/${eid}`);
    return "Transferred. The exit month's payroll here settles the final salary; the new company starts from the effective date.";
  });
}
