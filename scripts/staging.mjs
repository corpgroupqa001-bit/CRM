// Staging: try every change locally on a separate Supabase project before it goes to GitHub (BRD §10.4).
//
//   pnpm staging:db     apply supabase/migrations to the staging database (never to live)
//   pnpm staging:seed   demo companies, one login per role, a locked month with an approved payroll
//   pnpm staging:dev    the app on http://localhost:3001 against staging (your normal `pnpm dev` stays on live)
//
// Reads .env.staging.local (NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
// SUPABASE_SERVICE_ROLE_KEY, STAGING_DB_URL). Refuses to run if it points at the same project as .env.local.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const read = (f) => existsSync(f) ? Object.fromEntries(readFileSync(f, "utf8").split("\n")
  .map((l) => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim().replace(/^"|"$/g, "")])) : null;

const staging = read(".env.staging.local");
if (!staging) {
  console.error("Missing .env.staging.local. Create a separate Supabase project and put its URL, anon key, service role key and STAGING_DB_URL there.");
  process.exit(1);
}
for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
  if (!staging[k]) { console.error(`.env.staging.local has no ${k}`); process.exit(1); }
}
const live = read(".env.local") ?? {};
const ref = (u) => (u ?? "").replace(/^https?:\/\//, "").split(".")[0];
if (ref(staging.NEXT_PUBLIC_SUPABASE_URL) === ref(live.NEXT_PUBLIC_SUPABASE_URL)) {
  console.error("Stopped: .env.staging.local points at the LIVE project. Use a separate Supabase project for staging.");
  process.exit(1);
}
if (staging.STAGING_DB_URL && live.NEXT_PUBLIC_SUPABASE_URL && staging.STAGING_DB_URL.includes(ref(live.NEXT_PUBLIC_SUPABASE_URL))) {
  console.error("Stopped: STAGING_DB_URL points at the LIVE database.");
  process.exit(1);
}

const run = (cmd, args, env) => new Promise((resolve) => {
  const p = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  p.on("exit", (code) => resolve(code ?? 1));
});

const command = process.argv[2];
if (command === "dev") {
  // values set here win over .env.local (Next.js never overwrites variables that are already set)
  process.exit(await run("npx", ["next", "dev", "--turbopack", "-p", "3001"], { ...staging, NEXT_DIST_DIR: ".next-staging", NEXT_PUBLIC_APP_URL: "http://localhost:3001" }));
} else if (command === "db") {
  if (!staging.STAGING_DB_URL) { console.error(".env.staging.local has no STAGING_DB_URL (Supabase → Connect → Session pooler URI)"); process.exit(1); }
  process.exit(await run("npx", ["-y", "supabase@2.122.0", "db", "push", "--db-url", staging.STAGING_DB_URL, "--include-all", "--yes"], {}));
} else if (command === "seed") {
  await seed();
} else {
  console.error("Usage: node scripts/staging.mjs dev | db | seed [--reset]");
  process.exit(1);
}

async function seed() {
  const require = createRequire(import.meta.url);
  const { createClient } = require("@supabase/supabase-js");
  const url = staging.NEXT_PUBLIC_SUPABASE_URL;
  const db = createClient(url, staging.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const must = (r) => { if (r.error) throw new Error(r.error.message); return r.data; };
  const PASSWORD = "Demo@12345";
  const PEOPLE = [
    ["owner", "Olivia Owner", "owner"], ["admin", "Arun Admin", "employee"], ["hr", "Hema HR", "hr"],
    ["manager", "Manoj Manager", "manager"], ["ravi", "Ravi Kumar", "employee"], ["sita", "Sita Rao", "employee"],
  ];
  const mail = (k) => `${k}@demo.test`;

  const { data: existing } = await db.from("profiles").select("id").eq("email", mail("owner")).maybeSingle();
  if (existing && !process.argv.includes("--reset")) {
    console.log("Staging already has the demo data. Run `pnpm staging:seed -- --reset` to start again.");
    return printLogins();
  }
  if (existing) {
    const { data: cos } = await db.from("companies").select("id").eq("owner_id", existing.id);
    for (const c of cos ?? []) {
      for (const t of ["work_breaks", "work_sessions", "wfh_days", "payslip_lines", "payslips", "payroll_runs", "attendance_locks", "daily_attendance", "employee_ctc", "tasks", "notifications", "support_access"]) {
        await db.from(t).delete().eq("company_id", c.id);
      }
      await db.from("companies").delete().eq("id", c.id);
    }
    for (const [k] of PEOPLE) {
      const { data: p } = await db.from("profiles").select("id").eq("email", mail(k)).maybeSingle();
      if (p) await db.auth.admin.deleteUser(p.id);
    }
  }

  const U = {};
  for (const [k, name] of PEOPLE) {
    const u = must(await db.auth.admin.createUser({ email: mail(k), password: PASSWORD, email_confirm: true, user_metadata: { full_name: name } })).user;
    U[k] = u.id;
    await db.from("profiles").update({ full_name: name, consent_at: new Date().toISOString() }).eq("id", u.id);
  }
  // two companies owned by the same person (COM-01, COM-07)
  const cid = must(await db.rpc("create_company_for", { p_user: U.owner, p_name: "Demo Industries" }));
  must(await db.rpc("create_company_for", { p_user: U.owner, p_name: "Demo Logistics" }));
  await db.from("companies").update({ state: "Telangana" }).eq("id", cid);

  const dept = {};
  for (const d of ["Engineering", "Human Resources", "Sales"]) dept[d] = must(await db.from("departments").insert({ company_id: cid, name: d }).select("id").single()).id;
  const desig = must(await db.from("designations").insert({ company_id: cid, name: "Software Engineer", department_id: dept.Engineering }).select("id").single()).id;
  const E = {};
  for (const [k, name, role] of PEOPLE.slice(1)) {
    await db.from("company_members").insert({ company_id: cid, user_id: U[k], role });
    const [first, last] = name.split(" ");
    E[k] = must(await db.from("employees").insert({
      company_id: cid, user_id: U[k], first_name: first, last_name: last, email: mail(k), date_of_joining: "2026-01-01", invite_role: role,
      department_id: k === "hr" ? dept["Human Resources"] : dept.Engineering, designation_id: ["ravi", "sita"].includes(k) ? desig : null,
      // everyone works on site: device punches only (no work from home or mobile punch since 30 Oct, 0054)
    }).select("id").single()).id;
  }
  await db.from("employees").update({ reporting_manager_id: E.manager }).in("id", [E.ravi, E.sita]);
  const { data: ownerEmp } = await db.from("employees").select("id").eq("company_id", cid).eq("user_id", U.owner).single();
  E.owner = ownerEmp.id;

  // salaries and a full September 2026 of attendance, so payroll can run
  const { data: structure } = await db.from("salary_structures").select("id").eq("company_id", cid).limit(1).single();
  for (const [k, ctc] of [["admin", 900000], ["hr", 600000], ["manager", 840000], ["ravi", 480000], ["sita", 420000], ["owner", 1200000]]) {
    must(await db.from("employee_ctc").insert({ company_id: cid, employee_id: E[k], structure_id: structure.id, annual_ctc: ctc, effective_from: "2026-01-01" }));
  }
  const rows = [];
  for (let d = 1; d <= 30; d++) {
    const date = `2026-09-${String(d).padStart(2, "0")}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    for (const k of Object.keys(E)) {
      const status = sunday ? "weekly_off" : k === "sita" && d === 15 ? "absent" : "present";
      rows.push({ company_id: cid, employee_id: E[k], date, status, worked_minutes: status === "present" ? 540 : 0 });
    }
  }
  must(await db.from("daily_attendance").insert(rows));

  // HR locks the month and prepares payroll; the Owner approves it (SAL-09)
  const as = async (k) => {
    const c = createClient(url, staging.NEXT_PUBLIC_SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    must(await c.auth.signInWithPassword({ email: mail(k), password: PASSWORD }));
    return c;
  };
  const hr = await as("hr");
  must(await hr.rpc("lock_attendance_month", { p_company: cid, p_month: "2026-09-01" }));
  const run = must(await hr.rpc("run_payroll", { p_company: cid, p_month: "2026-09-01" }));
  const owner = await as("owner");
  must(await owner.rpc("approve_payroll", { p_run: run }));

  // Arun is the platform Super Admin and an Employee here (no Company Admin role since 30 Oct, 0051)
  must(await db.from("platform_admins").upsert({ user_id: U.admin, note: "staging demo" }));

  // a biometric device at the gate; Sita (on-site) punched in and out this morning (ATT-02/04)
  const admin = owner;
  const dev = must(await admin.rpc("register_device", { p_company: cid, p_branch: null, p_name: "Main gate (demo)", p_serial: "DEMO-GATE-1", p_vendor: "ZKTeco", p_model: "K40", p_ip: null, p_mode: "push" })).device_id;
  must(await admin.rpc("map_device_user", { p_device: dev, p_device_user_id: "102", p_emp: E.sita }));
  const day = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  for (const t of ["08:58", "13:05"]) {
    must(await db.from("punches_raw").insert({ company_id: cid, device_id: dev, device_user_id: "102", employee_id: E.sita, punched_at: `${day}T${t}:00+05:30`, source: "device", verify_type: "fingerprint" }));
  }
  must(await admin.rpc("recalculate_attendance", { p_company: cid, p_from: day, p_to: day }));


  console.log("\nStaging demo data is ready.");
  printLogins();
}

function printLogins() {
  console.log(`
Sign in at http://localhost:3001 (company: Demo Industries), password Demo@12345:
  Owner          owner@demo.test     (also owns Demo Logistics)
  Employee       admin@demo.test     (Arun: also the platform Super Admin, http://localhost:3001/admin)
  HR / Payroll   hr@demo.test
  Manager        manager@demo.test   (manages Ravi and Sita)
  Employee       ravi@demo.test      (September payslip)
  Employee       sita@demo.test      (on-site: device punches today; September payslip)
Admin portal: http://localhost:3001/admin (Super Admin: admin@demo.test).
`);
}
