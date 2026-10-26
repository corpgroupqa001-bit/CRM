// Demo data for a hosted Supabase project:  pnpm seed
// Creates owner demo@corpgroup.com (password Demo@1234), two companies, branches, 20 employees with
// salaries, a registered device and last month's punches (so attendance → payroll can be tried end to end).
import { createClient } from "@supabase/supabase-js";
import { createCipheriv, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const key = Buffer.from(process.env.FIELD_ENCRYPTION_KEY ?? "", "base64");
const enc = (v: string) => {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const d = Buffer.concat([c.update(v, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), d].map((b) => b.toString("base64")).join(".");
};
const must = <T>(r: { data: T; error: unknown }) => { if (r.error) throw r.error; return r.data as NonNullable<T>; };

const FIRST = ["Aarav", "Diya", "Vihaan", "Ananya", "Arjun", "Saanvi", "Reyansh", "Ishita", "Kabir", "Meera", "Rohan", "Kavya", "Aditya", "Pooja", "Siddharth", "Nisha", "Rahul", "Sneha", "Vikram", "Lakshmi"];
const LAST = ["Reddy", "Sharma", "Rao", "Iyer", "Naidu", "Patel", "Varma", "Gupta", "Menon", "Kumar"];

async function main() {
  const email = "demo@corpgroup.com";
  let { data: profile } = await db.from("profiles").select("id").eq("email", email).maybeSingle();
  if (!profile) {
    const { data: u, error } = await db.auth.admin.createUser({ email, password: "Demo@1234", email_confirm: true, user_metadata: { full_name: "Demo Owner" } });
    if (error || !u.user) throw error;
    profile = { id: u.user.id };
  }
  const owner = profile.id;

  for (const [ci, cname] of ["Acme Industries", "Acme Retail"].entries()) {
    const company = must(await db.from("companies").insert({ owner_id: owner, name: cname, legal_name: `${cname} Pvt Ltd`, state: "Telangana", address: "Hitec City, Hyderabad" }).select("id").single());
    const cid = company.id;
    await db.from("statutory_settings").update({ verified_on: null }).eq("company_id", cid);
    const branch = must(await db.from("branches").insert({ company_id: cid, name: "Hyderabad HQ", lat: 17.4474, lng: 78.3762, geofence_m: 300 }).select("id").single());
    const deps = must(await db.from("departments").select("id, name").eq("company_id", cid));
    const sales = must(await db.from("departments").insert({ company_id: cid, name: "Sales" }).select("id").single());
    const desig = must(await db.from("designations").insert([{ company_id: cid, name: "Manager" }, { company_id: cid, name: "Executive" }]).select("id, name"));
    const struct = must(await db.from("salary_structures").select("id").eq("company_id", cid).limit(1).single());
    const depIds = [...deps.map((d) => d.id), sales.id];

    await db.from("employees").insert({ company_id: cid, user_id: owner, first_name: "Demo", last_name: "Owner", email, date_of_joining: "2024-04-01", branch_id: branch.id, department_id: depIds[0] });
    const n = ci === 0 ? 14 : 6;
    const rows = Array.from({ length: n }, (_, i) => {
      const fn = FIRST[(i + ci * 7) % FIRST.length], ln = LAST[(i * 3 + ci) % LAST.length];
      const acct = String(50100000000 + i * 7919 + ci);
      return {
        company_id: cid, first_name: fn, last_name: ln, email: `${fn}.${ln}.${ci}${i}@example.in`.toLowerCase(), phone: `98480${String(10000 + i).slice(-5)}`,
        date_of_joining: i === n - 1 ? "2026-09-16" : `202${3 + (i % 3)}-0${1 + (i % 9)}-01`, branch_id: branch.id, department_id: depIds[i % depIds.length],
        designation_id: desig[i === 0 ? 0 : 1].id, mobile_attendance: i % 4 === 0, invite_role: i === 0 ? "manager" : "employee",
        ifsc: "HDFC0001234", bank_name: "HDFC Bank",
        ...(key.length === 32 ? { bank_account_enc: enc(acct), bank_last4: acct.slice(-4) } : {}),
        uan: `10090${String(1000000 + ci * 100 + i)}`,   // 12 digits
      };
    });
    const emps = must(await db.from("employees").insert(rows).select("id, date_of_joining"));
    await db.from("employees").update({ reporting_manager_id: emps[0].id }).in("id", emps.slice(1).map((e) => e.id));
    await db.from("employee_ctc").insert(emps.map((e, i) => ({ company_id: cid, employee_id: e.id, structure_id: struct.id, annual_ctc: 240000 + i * 36000, effective_from: e.date_of_joining })));

    const dev = must(await db.rpc("register_device", { p_company: cid, p_branch: branch.id, p_name: "Main gate", p_serial: `DEMO-${ci + 1}-${Date.now().toString(36)}`, p_vendor: "ZKTeco", p_model: "K40", p_ip: null, p_mode: "push" })) as { device_id: string };
    await db.from("device_user_map").insert(emps.map((e, i) => ({ company_id: cid, device_id: dev.device_id, device_user_id: String(100 + i), employee_id: e.id })));

    // last month's punches: 09:00 ± a few minutes in, 18:00–19:30 out, Sundays off, a few absences and late days
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const days = new Date(now.getFullYear(), now.getMonth(), 0).getDate();
    const punches: Record<string, unknown>[] = [];
    emps.forEach((e, i) => {
      for (let d = 1; d <= days; d++) {
        const day = new Date(first.getFullYear(), first.getMonth(), d);
        const ymd = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (day.getDay() === 0 || ymd < e.date_of_joining || (i + d) % 17 === 0) continue;
        const late = (i + d) % 11 === 0 ? 25 : (i * d) % 9;
        const out = 60 * 18 + ((i * 7 + d) % 90);
        const t = (m: number) => `${ymd}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+05:30`;
        punches.push({ company_id: cid, device_id: dev.device_id, device_user_id: String(100 + i), employee_id: e.id, punched_at: t(9 * 60 + late), verify_type: "fingerprint", source: "device" });
        if ((i + d) % 23 !== 0) punches.push({ company_id: cid, device_id: dev.device_id, device_user_id: String(100 + i), employee_id: e.id, punched_at: t(out), verify_type: "fingerprint", source: "device" });
      }
    });
    for (let k = 0; k < punches.length; k += 500) must(await db.from("punches_raw").insert(punches.slice(k, k + 500)));
    await db.from("holidays").insert({ company_id: cid, date: `${now.getFullYear()}-10-02`, name: "Gandhi Jayanti" });
    const proj = must(await db.from("projects").insert({ company_id: cid, name: "Store rollout", client: "Internal", manager_id: emps[0].id, status: "active" }).select("id").single());
    await db.from("project_members").insert(emps.slice(0, 5).map((e) => ({ project_id: proj.id, employee_id: e.id, company_id: cid })));
    const tasks = must(await db.from("tasks").insert([
      { company_id: cid, project_id: proj.id, title: "Finalise vendor list", priority: "high", status: "in_progress", created_by: owner, due_at: new Date(Date.now() + 2 * 86400000).toISOString() },
      { company_id: cid, project_id: proj.id, title: "Site survey – Kukatpally", priority: "medium", status: "todo", created_by: owner, due_at: new Date(Date.now() - 86400000).toISOString() },
      { company_id: cid, title: "Submit September expense claims", priority: "low", status: "done", created_by: owner },
    ]).select("id"));
    await db.from("task_assignees").insert(tasks.map((t, i) => ({ task_id: t.id, employee_id: emps[i].id, company_id: cid })));
    console.log(`✓ ${cname}: ${emps.length} employees, ${punches.length} punches`);
  }
  console.log("\nSign in as demo@corpgroup.com / Demo@1234. Attendance → Month lock → lock last month, then Payroll → Run.");
}

main().catch((e) => { console.error(e); process.exit(1); });
