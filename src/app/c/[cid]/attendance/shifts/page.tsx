import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader, Table } from "@/components/ui";
import { AttendanceTabs } from "../tabs";
import { saveShift } from "../actions";

export const metadata = { title: "Shifts" };

// ATT-08 shift master, including night shifts that cross midnight
export default async function Shifts({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.manage");
  const { data: shifts } = await ctx.supabase.from("shifts").select("*").eq("company_id", cid).order("start_time");
  const form = (s?: Record<string, string | number | boolean>) => (
    <ActionForm action={saveShift.bind(null, cid)} className="grid gap-3 sm:grid-cols-4" resetOnSuccess={!s}>
      {s && <input type="hidden" name="id" value={String(s.id)} />}
      <Field label="Name" className="sm:col-span-2"><input className="input" name="name" defaultValue={String(s?.name ?? "")} required /></Field>
      <Field label="Start"><input className="input" type="time" name="start_time" defaultValue={String(s?.start_time ?? "09:00").slice(0, 5)} required /></Field>
      <Field label="End" hint="Earlier than start = night shift"><input className="input" type="time" name="end_time" defaultValue={String(s?.end_time ?? "18:00").slice(0, 5)} required /></Field>
      <Field label="Grace (min)"><input className="input" type="number" name="grace_min" min={0} defaultValue={Number(s?.grace_min ?? 10)} /></Field>
      <Field label="Break (min)"><input className="input" type="number" name="break_min" min={0} defaultValue={Number(s?.break_min ?? 60)} /></Field>
      <Field label="Half-day hours"><input className="input" type="number" step="0.5" name="half_day_hours" defaultValue={Number(s?.half_day_hours ?? 4)} /></Field>
      <Field label="Full-day hours"><input className="input" type="number" step="0.5" name="full_day_hours" defaultValue={Number(s?.full_day_hours ?? 8)} /></Field>
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="is_default" defaultChecked={!!s?.is_default} /> Company default shift</label>
      <div className="sm:col-span-2 sm:text-right"><SubmitButton className={s ? "btn-secondary" : "btn-primary"}>{s ? "Save" : "Add shift"}</SubmitButton></div>
    </ActionForm>
  );
  return (
    <>
      <PageHeader title="Shifts" />
      <AttendanceTabs cid={cid} active="shifts" perms={ctx.perms} />
      <div className="space-y-6">
        <Card title="Shifts" pad={false}>
          <Table head={["Name", "Timing", "Grace", "Break", "Half / full day", ""]}>
            {(shifts ?? []).map((s) => (
              <tr key={s.id}><td className="td font-medium">{s.name}{s.is_default && <span className="ml-2 text-xs text-brand-600">default</span>}</td>
                <td className="td">{s.start_time.slice(0, 5)} – {s.end_time.slice(0, 5)}{s.end_time < s.start_time && <span className="ml-1 text-xs text-violet-600">night</span>}</td>
                <td className="td">{s.grace_min} min</td><td className="td">{s.break_min} min</td><td className="td">{s.half_day_hours} h / {s.full_day_hours} h</td>
                <td className="td"><details><summary className="cursor-pointer text-sm text-brand-600">Edit</summary><div className="mt-3 w-[36rem] max-w-[80vw]">{form(s)}</div></details></td></tr>
            ))}
          </Table>
        </Card>
        <Card title="Add shift">{form()}</Card>
      </div>
    </>
  );
}
