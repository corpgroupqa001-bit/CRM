"use server";
import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { assertPerm, getCtx } from "@/lib/context";
import { attempt, must, numOrNull, str, type ActionState } from "@/lib/actions";

const rv = (cid: string) => revalidatePath(`/c/${cid}/attendance`, "layout");

// ATT-12 mobile punch: selfie uploaded by the user, geofence checked in the database
export async function mobilePunch(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, employee } = await getCtx(cid);
    if (!employee) throw new Error("You don't have an employee record in this company.");
    const lat = numOrNull(fd, "lat"), lng = numOrNull(fd, "lng");
    if (lat == null || lng == null) throw new Error("Location is required. Allow location access and try again.");
    const selfie = fd.get("selfie");
    if (!(selfie instanceof File) || !selfie.size) throw new Error("Take a selfie first.");
    const path = `${cid}/${employee.id}/${Date.now()}.jpg`;
    must(await supabase.storage.from("selfies").upload(path, selfie, { contentType: selfie.type || "image/jpeg" }));
    const r = must(await supabase.rpc("mobile_punch", { p_company: cid, p_lat: lat, p_lng: lng, p_selfie_path: path })) as { distance_m: number };
    rv(cid);
    return `Punch recorded (${r.distance_m} m from your branch).`;
  });
}

// ATT-13 regularisation request
export async function requestRegularisation(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, employee } = await getCtx(cid);
    if (!employee) throw new Error("No employee record.");
    must(await supabase.from("regularisations").insert({
      company_id: cid, employee_id: employee.id, date: str(fd, "date"), kind: str(fd, "kind") ?? "missed_punch",
      in_time: str(fd, "in_time"), out_time: str(fd, "out_time"), reason: str(fd, "reason"),
    }));
    rv(cid);
    return "Request sent to your manager.";
  });
}

export async function decideRegularisation(cid: string, id: string, status: "approved" | "rejected") {
  const { supabase } = await getCtx(cid);
  const { error } = await supabase.from("regularisations").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  rv(cid);
}

export async function cancelRegularisation(cid: string, id: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("regularisations").update({ status: "cancelled" }).eq("id", id).eq("status", "pending");
  rv(cid);
}

export async function approveOvertime(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("approve_overtime", { p_attendance: str(fd, "id"), p_minutes: Math.round(Number(str(fd, "hours") ?? 0) * 60) }));
    rv(cid);
    return "Overtime updated.";
  });
}

// HR manual override: a reason is required (also enforced by the database) and logged in the audit trail
export async function overrideStatus(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "attendance.manage");
    if (!str(fd, "remarks")) throw new Error("Give a reason for the attendance correction.");
    const { supabase } = ctx;
    must(await supabase.rpc("set_attendance_status", {
      p_emp: str(fd, "employee_id"), p_date: str(fd, "date"), p_status: str(fd, "status"), p_remarks: str(fd, "remarks") }));
    rv(cid);
    return "Attendance updated.";
  });
}

export async function recompute(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const from = str(fd, "from")!, to = str(fd, "to") ?? from;
    must(await supabase.rpc("recalculate_attendance", { p_company: cid, p_from: from, p_to: to }));
    rv(cid);
    return "Attendance recalculated from punches.";
  });
}

// ATT-15 month lock / unlock
export async function lockMonth(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("lock_attendance_month", { p_company: cid, p_month: str(fd, "month") }));
    rv(cid);
    return "Month locked. Payroll can now run for it.";
  });
}

export async function unlockMonth(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("unlock_attendance_month", { p_company: cid, p_month: str(fd, "month"), p_reason: str(fd, "reason") }));
    rv(cid);
    return "Month unlocked. The reason was recorded in the audit log.";
  });
}

