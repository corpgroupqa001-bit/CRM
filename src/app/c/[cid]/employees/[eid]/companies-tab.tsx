import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, Field, Table } from "@/components/ui";
import { DepartmentDesignation } from "@/components/department-designation";
import { createAdminClient } from "@/lib/supabase/admin";
import { ASSIGNABLE_ROLES, ROLE_LABEL, type Role } from "@/lib/rbac";
import { fmtDate, fmtDateTime, label } from "@/lib/format";
import type { Ctx } from "@/lib/context";
import { assignCompany, setAssignmentActive, updateAssignment } from "../assignment-actions";

type Assignment = {
  company_id: string; company_name: string; company_status: string; employee_id: string | null; emp_code: string | null;
  department_id: string | null; department: string | null; designation_id: string | null; designation: string | null;
  reporting_manager_id: string | null; reporting_manager: string | null; employment_status: string | null; date_of_joining: string | null;
  role: string | null; member_active: boolean | null; is_active: boolean;
};

/**
 * Companies assigned (Super Admin only): one person, one login, a separate assignment per company with
 * its own department, designation, reporting manager, role and status. Shown on the employee page.
 */
export async function CompaniesTab({ ctx, eid, userId, self }: { ctx: Ctx; eid: string; userId: string | null; self: boolean }) {
  const { supabase, companyId: cid } = ctx;
  if (!userId) {
    return <Card title="Companies assigned"><p className="text-sm text-slate-600">This employee has no login yet. Create their login (Lifecycle → Login password) or send an invite first; one login is then used for every company they&apos;re assigned to.</p></Card>;
  }
  if (self) {
    return <Card title="Companies assigned"><p className="text-sm text-slate-600">You can&apos;t change your own company access.</p></Card>;
  }
  const [{ data: rows, error }, { data: history }] = await Promise.all([
    supabase.rpc("sa_person_assignments", { p_user: userId }),
    supabase.rpc("sa_assignment_history", { p_user: userId }),
  ]);
  if (error) return <Card title="Companies assigned"><p className="text-sm text-rose-600">{error.message}</p></Card>;
  const list = (rows ?? []) as Assignment[];

  // pick lists for every company (names and ids only); the Super Admin was verified by the rpc above
  const ids = list.map((r) => r.company_id);
  const admin = createAdminClient();
  const [{ data: deps }, { data: desigs }, { data: people }] = await Promise.all([
    admin.from("departments").select("id, name, company_id").in("company_id", ids).eq("active", true).order("name"),
    admin.from("designations").select("id, name, company_id, department_id").in("company_id", ids).eq("active", true).not("department_id", "is", null).order("name"),
    admin.from("employees").select("id, first_name, last_name, company_id, user_id").in("company_id", ids).in("status", ["active", "notice"]).is("removed_at", null).order("first_name"),
  ]);
  const forCompany = <T extends { company_id: string }>(xs: T[] | null, id: string) => (xs ?? []).filter((x) => x.company_id === id);
  const activeCount = list.filter((r) => r.is_active).length;

  const detailsForm = (r: Assignment) => (
    <>
      {r.role === "owner"
        ? <Field label="Access role"><input className="input" value="Owner" disabled /><input type="hidden" name="role" value="owner" /></Field>
        : <Field label="Access role"><select className="input" name="role" required defaultValue={r.role && r.role !== "owner" ? r.role : "employee"}>
            {ASSIGNABLE_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABEL[x as Role]}</option>)}</select></Field>}
      <DepartmentDesignation required={false} names={{ department: "department_id", designation: "designation_id" }}
        departments={forCompany(deps, r.company_id)} designations={forCompany(desigs, r.company_id)}
        initial={{ department: r.department_id, designation: r.designation_id }} />
      <Field label="Reporting manager"><select className="input" name="reporting_manager_id" defaultValue={r.reporting_manager_id ?? ""}>
        <option value="">—</option>
        {forCompany(people, r.company_id).filter((p) => p.user_id !== userId).map((p) => <option key={p.id} value={p.id}>{[p.first_name, p.last_name].filter(Boolean).join(" ")}</option>)}
      </select></Field>
      <Field label="Joining date"><input className="input" type="date" name="date_of_joining" defaultValue={r.date_of_joining ?? new Date().toISOString().slice(0, 10)} /></Field>
    </>
  );

  return (
    <div className="space-y-6">
      <Card title="Companies assigned" pad={false}
        description={`Active in ${activeCount} of ${list.length} companies. One login and password for all of them; each company has its own department, designation, manager and role. Salary, payroll and documents are never copied between companies.`}>
        <Table head={["Company", "Status", "Role", "Department", "Designation", "Manager", "Joined"]}>
          {list.map((r) => (
            <tr key={r.company_id} className={r.company_id === cid ? "bg-brand-50/40" : ""}>
              <td className="td font-medium">{r.company_name}{r.company_id === cid && <span className="ml-1 text-xs font-normal text-slate-500">(this company)</span>}</td>
              <td className="td">{!r.employee_id ? <Badge value="cancelled" text="Not assigned" /> : r.is_active ? <Badge value="active" text="Active" /> : <Badge value="inactive" text={label(r.employment_status ?? "inactive")} />}</td>
              <td className="td">{r.role ? ROLE_LABEL[r.role as Role] ?? r.role : "—"}</td>
              <td className="td">{r.department ?? "—"}</td>
              <td className="td">{r.designation ?? "—"}</td>
              <td className="td">{r.reporting_manager || "—"}</td>
              <td className="td">{r.date_of_joining ? fmtDate(r.date_of_joining) : "—"}</td>
            </tr>
          ))}
        </Table>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {list.map((r) => {
          const assigned = !!r.employee_id;
          return (
            <details key={r.company_id} className="card group p-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-5 py-4">
                <span className="font-medium text-slate-900">{r.company_name}</span>
                <span className="text-xs font-medium text-brand-600">{!assigned ? "Assign" : r.is_active ? "Edit" : "Inactive · manage"}</span>
              </summary>
              <div className="space-y-4 border-t border-slate-100 px-5 py-4">
                {!assigned || !r.is_active ? (
                  <ActionForm action={assignCompany.bind(null, cid, eid, userId, r.company_id)} className="grid gap-3 sm:grid-cols-2 [&>p]:sm:col-span-2"
                    confirm={assigned ? `Reactivate access to ${r.company_name}?` : `Give this person access to ${r.company_name}?`}>
                    {detailsForm(r)}
                    <div className="sm:col-span-2"><SubmitButton className="btn-primary">{assigned ? "Reactivate with these details" : `Assign to ${r.company_name}`}</SubmitButton></div>
                  </ActionForm>
                ) : (
                  <>
                    <ActionForm action={updateAssignment.bind(null, cid, eid, userId, r.company_id)} className="grid gap-3 sm:grid-cols-2 [&>p]:sm:col-span-2">
                      {detailsForm(r)}
                      <div className="sm:col-span-2"><SubmitButton className="btn-secondary">Save for {r.company_name}</SubmitButton></div>
                    </ActionForm>
                    {r.role !== "owner" && (
                      <ActionForm action={setAssignmentActive.bind(null, cid, eid, userId, r.company_id, false)} className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4 [&>p]:basis-full"
                        confirm={`Switch off their access to ${r.company_name}? Their other companies are not affected.`}>
                        <input className="input flex-1" name="reason" placeholder="Reason (optional)" />
                        <SubmitButton className="btn-danger">Deactivate in {r.company_name}</SubmitButton>
                      </ActionForm>
                    )}
                  </>
                )}
              </div>
            </details>
          );
        })}
      </div>

      <Card title="Assignment history" pad={false}>
        <Table head={["When", "Company", "Change", "By", "Details"]} empty="No assignment changes yet.">
          {((history ?? []) as { at: string; company_name: string | null; action: string; by_email: string | null; details: Record<string, unknown> }[]).map((h, i) => (
            <tr key={i}>
              <td className="td whitespace-nowrap">{fmtDateTime(h.at)}</td>
              <td className="td">{h.company_name ?? "—"}</td>
              <td className="td"><Badge value={h.action === "deactivate" ? "inactive" : h.action === "reactivate" || h.action === "assign" ? "active" : "draft"} text={label(h.action)} /></td>
              <td className="td text-slate-500">{h.by_email ?? "—"}</td>
              <td className="td text-xs text-slate-500">{[h.details.role && ROLE_LABEL[h.details.role as Role], h.details.reason].filter(Boolean).join(" · ")}</td>
            </tr>
          ))}
        </Table>
      </Card>
    </div>
  );
}
