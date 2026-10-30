import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, PageHeader, Stat, Table } from "@/components/ui";
import { fmtDate, fmtTime, label, minutesToHm, todayIST } from "@/lib/format";
import { fullName } from "@/lib/employees";
import { cancelRegularisation, requestRegularisation } from "../actions";

export const metadata = { title: "My attendance" };

export default async function MyAttendance({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ month?: string; employee?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const { supabase, employee, perms } = await getCtx(cid);
  const month = sp.month ?? todayIST().slice(0, 7);
  const viewingOther = sp.employee && (perms.has("attendance.read_all") || perms.has("attendance.read_team")) && sp.employee !== employee?.id;
  const empId = viewingOther ? sp.employee! : employee?.id;
  if (!empId) return <PageHeader title="My attendance" subtitle="You don't have an employee record in this company." />;

  const from = `${month}-01`;
  const to = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 0).toISOString().slice(0, 10);
  const [{ data: days }, { data: regs }, { data: who }] = await Promise.all([
    supabase.from("daily_attendance").select("*").eq("employee_id", empId).gte("date", from).lte("date", to).order("date", { ascending: false }),
    supabase.from("regularisations").select("*").eq("employee_id", empId).order("created_at", { ascending: false }).limit(10),
    supabase.from("employees").select("first_name, last_name").eq("id", empId).maybeSingle(),
  ]);
  const c = (s: string[]) => (days ?? []).filter((d) => s.includes(d.status)).length;

  return (
    <>
      <PageHeader title={viewingOther ? `Attendance · ${fullName(who)}` : "My attendance"}
        actions={<form className="flex gap-2">{viewingOther && <input type="hidden" name="employee" value={empId} />}<input type="month" name="month" defaultValue={month} className="input w-44" /><button className="btn-secondary">Show</button></form>} />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Stat label="Present" value={c(["present", "late", "early_out", "on_duty", "wfh"])} tone="green" />
            <Stat label="Half days" value={c(["half_day"])} tone="amber" />
            <Stat label="Late marks" value={(days ?? []).filter((d) => d.late).length} tone="amber" />
            <Stat label="Absent / missed" value={c(["absent", "missed_punch"])} tone="red" />
          </div>
          <Card pad={false} title="Daily log">
            <Table head={["Date", "Status", "In", "Out", "Worked", "OT"]}>
              {(days ?? []).map((d) => (
                <tr key={d.id}><td className="td whitespace-nowrap">{fmtDate(d.date)}</td><td className="td"><Badge value={d.status} /></td>
                  <td className="td">{fmtTime(d.first_in)}</td><td className="td">{fmtTime(d.last_out)}</td>
                  <td className="td">{minutesToHm(d.worked_minutes)}</td><td className="td">{d.ot_minutes ? `${minutesToHm(d.ot_minutes)} (${minutesToHm(d.ot_approved_minutes)} approved)` : "—"}</td></tr>
              ))}
            </Table>
          </Card>
        </div>
        {!viewingOther && (
          <div className="space-y-6">
            <Card title="Request a correction">
              <ActionForm action={requestRegularisation.bind(null, cid)} className="space-y-3" resetOnSuccess>
                <Field label="Date"><input className="input" type="date" name="date" max={todayIST()} required /></Field>
                <Field label="Type"><select className="input" name="kind">
                  <option value="missed_punch">Missed punch</option><option value="on_duty">On duty (outside office)</option></select></Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="In time"><input className="input" type="time" name="in_time" /></Field>
                  <Field label="Out time"><input className="input" type="time" name="out_time" /></Field>
                </div>
                <Field label="Reason"><textarea className="input" name="reason" rows={2} required /></Field>
                <SubmitButton className="btn-primary w-full">Send to manager</SubmitButton>
              </ActionForm>
            </Card>
            <Card title="My requests" pad={false}>
              <ul className="divide-y divide-slate-100">
                {(regs ?? []).map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 px-4 py-2 text-sm">
                    <span>{fmtDate(r.date)} · {label(r.kind)}</span>
                    <span className="flex items-center gap-2"><Badge value={r.status} />
                      {r.status === "pending" && <form action={cancelRegularisation.bind(null, cid, r.id)}><button className="text-xs text-slate-500 hover:underline">Cancel</button></form>}</span>
                  </li>
                ))}
                {!regs?.length && <li className="px-4 py-6 text-center text-sm text-slate-500">No requests.</li>}
              </ul>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