// ATT-03 device registry
export async function registerDevice(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const r = must(await supabase.rpc("register_device", {
      p_company: cid, p_branch: str(fd, "branch_id"), p_name: str(fd, "name"), p_serial: str(fd, "serial_no"),
      p_vendor: str(fd, "vendor"), p_model: str(fd, "model"), p_ip: str(fd, "ip"), p_mode: str(fd, "mode") ?? "push" })) as Record<string, string>;
    rv(cid);
    return { ok: "Device registered. Copy the secrets now — they are not shown again.", data: r };
  });
}

export async function deleteDevice(cid: string, id: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("devices").delete().eq("id", id);
  rv(cid);
}

export async function saveAllowlist(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const list = (str(fd, "ip_allowlist") ?? "").split(/[\s,]+/).filter(Boolean);
    must(await supabase.from("devices").update({ ip_allowlist: list }).eq("id", str(fd, "id")!));
    rv(cid);
    return "IP allow-list saved.";
  });
}

// ATT-06 exceptions queue → map
export async function mapException(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const n = must(await supabase.rpc("map_device_user", { p_device: str(fd, "device_id"), p_device_user_id: str(fd, "device_user_id"), p_emp: str(fd, "employee_id") }));
    rv(cid);
    return `Mapped ${n} punch(es).`;
  });
}

// fallback for devices without an API: CSV / Excel with emp_code, timestamp (YYYY-MM-DD HH:MM)
export async function importPunches(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const file = fd.get("file");
    if (!(file instanceof File) || !file.size) throw new Error("Choose a file.");
    const wb = XLSX.read(Buffer.from(await file.arrayBuffer()), { cellDates: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: "" }).map((r) => {
      const ts = r.timestamp instanceof Date ? r.timestamp.toISOString().replace("T", " ").slice(0, 19) : String(r.timestamp ?? "").trim();
      return { emp_code: String(r.emp_code ?? "").trim(), timestamp: ts };
    }).filter((r) => r.emp_code && r.timestamp);
    const r = must(await supabase.rpc("import_punches", { p_company: cid, p_rows: rows })) as { imported: number; skipped: number };
    rv(cid);
    return `Imported ${r.imported} punch(es); ${r.skipped} row(s) skipped (unknown employee code).`;
  });
}

// ATT-08 shifts
export async function saveShift(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const row = {
      company_id: cid, name: str(fd, "name"), start_time: str(fd, "start_time"), end_time: str(fd, "end_time"),
      grace_min: numOrNull(fd, "grace_min") ?? 0, break_min: numOrNull(fd, "break_min") ?? 0,
      half_day_hours: numOrNull(fd, "half_day_hours") ?? 4, full_day_hours: numOrNull(fd, "full_day_hours") ?? 8,
      is_default: fd.get("is_default") === "on",
    };
    if (row.is_default) await supabase.from("shifts").update({ is_default: false }).eq("company_id", cid);
    const id = str(fd, "id");
    must(id ? await supabase.from("shifts").update(row).eq("id", id) : await supabase.from("shifts").insert(row));
    rv(cid);
    return "Shift saved.";
  });
}

// X-07 bulk decision on attendance corrections
export async function bulkRegularisations(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const ids = fd.getAll("ids").map(String);
    const status = str(fd, "decision") === "rejected" ? "rejected" : "approved";
    if (!ids.length) throw new Error("Select at least one request.");
    let ok = 0; const failed: string[] = [];
    for (const id of ids) {
      const { error } = await supabase.from("regularisations").update({ status }).eq("id", id);
      if (error) failed.push(error.message); else ok++;
    }
    rv(cid);
    return failed.length ? { error: `${ok} ${status}; ${failed.length} failed: ${failed[0]}` } : `${ok} correction(s) ${status}.`;
  });
}

