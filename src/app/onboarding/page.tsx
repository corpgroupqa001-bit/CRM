import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Clock } from "lucide-react";
import { requireUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { latestJoinRequest } from "@/lib/join";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { createCompany, logout } from "@/app/(auth)/actions";

export const metadata = { title: "Set up your company" };

// A signed-in account with no company (BRD v2.0 AUTH-01, COM-01): an owner creates their company here.
// Employees don't sign up themselves: HR adds them and sends an invitation (AUTH-04). A join request
// made before invitations replaced self-registration is still shown while it waits.
export default async function NoCompany() {
  const user = await requireUser();
  const supabase = await createClient();
  const [{ data: sa }, { data: members }] = await Promise.all([
    supabase.rpc("is_super_admin"),
    supabase.from("company_members").select("company_id").eq("user_id", user.id).eq("active", true).limit(1),
  ]);
  if (sa) redirect("/admin");
  if (members?.length) redirect("/");
  const request = await latestJoinRequest(user.id);

  return (
    <div className="flex min-h-screen items-center justify-center bg-canvas px-4 py-10">
      <div className="card w-full max-w-md p-8">
        {request?.status === "pending" ? (
          <Status icon={<Clock className="h-6 w-6" />} title="Waiting for approval"
            text={<>Your request to join <b>{request.company}</b> is waiting for the company&apos;s Owner. You get access as soon as it&apos;s approved.</>} />
        ) : (
          <>
            <Status icon={<Building2 className="h-6 w-6" />} title="Set up your company"
              text={<>Signed in as <b>{user.email}</b>. Create your company to start; you&apos;ll be its Owner and can add more companies later.</>} />
            <ActionForm action={createCompany} className="mt-6 space-y-4">
              <Field label="Company name"><input className="input" name="company_name" required maxLength={120} placeholder="Acme Industries Pvt Ltd" /></Field>
              <SubmitButton className="btn-primary w-full" pendingText="Creating…">Create company</SubmitButton>
            </ActionForm>
            <p className="mt-4 text-center text-xs text-slate-500">Joining as an employee? Your HR team adds you and emails an invitation; use that link to activate your account.</p>
          </>
        )}
        <div className="mt-6 flex justify-center gap-2">
          <Link href="/" className="btn-secondary">Check again</Link>
          <form action={logout}><button className="btn-ghost">Sign out</button></form>
        </div>
      </div>
    </div>
  );
}

function Status({ icon, title, text }: { icon: React.ReactNode; title: string; text: React.ReactNode }) {
  return (
    <div className="text-center">
      <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-600">{icon}</span>
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
    </div>
  );
}
