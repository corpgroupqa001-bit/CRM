import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/guard";

// NFR-06 (DPDP Act): a person can download the personal data the platform holds about them.
// Runs as the user, so RLS returns only their own records. Encrypted PAN / Aadhaar / bank values stay masked.
export async function GET() {
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase, user } = auth;
  const { data: emps } = await supabase.from("employees")
    .select("id, company_id, emp_code, first_name, last_name, email, phone, dob, gender, address, emergency_name, emergency_phone, date_of_joining, employment_type, status, uan, esi_no, pan_last4, aadhaar_last4, bank_last4, ifsc, bank_name, created_at")
    .eq("user_id", user.id);
  const ids = (emps ?? []).map((e) => e.id);
  const [profile, logins, attendance, leave, documents, punches] = await Promise.all([
    supabase.from("profiles").select("full_name, email, created_at, consent_at").eq("id", user.id).maybeSingle(),
    supabase.from("login_history").select("at, ip, user_agent, method").eq("user_id", user.id).order("at", { ascending: false }).limit(500),
    supabase.from("daily_attendance").select("employee_id, date, status, first_in, last_out, worked_minutes, ot_minutes").in("employee_id", ids).order("date"),
    supabase.from("leave_requests").select("employee_id, from_date, to_date, days, reason, status").in("employee_id", ids),
    supabase.from("employee_documents").select("employee_id, name, doc_type, expiry_date, created_at").in("employee_id", ids),
    supabase.from("punches_raw").select("employee_id, punched_at, source, verify_type, lat, lng").in("employee_id", ids).order("punched_at").limit(20000),
  ]);
  const body = {
    exported_at: new Date().toISOString(), account: { id: user.id, email: user.email, ...profile.data },
    employee_records: emps ?? [], login_history: logins.data ?? [], attendance: attendance.data ?? [], punches: punches.data ?? [],
    leave: leave.data ?? [], documents: documents.data ?? [],
    note: "PAN, Aadhaar and bank account numbers are stored encrypted and shown here masked. Ask HR for a full copy of any document. " +
      "Payslips and tax declarations are held by the Salaries team: ask Finance / Payroll for a copy.",
  };
  return new NextResponse(JSON.stringify(body, null, 2), { headers: {
    "Content-Type": "application/json", "Content-Disposition": `attachment; filename="my-data-${new Date().toISOString().slice(0, 10)}.json"`, "Cache-Control": "no-store" } });
}
