import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { ASSIGNABLE_ROLES, ROLE_LABEL } from "@/lib/rbac";
import { approveJoin, rejectJoin } from "../actions";

export const metadata = { title: "Sign-up approvals" };

type Req = { id: string; full_name: string; email: string; phone: string | null; note: string | null; status: string; role: string | null;
  created_at: string; decided_at: string | null; decision_note: string | null;
  designations: { name: string; access_role: string | null } | null; departments: { name: string } | null };

// New candidates who signed up for this company. They can't sign in until approved here (once).
// The access role starts from the designation's mapping (Settings → Departments & designations).
export default async function Approvals({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "employees.account");
  const { data } = await ctx.supabase.from("join_requests")
    .select("id, full_name, email, phone, note, status, role, created_at, decided_at, decision_note, designations(name, access_role), departments(name)")
    .eq("company_id", cid).order("created_at", { ascending: false }).limit(200);
  const rows = (data ?? []) as unknown as Req[];
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending").slice(0, 50);

  return (
    <>
      <PageHeader title="Sign-up approvals" subtitle={`${pending.length} waiting · candidates can't sign in until you approve them`}
        actions={<Link href={`/c/${cid}/employees`} className="btn-ghost">← Employees</Link>} />
      <Card pad={false} title="Waiting for approval" className="mb-6">
        <Table head={["Candidate", "Designation · department", "Signed up", "Access role", ""]} empty="No one is waiting.">
          {pending.map((r) => (
            <tr key={r.id} className="align-top">
              <td className="td"><div className="font-medium text-slate-900">{r.full_name}</div>
                <div className="text-xs text-slate-500">{r.email}{r.phone ? ` · ${r.phone}` : ""}</div>
                {r.note && <div className="mt-1 text-xs text-slate-600">“{r.note}”</div>}</td>
              <td className="td text-sm">{r.designations?.name ?? "—"}<div className="text-xs text-slate-500">{r.departments?.name ?? ""}</div></td>
              <td className="td text-xs text-slate-500">{fmtDateTime(r.created_at)}</td>
              <td className="td" colSpan={2}>
                <ActionForm action={approveJoin.bind(null, cid, r.id)} className="flex flex-wrap items-center gap-2 [&>p]:basis-full"
                  confirm={`Approve ${r.full_name}? They can sign in straight away.`}>
                  <select name="role" defaultValue={r.designations?.access_role ?? "employee"} className="input h-8 w-44 text-sm">
                    {ASSIGNABLE_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x]}</option>)}
                  </select>
                  <SubmitButton className="btn-primary btn-sm">Approve</SubmitButton>
                </ActionForm>
                <ActionForm action={rejectJoin.bind(null, cid, r.id)} className="mt-2 flex flex-wrap items-center gap-2 [&>p]:basis-full"
                  confirm={`Reject ${r.full_name}'s request?`}>
                  <input name="note" placeholder="Reason (shown to them)" className="input h-8 w-44 text-xs" />
                  <SubmitButton className="btn-ghost btn-sm text-rose-600">Reject</SubmitButton>
                </ActionForm>
              </td>
            </tr>
          ))}
        </Table>
      </Card>
      <Card pad={false} title="Recently decided">
        <Table head={["Candidate", "Designation", "Decision", "When"]} empty="Nothing decided yet.">
          {decided.map((r) => (
            <tr key={r.id}>
              <td className="td"><div className="font-medium">{r.full_name}</div><div className="text-xs text-slate-500">{r.email}</div></td>
              <td className="td text-sm">{r.designations?.name ?? "—"}</td>
              <td className="td"><Badge value={r.status === "approved" ? "approved" : "rejected"} text={r.status === "approved" ? `Approved · ${ROLE_LABEL[r.role as keyof typeof ROLE_LABEL] ?? r.role}` : "Rejected"} />
                {r.decision_note && <div className="text-xs text-slate-500">{r.decision_note}</div>}</td>
              <td className="td text-xs text-slate-500">{r.decided_at ? fmtDateTime(r.decided_at) : ""}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