// ---------------------------------------------------------------------------
// Work from home (ATT-20 to ATT-33). Times come from the database clock; the phone only sends the selfie
// (live camera, uploaded to the employee's own folder) and, if the company enables it, its location.
// ---------------------------------------------------------------------------
async function uploadWorkSelfie(cid: string, fd: FormData, kind: "in" | "out") {
  const { supabase, employee } = await getCtx(cid);
  if (!employee) throw new Error("You don't have an employee record in this company.");
  const selfie = fd.get("selfie");
  if (!(selfie instanceof File) || !selfie.size) return { supabase, path: null };   // ATT-27: accepted and flagged "photo missing"
  if (selfie.size > 2_000_000) throw new Error("The photo is too large.");
  const path = `${cid}/${employee.id}/wfh-${new Date().toISOString().slice(0, 10)}-${kind}-${Date.now()}.jpg`;
  must(await supabase.storage.from("selfies").upload(path, selfie, { contentType: "image/jpeg" }));
  return { supabase, path };
}

export async function wfhCheckIn(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, path } = await uploadWorkSelfie(cid, fd, "in");
    must(await supabase.rpc("wfh_check_in", { p_company: cid, p_selfie_path: path, p_device: str(fd, "device"), p_lat: numOrNull(fd, "lat"), p_lng: numOrNull(fd, "lng") }));
    rv(cid);
    return path ? "Checked in." : "Checked in without a photo; your manager will see it flagged.";
  });
}

export async function wfhCheckOut(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, path } = await uploadWorkSelfie(cid, fd, "out");
    must(await supabase.rpc("wfh_check_out", { p_company: cid, p_selfie_path: path }));
    rv(cid);
    return "Checked out.";
  });
}

export async function wfhBreak(cid: string, start: boolean): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("wfh_break", { p_company: cid, p_start: start }));
    rv(cid);
    return start ? "Break started." : "Back at work.";
  });
}

export async function requestWfh(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("request_wfh", { p_company: cid, p_date: str(fd, "date"), p_reason: str(fd, "reason") }));
    rv(cid);
    return "Request sent to your manager.";
  });
}

export async function decideWfh(cid: string, id: string, approve: boolean) {
  const { supabase } = await getCtx(cid);
  must(await supabase.rpc("decide_wfh", { p_id: id, p_approve: approve, p_note: null }));
  rv(cid);
}

export async function cancelWfh(cid: string, id: string) {
  const { supabase } = await getCtx(cid);
  must(await supabase.rpc("cancel_wfh", { p_id: id }));
  rv(cid);
}

export async function assignWfh(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const ctx = await getCtx(cid);
    assertPerm(ctx, "attendance.manage");
    const [scope, target] = (str(fd, "target") ?? "").split(":");   // "employee:<id>", "department:<id>" or "branch:<id>"
    if (!target) throw new Error("Choose who works from home.");
    const n = must(await ctx.supabase.rpc("assign_wfh", {
      p_company: cid, p_from: str(fd, "from"), p_to: str(fd, "to"),
      p_employee: scope === "employee" ? target : null, p_department: scope === "department" ? target : null, p_branch: scope === "branch" ? target : null,
      p_weekdays: fd.getAll("weekdays").map(Number), p_alternate_weeks: fd.get("alternate") === "on",
    })) as number;
    rv(cid);
    return n ? `${n} work-from-home day${n === 1 ? "" : "s"} set. Only employees allowed to work from home are included.` : "No new days: nobody in that group is allowed to work from home, or the days were already set.";
  });
}

// Selfie flags (decision 27 Oct 2026): HR or the reporting manager flags, the employee explains, then it is closed
export async function flagSelfie(cid: string, source: string, ref: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("flag_selfie", { p_source: source, p_ref: ref, p_reason: str(fd, "reason"), p_note: str(fd, "note") }));
    rv(cid);
    return "Selfie flagged. The employee has been asked to explain.";
  });
}

export async function explainSelfieFlag(cid: string, id: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.rpc("explain_selfie_flag", { p_id: id, p_text: str(fd, "explanation") }));
    rv(cid);
    return "Explanation sent.";
  });
}

export async function closeSelfieFlag(cid: string, id: string, upheld: boolean) {
  const { supabase } = await getCtx(cid);
  must(await supabase.rpc("close_selfie_flag", { p_id: id, p_upheld: upheld, p_note: null }));
  rv(cid);
}
