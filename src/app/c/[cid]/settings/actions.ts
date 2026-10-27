"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { assertPerm, getCtx } from "@/lib/context";
import { ASSIGNABLE_ROLES, type Role } from "@/lib/rbac";
import { attempt, bool, must, numOrNull, str, type ActionState } from "@/lib/actions";

const done = (cid: string, msg = "Saved.") => { revalidatePath(`/c/${cid}/settings`); return msg; };

// COM-01 company profile and statutory identifiers
export async function saveCompany(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "company.update");   // Owner (Companies CRUD) and Company Admin (R, U own company)
    const { supabase } = ctx;
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "legal_name", "address", "state", "gstin", "pan", "tan", "pf_reg_no", "esi_reg_no", "emp_code_prefix"]) patch[k] = str(fd, k);
    if (!patch.name) throw new Error("Company name is required.");
    patch.emp_code_prefix ??= "EMP";
    const logo = fd.get("logo");
    if (logo instanceof File && logo.size > 0) {
      if (logo.size > 2 * 1024 * 1024) throw new Error("Logo must be 2 MB or smaller.");
      const path = `${cid}/logo-${Date.now()}.${logo.name.split(".").pop() ?? "png"}`;
      must(await supabase.storage.from("logos").upload(path, logo, { upsert: true, contentType: logo.type }));
      patch.logo_url = supabase.storage.from("logos").getPublicUrl(path).data.publicUrl;
    }
    must(await supabase.from("companies").update(patch).eq("id", cid));
    revalidatePath(`/c/${cid}`, "layout");
    return "Company details saved.";
  });
}

// COM-05 / COM-06 / SAL-17/18/19 / ATT-11 policies
export async function savePolicies(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.manage");
    const { supabase } = ctx;
    const weekly = fd.getAll("weekly_offs").map(Number);
    const map: Record<string, number> = {};
    for (const s of ["present", "late", "early_out", "on_duty", "wfh", "half_day", "holiday", "weekly_off", "absent", "missed_punch"]) {
      map[s] = Number(fd.get(`map_${s}`) ?? 0);
    }
    must(await supabase.from("companies").update({
      weekly_offs: weekly,
      fy_start_month: numOrNull(fd, "fy_start_month") ?? 4,
      salary_days_basis: str(fd, "salary_days_basis") ?? "calendar",
      sandwich_paid: bool(fd, "sandwich_paid"),
      ot_multiplier: numOrNull(fd, "ot_multiplier") ?? 2,
      late_marks_to_half_day: numOrNull(fd, "late_marks_to_half_day") ?? 0,
      payable_map: map,
      payslip_password: bool(fd, "payslip_password"),
      missed_out_grace_hours: numOrNull(fd, "missed_out_grace_hours") ?? 2,
      selfie_retention_days: numOrNull(fd, "selfie_retention_days") ?? 90,
      wfh_capture_gps: bool(fd, "wfh_capture_gps"),
    }).eq("id", cid));
    return done(cid, "Policies saved.");
  });
}

// COM-02 branches with geofence
export async function saveBranch(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.manage");
    const { supabase } = ctx;
    const row = {
      company_id: cid, name: str(fd, "name"), address: str(fd, "address"), state: str(fd, "state"),
      lat: numOrNull(fd, "lat"), lng: numOrNull(fd, "lng"), geofence_m: numOrNull(fd, "geofence_m") ?? 200,
    };
    if (!row.name) throw new Error("Branch name is required.");
    const id = str(fd, "id");
    must(id ? await supabase.from("branches").update(row).eq("id", id) : await supabase.from("branches").insert(row));
    return done(cid, "Branch saved.");
  });
}

export async function deleteRow(cid: string, table: "branches" | "holidays", id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, table === "branches" ? "settings.manage" : "settings.org");
  const { supabase } = ctx;
  await supabase.from(table).delete().eq("id", id).eq("company_id", cid);
  revalidatePath(`/c/${cid}/settings`);
}

// COM-03 departments and designations. Each designation sits under a department; candidates pick the
// department first and then one of its designations. Deactivated instead of deleted, so employees and
// past requests keep them; inactive ones are no longer offered.
function saveUnique(res: { error: unknown }, what: string) {
  if ((res.error as { code?: string } | null)?.code === "23505") throw new Error(`That ${what} already exists.`);
  must({ data: true, error: res.error });
}

export async function saveDepartment(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.org");
    const name = str(fd, "name");
    if (!name) throw new Error("Enter a department name.");
    const id = str(fd, "id");
    const q = ctx.supabase.from("departments");
    saveUnique(id ? await q.update({ name }).eq("id", id).eq("company_id", cid) : await q.insert({ company_id: cid, name }), "department");
    return done(cid, id ? "Department renamed." : "Department added.");
  });
}

export async function saveDesignation(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.org");
    const name = str(fd, "name");
    const department_id = str(fd, "department_id");
    if (!name) throw new Error("Enter a designation name.");
    if (!department_id) throw new Error("Choose the department this designation belongs to.");
    const id = str(fd, "id");
    const q = ctx.supabase.from("designations");
    saveUnique(id
      ? await q.update({ name, department_id }).eq("id", id).eq("company_id", cid)
      : await q.insert({ company_id: cid, name, department_id }), "designation in this department");
    return done(cid, id ? "Designation saved." : "Designation added.");
  });
}

export async function setOrgActive(cid: string, table: "departments" | "designations", id: string, active: boolean) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "settings.org");
  must(await ctx.supabase.from(table).update({ active }).eq("id", id).eq("company_id", cid));
  revalidatePath(`/c/${cid}/settings`);
}

