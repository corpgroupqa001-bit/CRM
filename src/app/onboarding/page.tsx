import Link from "next/link";
import { redirect } from "next/navigation";
import { Building2, Clock, XCircle } from "lucide-react";
import { requireUser } from "@/lib/context";
import { createClient } from "@/lib/supabase/server";
import { joinOptions, latestJoinRequest } from "@/lib/join";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { CompanyPicker, JoinFields } from "@/components/join-fields";
import { logout, requestToJoin } from "@/app/(auth)/actions";

export const metadata = { title: "No company yet" };

// A signed-in account with no company: it asks to join one (company + designation), then waits for
// an administrator of that company to approve it. Companies themselves are created only by the
// platform Super Admin, so an account never becomes an owner by itself.
export default async function NoCompany({ searchParams }: { searchParams: Promise<{ company?: string; again?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const supabase = await createClient();
  const [{ data: sa }, { data: members }, { data: profile }] = await Promise.all([
    supabase.rpc("is_super_admin"),
    supabase.from("company_members").select("company_id").eq("user_id", user.id).eq("active", true).limit(1),
    supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle(),
  ]);
  if (sa) redirect("/admin");
  if (members?.length) redirect("/");
  const request = await latestJoinRequest(user.id);
  const asking = !request || (request.status === "rejected" && sp.again);
  const options = asking ? await joinOptions(sp.company) : null;

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-brand-50 to-white px-4 py-10">
      <div className="card w-full max-w-md p-8">
        {request?.status === "pending" ? (
          <Status icon={<Clock className="h-6 w-6" />} title="Waiting for approval"
            text={<>Your request to join <b>{request.company}</b> was sent. An administrator checks your details and approves you; you&apos;ll get access straight after.</>} />
        ) : request?.status === "rejected" && !sp.again ? (
          <Status icon={<XCircle className="h-6 w-6" />} title="Request not approved"
            text={<>Your request to join <b>{request.company}</b> wasn&apos;t approved{request.decision_note ? `: ${request.decision_note}` : "."}{" "}
              <Link href="/onboarding?again=1" className="font-medium text-brand-600 hover:underline">Send a new request</Link></>} />
        ) : (
          <>
            <Status icon={<Building2 className="h-6 w-6" />} title="Ask to join your company"
              text={<>Signed in as <b>{user.email}</b>. Choose your company and designation; an administrator approves you before you get access.</>} />
            {options && (!options.company ? <CompanyPicker options={options} path="/onboarding" /> : (
              <ActionForm action={requestToJoin} className="mt-6 space-y-4">
                <JoinFields options={options} path="/onboarding" />
                <Field label="Full name"><input className="input" name="name" required defaultValue={profile?.full_name ?? ""} /></Field>
                <SubmitButton className="btn-primary w-full">Send request</SubmitButton>
              </ActionForm>
            ))}
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
      <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-50 text-brand-600">{icon}</span>
      <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-600">{text}</p>
    </div>
  );
}
