import Link from "next/link";
import {
  AlertTriangle, ArrowRight, CalendarClock, CheckCircle2, Clock, FileWarning, Fingerprint, Plane,
  UserCheck, UserX, Users,
} from "lucide-react";
import { getCtx } from "@/lib/context";
import { leaveEnabled } from "@/lib/rbac";
import { Badge, Card, Empty, PageHeader, Stat } from "@/components/ui";
import { AttendanceTrend, HeadcountBars } from "@/components/charts";
import { RunPayrollButton } from "@/components/run-payroll-button";
import { dayCounts, fetchAll, presentShare, type SummaryEmployee, type SummaryRow } from "@/lib/attendance-summary";
import { fmtDate, fmtMonth, fmtTime, money, todayIST } from "@/lib/format";

export const metadata = { title: "Dashboard" };


// X-02 role-based home dashboard
export default async function Dashboard({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const { supabase, perms, employee, company } = await getCtx(cid);
  const seesAttendance = perms.has("attendance.read_all") || perms.has("attendance.read_team");
  const seesPayroll = perms.has("salaries.read");
  const managesAttendance = perms.has("attendance.manage");
  const seesAllEmployees = perms.has("employees.read_all");
  const seesTasks = perms.has("tasks.use");
  const leaveOn = leaveEnabled(perms);
  const none = Promise.resolve({ data: null, count: 0 });
  const today = todayIST();
  const base = `/c/${cid}`;
  const hour = new Date(Date.now() + 5.5 * 3600000).getUTCHours();
  const greet = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  // every query set starts now and runs in parallel (one round trip instead of three in a row).
  // Real data, scoped by RLS: HR sees the whole company, a manager their reports (and themself).
  // Rows are paged because Supabase returns at most 1,000 per request.
  const now = new Date().toISOString();
  const from = new Date(Date.parse(today) - 13 * 86400000).toISOString().slice(0, 10);
  const teamQ = seesAttendance ? Promise.all([
      fetchAll<SummaryEmployee & { departments: { name: string } | null }>((f, t) => supabase.from("employees")
        .select("id, branch_id, date_of_joining, last_working_day, status, departments(name)").eq("company_id", cid)
        .in("status", ["active", "notice", "exited"]).order("id").range(f, t)),
      fetchAll<SummaryRow>((f, t) => supabase.from("daily_attendance").select("employee_id, date, status")
        .eq("company_id", cid).gte("date", from).lte("date", today).order("id").range(f, t)),
      supabase.from("holidays").select("date, branch_id").eq("company_id", cid).gte("date", from).lte("date", today),
      leaveOn ? supabase.from("leave_requests").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending") : none,
      supabase.from("regularisations").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "pending"),
      seesTasks ? supabase.from("tasks").select("id", { count: "exact", head: true }).eq("company_id", cid).neq("status", "done").lt("due_at", now) : none,
  ]) : null;
  // each admin card is fetched only for a role that may see it
  const hrQ = seesPayroll || managesAttendance || seesAllEmployees ? Promise.all([
        !seesPayroll ? none : supabase.from("payroll_runs").select("id, month, status, total_net, employee_count").eq("company_id", cid).neq("status", "superseded")
          .order("month", { ascending: false }).order("version", { ascending: false }).limit(1).maybeSingle(),
        !managesAttendance ? none : supabase.from("devices").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("status", "offline"),
        !managesAttendance ? none : supabase.from("punches_raw").select("id", { count: "exact", head: true }).eq("company_id", cid).is("employee_id", null),
        !seesAllEmployees ? none : supabase.from("employee_documents").select("name, expiry_date, employee_id, employees(first_name, last_name)").eq("company_id", cid)
          .not("expiry_date", "is", null).lte("expiry_date", new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)).order("expiry_date").limit(5),
        // missing check-ins / check-outs this month (days with a single punch), for HR to review
        !managesAttendance ? none : supabase.from("daily_attendance").select("id", { count: "exact", head: true }).eq("company_id", cid)
          .eq("status", "missed_punch").gte("date", `${todayIST().slice(0, 7)}-01`),
  ]) : null;

  const [{ data: myDay }, { data: balances }, { data: myTasks }, { data: announcements }] = await Promise.all([
    employee ? supabase.from("daily_attendance").select("status, first_in, last_out").eq("employee_id", employee.id).eq("date", today).maybeSingle() : Promise.resolve({ data: null }),
    employee && leaveOn ? supabase.from("leave_balance_view").select("code, name, opening, accrued, used, pending, paid")
      .eq("employee_id", employee.id).eq("year", Number(today.slice(0, 4))).eq("paid", true) : Promise.resolve({ data: [] }),
    employee && seesTasks ? supabase.from("task_assignees").select("tasks(id, title, status, due_at, priority)").eq("employee_id", employee.id).limit(50)
      : Promise.resolve({ data: [] }),
    supabase.from("announcements").select("id, title, created_at").eq("company_id", cid).order("created_at", { ascending: false }).limit(3),
  ]);

  type T = { id: string; title: string; status: string; due_at: string | null; priority: string };
  const openTasks = ((myTasks ?? []) as unknown as { tasks: T | null }[]).map((r) => r.tasks).filter((t): t is T => !!t && t.status !== "done")
    .sort((a, b) => (a.due_at ?? "9").localeCompare(b.due_at ?? "9")).slice(0, 5);

  let team: React.ReactNode = null;
  if (seesAttendance) {
    const [people, att, { data: holidays }, { count: pendingLeave }, { count: pendingReg }, { count: overdue }] = (await teamQ)!;
    const days = Array.from({ length: 14 }, (_, i) => new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10));
    const perDay = days.map((d) => dayCounts(d, people, att, company.weekly_offs, holidays ?? []));
    const todayCounts = perDay[perDay.length - 1];
    const headcount = people.filter((e) => ["active", "notice"].includes(e.status) && e.date_of_joining <= today).length;
    const present = todayCounts.present;

    // 14-day trend: share present among those expected at work; days when everyone is off are skipped
    const trend = perDay.map((d) => ({ d, pct: presentShare(d) })).filter((x) => x.pct !== null).map(({ d, pct }) => ({
      day: new Date(d.date + "T00:00:00").toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
      present: d.present, total: d.employed - d.off, pct: pct!,
    }));
    const depts = Object.entries(people.filter((e) => ["active", "notice"].includes(e.status)).reduce<Record<string, number>>((m, p) => {
      const k = p.departments?.name ?? "Unassigned"; m[k] = (m[k] ?? 0) + 1; return m;
    }, {})).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count).slice(0, 8);

    let hr: React.ReactNode = null;
    if (hrQ) {
      const [{ data: run }, { count: offline }, { count: unmapped }, { data: docs }, { count: missed }] = (await hrQ)!;
      hr = (
        <div className="grid gap-4 lg:grid-cols-3">
          {seesPayroll && <Card title="Payroll" actions={<Link href={`${base}/payroll`} className="text-xs font-medium text-brand-600 hover:text-brand-700">Open →</Link>}>
            {run ? (
              <Link href={`${base}/payroll/${run.id}`} className="block">
                <div className="flex items-center justify-between text-sm"><span className="font-medium text-slate-900">{fmtMonth(run.month)}</span><Badge value={run.status} /></div>
                <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{money(run.total_net)}</div>
                <div className="text-xs text-slate-500">net payout · {run.employee_count} employees</div>
              </Link>
            ) : <p className="text-sm text-slate-500">No payroll run yet. Lock a month of attendance, then run payroll.</p>}
          </Card>}
          {managesAttendance && <Card title="Devices & punches" actions={<Link href={`${base}/attendance/devices`} className="text-xs font-medium text-brand-600 hover:text-brand-700">Manage →</Link>}>
            <ul className="space-y-2.5 text-sm">
              <li className="flex items-center gap-2">{offline ? <AlertTriangle className="h-4 w-4 text-rose-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                <span className={offline ? "text-rose-700" : "text-slate-700"}>{offline ? `${offline} device(s) offline` : "All devices online"}</span></li>
              <li className="flex items-center gap-2">{unmapped ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                <span className={unmapped ? "text-amber-800" : "text-slate-700"}>{unmapped ? `${unmapped} unmapped punch(es) waiting` : "No unmapped punches"}</span></li>
              <li className="flex items-center gap-2">{missed ? <AlertTriangle className="h-4 w-4 text-amber-500" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
                {missed
                  ? <Link href={`${base}/attendance/reports?month=${todayIST().slice(0, 7)}`} className="text-amber-800 hover:underline">{missed} missed check-in/out this month — review</Link>
                  : <span className="text-slate-700">No missed check-ins or check-outs this month</span>}</li>
            </ul>
          </Card>}
          {seesAllEmployees && <Card title="Documents expiring (30 days)">
            {docs?.length ? (
              <ul className="space-y-2 text-sm">
                {docs.map((d, i) => {
                  const e = d.employees as unknown as { first_name: string; last_name: string | null };
                  return <li key={i} className="flex items-center justify-between gap-2">
                    <Link href={`${base}/employees/${d.employee_id}?tab=documents`} className="flex min-w-0 items-center gap-2 hover:underline"><FileWarning className="h-4 w-4 shrink-0 text-amber-500" /><span className="truncate">{e?.first_name} · {d.name}</span></Link>
                    <span className="shrink-0 text-xs font-medium text-rose-600">{fmtDate(d.expiry_date)}</span></li>;
                })}
              </ul>
            ) : <p className="flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> Nothing expiring soon.</p>}
          </Card>}
        </div>
      );
    }

    const approvals = (pendingLeave ?? 0) + (pendingReg ?? 0);
    team = (
      <section className="space-y-4">
        <div className="flex items-end justify-between">
          <h2 className="text-base font-semibold text-slate-900">{perms.has("attendance.read_all") ? "Company today" : "My team today"}</h2>
          <Link href={`${base}/attendance/live`} className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700">Live attendance <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Stat label="Headcount" value={headcount} icon={Users} />
          <Stat label="Present" value={present} hint={headcount ? `${Math.round((present / headcount) * 100)}% of headcount` : undefined} tone="green" icon={UserCheck} />
          <Stat label="Late" value={todayCounts.late} tone="amber" icon={Clock} />
          <Stat label="Absent" value={todayCounts.absent} tone="red" icon={UserX} />
          <Stat label="On leave" value={todayCounts.onLeave} tone="brand" icon={Plane} />
          {perms.has("attendance.approve") && <Stat label="Approvals" value={approvals} tone={approvals ? "amber" : "slate"} icon={CalendarClock}
            hint={approvals ? <Link className="font-medium text-brand-600 hover:text-brand-700" href={`${base}/attendance/requests`}>Review now →</Link> : "All caught up"} />}
        </div>
        <div className="grid gap-4 lg:grid-cols-5">
          <Card title="Attendance, last 14 days" description="Share of employees present on working days" className="lg:col-span-3">
            {trend.length ? <AttendanceTrend data={trend} /> : <p className="py-16 text-center text-sm text-slate-500">No attendance recorded yet.</p>}
          </Card>
          <Card title="Headcount by department" className="lg:col-span-2">
            {depts.length ? <HeadcountBars data={depts} /> : <p className="py-16 text-center text-sm text-slate-500">No employees yet.</p>}
          </Card>
        </div>
        {(overdue ?? 0) > 0 && (
          <Link href={`${base}/tasks?filter=overdue`} className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 hover:bg-rose-100">
            <AlertTriangle className="h-4 w-4" /> {overdue} overdue task(s) need attention <ArrowRight className="ml-auto h-4 w-4" />
          </Link>
        )}
        {hr}
      </section>
    );
  }

  const bal = (b: { opening: number; accrued: number; used: number; pending: number }) => Number(b.opening) + Number(b.accrued) - Number(b.used) - Number(b.pending);

  return (
    <>
      <PageHeader
        eyebrow={new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        title={employee ? `${greet}, ${employee.first_name}` : company.name}
        actions={<>
          {perms.has("employees.create") && <Link href={`${base}/employees/new`} className="btn-secondary">Add employee</Link>}
          {perms.has("salaries.manage") && <RunPayrollButton cid={cid} />}
          {!perms.has("employees.create") && !perms.has("salaries.manage") && leaveOn && <Link href={`${base}/leave`} className="btn-primary">Apply for leave</Link>}
        </>}
      />
      <div className="space-y-8">
        {employee && (
          <section className="grid gap-4 lg:grid-cols-3">
            <Card title="Today" actions={<Link href={`${base}/attendance/me`} className="text-xs font-medium text-brand-600 hover:text-brand-700">My attendance →</Link>}>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600"><Fingerprint className="h-5 w-5" /></span>
                {myDay ? <Badge value={myDay.status} /> : <span className="text-sm text-slate-500">No punch yet today.</span>}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-2 text-center">
                <div className="flex flex-col-reverse rounded-xl bg-slate-50 px-2 py-2.5"><dt className="text-xs text-slate-500">In</dt><dd className="text-lg font-semibold tabular-nums text-slate-900">{fmtTime(myDay?.first_in)}</dd></div>
                <div className="flex flex-col-reverse rounded-xl bg-slate-50 px-2 py-2.5"><dt className="text-xs text-slate-500">Out</dt><dd className="text-lg font-semibold tabular-nums text-slate-900">{fmtTime(myDay?.last_out)}</dd></div>
              </dl>
              {employee.mobile_attendance && <Link href={`${base}/attendance/me`} className="btn-primary mt-4 h-11 w-full">Punch with selfie</Link>}
            </Card>
            {leaveOn && <Card title="Leave balance" actions={<Link href={`${base}/leave`} className="text-xs font-medium text-brand-600 hover:text-brand-700">Apply →</Link>}>
              {balances?.length ? (
                <div className="grid grid-cols-3 gap-2">
                  {balances.map((b) => (
                    <div key={b.code} className="rounded-lg bg-slate-50 p-2.5 text-center">
                      <div className="text-xl font-semibold tabular-nums text-slate-900">{bal(b)}</div>
                      <div className="truncate text-xs text-slate-500" title={b.name}>{b.code}</div>
                    </div>
                  ))}
                </div>
              ) : <p className="text-sm text-slate-500">No leave types set up.</p>}
            </Card>}
            {seesTasks && <Card title="My tasks" className="lg:col-span-2" pad={false} actions={<Link href={`${base}/tasks?mine=1`} className="text-xs font-medium text-brand-600 hover:text-brand-700">All tasks →</Link>}>
              {openTasks.length ? (
                <ul className="divide-y divide-slate-100">
                  {openTasks.map((t) => (
                    <li key={t.id}>
                      <Link href={`${base}/tasks/${t.id}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm hover:bg-slate-50">
                        <span className="truncate font-medium text-slate-800">{t.title}</span>
                        <span className="flex shrink-0 items-center gap-2"><Badge value={t.priority} />
                          <span className={`w-20 text-right text-xs ${t.due_at && t.due_at < now ? "font-medium text-rose-600" : "text-slate-500"}`}>{t.due_at ? fmtDate(t.due_at) : "No due date"}</span></span>
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : <div className="p-4"><p className="flex items-center gap-2 text-sm text-slate-500"><CheckCircle2 className="h-4 w-4 text-emerald-500" /> You&apos;re all caught up.</p></div>}
            </Card>}
            <Card title="Announcements" actions={<Link href={`${base}/announcements`} className="text-xs font-medium text-brand-600 hover:text-brand-700">All →</Link>}>
              {announcements?.length ? (
                <ul className="space-y-3 text-sm">{announcements.map((a) => <li key={a.id}><Link href={`${base}/announcements`} className="font-medium text-slate-800 hover:underline">{a.title}</Link><div className="text-xs text-slate-500">{fmtDate(a.created_at)}</div></li>)}</ul>
              ) : <p className="text-sm text-slate-500">No announcements.</p>}
            </Card>
          </section>
        )}
        {!employee && !team && <Empty title={`Welcome to ${company.name}`} icon={Users}>Your account isn&apos;t linked to an employee record yet. Ask your HR Manager or administrator to link it; your attendance, tasks and payslips will then appear here.</Empty>}
        {team}
      </div>
    </>
  );
}
