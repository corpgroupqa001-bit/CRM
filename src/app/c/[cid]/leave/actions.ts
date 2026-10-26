"use server";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { leaveEnabled } from "@/lib/rbac";
import { attempt, bool, must, numOrNull, str, type ActionState } from "@/lib/actions";

const rv = (cid: string) => revalidatePath(`/c/${cid}/leave`);
// the whole module is off in Phase 1 (platform_features; RLS blocks the tables too)
const assertLeave = async (cid: string) => {
  if (!leaveEnabled((await getCtx(cid)).perms)) throw new Error("Leave Management isn't enabled.");
};

// ATT-18: apply; balance and overlap are checked by the database trigger
export async function applyLeave(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  await assertLeave(cid);
  return attempt(async () => {
    const { supabase, employee } = await getCtx(cid);
    if (!employee) throw new Error("No employee record.");
    const half = bool(fd, "half_day");
    const from = str(fd, "from_date");
    must(await supabase.from("leave_requests").insert({
      company_id: cid, employee_id: employee.id, leave_type_id: str(fd, "leave_type_id"),
      from_date: from, to_date: half ? from : str(fd, "to_date") ?? from, half_day: half, reason: str(fd, "reason"),
    }));
    rv(cid);
    return "Leave request sent to your manager.";
  });
}

export async function setLeaveStatus(cid: string, id: string, status: "approved" | "rejected" | "cancelled") {
  await assertLeave(cid);
  const { supabase } = await getCtx(cid);
  const { error } = await supabase.from("leave_requests").update({ status }).eq("id", id);
  if (error) throw new Error(error.message);
  rv(cid);
}

export async function saveLeaveType(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  await assertLeave(cid);
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const row = {
      company_id: cid, code: str(fd, "code")?.toUpperCase(), name: str(fd, "name"), paid: bool(fd, "paid"),
      annual_quota: numOrNull(fd, "annual_quota") ?? 0, accrual: str(fd, "accrual") ?? "yearly",
      carry_forward_max: numOrNull(fd, "carry_forward_max") ?? 0, encashable: bool(fd, "encashable"),
      allow_negative: bool(fd, "allow_negative"), active: fd.get("active") !== "false",
    };
    const id = str(fd, "id");
    must(id ? await supabase.from("leave_types").update(row).eq("id", id) : await supabase.from("leave_types").insert(row));
    rv(cid);
    return "Leave type saved.";
  });
}

export async function setOpening(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  await assertLeave(cid);
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    must(await supabase.from("leave_balances").upsert({
      company_id: cid, employee_id: str(fd, "employee_id"), leave_type_id: str(fd, "leave_type_id"),
      year: numOrNull(fd, "year"), opening: numOrNull(fd, "opening") ?? 0,
    }, { onConflict: "employee_id,leave_type_id,year" }));
    rv(cid);
    return "Opening balance saved.";
  });
}

// ATT-17: year-end carry-forward, capped per leave type
export async function carryForward(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  await assertLeave(cid);
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const year = numOrNull(fd, "year")!;
    const n = must(await supabase.rpc("carry_forward_leaves", { p_company: cid, p_year: year })) as number;
    rv(cid);
    return `Carried ${year} balances into ${year + 1} for ${n} employee / leave-type pair(s).`;
  });
}

// X-07 bulk approve / reject (each row still goes through the same database checks)
export async function bulkLeave(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  await assertLeave(cid);
  return attempt(async () => {
    const { supabase } = await getCtx(cid);
    const ids = fd.getAll("ids").map(String);
    const status = str(fd, "decision") === "rejected" ? "rejected" : "approved";
    if (!ids.length) throw new Error("Select at least one request.");
    let ok = 0; const failed: string[] = [];
    for (const id of ids) {
      const { error } = await supabase.from("leave_requests").update({ status }).eq("id", id);
      if (error) failed.push(error.message); else ok++;
    }
    rv(cid);
    return failed.length ? { error: `${ok} ${status}; ${failed.length} failed: ${failed[0]}` } : `${ok} request(s) ${status}.`;
  });
}
