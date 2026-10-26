import { NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMail } from "@/lib/email/mailer";
import { employeeExportRows, fullName } from "@/lib/employees";

export const runtime = "nodejs";

// X-04 scheduled report e-mails. Called once a day by Vercel Cron (vercel.json) with
// "Authorization: Bearer <CRON_SECRET>". Daily schedules go every day, weekly on Mondays,
// monthly on the 1st (India time). Nothing is sent twice in the same period.
const book = (rows: Record<string, unknown>[], sheet: string) => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.length ? rows : [{ info: "No data" }]), sheet);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
};

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const today = ist.toISOString().slice(0, 10);
  const { data: schedules } = await db.from("report_schedules").select("*, companies(name)");
  const results: { id: string; status: string }[] = [];

  for (const s of schedules ?? []) {
    const last = s.last_sent_at ? new Date(new Date(s.last_sent_at).getTime() + 5.5 * 3600000).toISOString().slice(0, 10) : null;
    const due = s.frequency === "daily" ? last !== today
      : s.frequency === "weekly" ? ist.getUTCDay() === 1 && last !== today
      : ist.getUTCDate() === 1 && last !== today;
    if (!due) continue;

    let rows: Record<string, unknown>[] = [];
    let title = "";
    if (s.report === "employees") {
      title = "Employee directory";
      rows = await employeeExportRows(db, s.company_id);
    } else if (s.report === "projects") {
      title = "Projects";
      rows = (await db.from("projects").select("name, client, status, start_date, end_date").eq("company_id", s.company_id).order("name")).data ?? [];
    } else {
      // attendance: previous month for monthly schedules, otherwise month to date
      const ref = s.frequency === "monthly" ? new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1)) : new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1));
      const from = ref.toISOString().slice(0, 10);
      const to = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      title = `Attendance ${from.slice(0, 7)}`;
      const [{ data: people }, { data: att }] = await Promise.all([
        // server client: read employees directly (the directory view only answers signed-in members)
        db.from("employees").select("id, emp_code, first_name, last_name, departments(name)").eq("company_id", s.company_id),
        db.from("daily_attendance").select("employee_id, status, late, worked_minutes, ot_approved_minutes").eq("company_id", s.company_id).gte("date", from).lte("date", to),
      ]);
      rows = (people ?? []).map((p) => {
        const a = (att ?? []).filter((x) => x.employee_id === p.id);
        const c = (st: string[]) => a.filter((x) => st.includes(x.status)).length;
        return { code: p.emp_code, name: fullName(p), department: (p.departments as unknown as { name: string } | null)?.name ?? null, present: c(["present", "late", "early_out", "on_duty", "wfh"]),
          half_days: c(["half_day"]), absent: c(["absent", "missed_punch"]), leave: c(["on_leave"]), late_marks: a.filter((x) => x.late).length,
          hours: +(a.reduce((t, x) => t + x.worked_minutes, 0) / 60).toFixed(1), ot_hours: +(a.reduce((t, x) => t + x.ot_approved_minutes, 0) / 60).toFixed(1) };
      }).filter((r) => r.present + r.half_days + r.absent + r.leave > 0);
    }
    const company = (s.companies as { name: string } | null)?.name ?? "";
    const sent = await sendMail({
      to: s.recipients.join(","), subject: `${company}: ${title} (${s.frequency} report)`,
      text: `The ${s.frequency} ${title.toLowerCase()} report for ${company} is attached.`,
      html: `<p>The ${s.frequency} <b>${title}</b> report for ${company} is attached.</p>`,
      attachments: [{ filename: `${title.toLowerCase().replace(/\s+/g, "-")}.xlsx`, content: book(rows, title.slice(0, 30)) }],
    });
    if (sent.ok) await db.from("report_schedules").update({ last_sent_at: new Date().toISOString() }).eq("id", s.id);
    results.push({ id: s.id, status: sent.ok ? "sent" : `failed: ${sent.error}` });
  }
  return NextResponse.json({ ran_at: new Date().toISOString(), results });
}