// Designation → access role: suggested when a candidate with this designation is approved.
// Administrators only (the database refuses anyone else).
export async function setDesignationAccess(cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.assign_role");
    const role = str(fd, "access_role") ?? null;
    if (role && !ASSIGNABLE_ROLES.includes(role as Role)) throw new Error("Unknown role.");
    must(await ctx.supabase.from("designations").update({ access_role: role }).eq("id", id).eq("company_id", cid));
    return done(cid, "Saved.");
  });
}

// COM-05 holidays per branch
export async function addHoliday(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.org");
    const { supabase } = ctx;
    const row = { company_id: cid, date: str(fd, "date"), name: str(fd, "name"), branch_id: str(fd, "branch_id") };
    if (!row.date || !row.name) throw new Error("Date and name are required.");
    must(await supabase.from("holidays").insert(row));
    return done(cid, "Holiday added.");
  });
}

// roles: owner / company admin change a member's role or access
export async function setMemberRole(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "employees.assign_role");
    const { supabase } = ctx;
    const id = str(fd, "id");
    const role = str(fd, "role") ?? "";
    const active = fd.get("active") !== "false";
    // "custom:<id>" is one of the company's custom roles (§5.2): the database sets the base role from it
    if (role.startsWith("custom:")) {
      must(await supabase.from("company_members").update({ custom_role_id: role.slice(7), active }).eq("id", id!).eq("company_id", cid));
    } else {
      if (!ASSIGNABLE_ROLES.includes(role as Role)) throw new Error("Choose a valid role.");
      must(await supabase.from("company_members").update({ role, custom_role_id: null, active }).eq("id", id!).eq("company_id", cid));
    }
    return done(cid, "Member updated.");
  });
}

// BRD §5.2 custom roles: copy a default (or custom) role, then tick its permissions
export async function cloneRole(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "roles.manage");
    const from = str(fd, "from") ?? "";
    const custom = from.startsWith("custom:") ? from.slice(7) : null;
    const data = must(await ctx.supabase.rpc("clone_role", {
      p_company: cid, p_name: str(fd, "name"), p_from_role: custom ? null : from, p_from_custom: custom }));
    revalidatePath(`/c/${cid}/settings`);
    redirect(`/c/${cid}/settings?tab=roles&role=${data}&mode=edit`);
  });
}

export async function saveRole(cid: string, roleId: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "roles.manage");
    must(await ctx.supabase.rpc("save_role", { p_role: roleId, p_name: str(fd, "name"), p_permissions: fd.getAll("perm").map(String) }));
    return done(cid, "Role saved. People on this role get the new permissions on their next page load.");
  });
}

// a default role changed for this company only (0038); "Reset to standard" goes back to the BRD matrix
export async function saveDefaultRole(cid: string, role: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "roles.manage");
    must(await ctx.supabase.rpc("save_default_role", { p_company: cid, p_role: role, p_permissions: fd.getAll("perm").map(String) }));
    return done(cid, "Role saved for this company. People on this role get the new permissions on their next page load.");
  });
}

export async function resetDefaultRole(cid: string, role: string, _: ActionState, __: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "roles.manage");
    must(await ctx.supabase.rpc("reset_default_role", { p_company: cid, p_role: role }));
    revalidatePath(`/c/${cid}/settings`);
    redirect(`/c/${cid}/settings?tab=roles&role=default:${role}`);
  });
}

export async function deleteRole(cid: string, roleId: string, _: ActionState, __: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "roles.manage");
    must(await ctx.supabase.rpc("delete_role", { p_role: roleId }));
    revalidatePath(`/c/${cid}/settings`);
    redirect(`/c/${cid}/settings?tab=roles`);
  });
}

// COMMS-12 chat administration
export async function saveChatSettings(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.manage");
    const { supabase } = ctx;
    must(await supabase.from("companies").update({
      chat_cross_dept: bool(fd, "chat_cross_dept"), chat_retention_days: Math.max(30, numOrNull(fd, "chat_retention_days") ?? 730),
    }).eq("id", cid));
    return done(cid, "Chat settings saved.");
  });
}

// NFR-06 resolve a data export / deletion request
export async function resolveDataRequest(cid: string, id: string, status: "done" | "rejected") {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "settings.manage");
  const { supabase, user } = ctx;
  await supabase.from("data_requests").update({ status, resolved_by: user.id, resolved_at: new Date().toISOString() }).eq("id", id);
  revalidatePath(`/c/${cid}/settings`);
}

// X-04 scheduled report e-mails
export async function addSchedule(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.manage");
    const { supabase } = ctx;
    const recipients = (str(fd, "recipients") ?? "").split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (!recipients.length || recipients.some((r) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r))) throw new Error("Enter valid recipient emails.");
    must(await supabase.from("report_schedules").insert({ company_id: cid, report: str(fd, "report"), frequency: str(fd, "frequency"), recipients }));
    return done(cid, "Schedule added.");
  });
}

export async function deleteSchedule(cid: string, id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "settings.manage");
  const { supabase } = ctx;
  await supabase.from("report_schedules").delete().eq("id", id);
  revalidatePath(`/c/${cid}/settings`);
}

// OI-13: a Company Admin lets the platform Super Admin into this company for a limited time (1–72 h)
export async function grantSupportAccess(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "settings.manage");
    must(await ctx.supabase.rpc("grant_support_access", { p_company: cid, p_hours: Number(str(fd, "hours") ?? 0), p_reason: str(fd, "reason") ?? "" }));
    return done(cid, "Support access granted.");
  });
}

export async function revokeSupportAccess(cid: string, id: string) {
  const ctx = await getCtx(cid);
  assertPerm(ctx, "settings.manage");
  must(await ctx.supabase.rpc("revoke_support_access", { p_id: id }));
  revalidatePath(`/c/${cid}/settings`);
}
