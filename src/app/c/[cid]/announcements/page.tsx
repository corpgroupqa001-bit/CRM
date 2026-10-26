import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Field, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { attempt, must, str, type ActionState } from "@/lib/actions";

export const metadata = { title: "Announcements" };

// COMMS-08 company-wide announcements with acknowledgement tracking
export default async function Announcements({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const { supabase, perms, user } = await getCtx(cid);
  const hr = perms.has("announcements.post");
  const [{ data: items }, { data: acks }, { count: members }] = await Promise.all([
    supabase.from("announcements").select("*").eq("company_id", cid).order("created_at", { ascending: false }).limit(50),
    supabase.from("announcement_acks").select("announcement_id, user_id, acked_at").eq("company_id", cid),
    supabase.from("company_members").select("id", { count: "exact", head: true }).eq("company_id", cid).eq("active", true),
  ]);
  const { data: dir } = hr ? await supabase.from("employee_directory").select("user_id, full_name").eq("company_id", cid).not("user_id", "is", null) : { data: [] };

  async function post(_: ActionState, fd: FormData): Promise<ActionState> {
    "use server";
    return attempt(async () => {
      const { supabase } = await getCtx(cid);
      must(await supabase.from("announcements").insert({ company_id: cid, title: str(fd, "title"), body: str(fd, "body") }));
      revalidatePath(`/c/${cid}/announcements`);
      return "Announcement posted and everyone notified.";
    });
  }
  async function ack(id: string) {
    "use server";
    const { supabase } = await getCtx(cid);
    await supabase.from("announcement_acks").insert({ announcement_id: id, company_id: cid });
    revalidatePath(`/c/${cid}/announcements`);
  }

  return (
    <>
      <PageHeader title="Announcements" />
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {(items ?? []).map((a) => {
            const got = (acks ?? []).filter((k) => k.announcement_id === a.id);
            const mine = got.some((k) => k.user_id === user.id);
            const pending = hr ? (dir ?? []).filter((d) => !got.some((k) => k.user_id === d.user_id)) : [];
            return (
              <Card key={a.id} title={a.title} actions={<span className="text-xs text-slate-500">{fmtDateTime(a.created_at)}</span>}>
                <p className="whitespace-pre-wrap text-sm text-slate-700">{a.body}</p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                  {mine ? <span className="text-sm text-emerald-700">✓ You acknowledged this</span>
                    : <form action={ack.bind(null, a.id)}><button className="btn-primary btn-sm">Acknowledge</button></form>}
                  {hr && <details className="text-xs text-slate-500"><summary className="cursor-pointer">{got.length} of {members ?? 0} acknowledged</summary>
                    <div className="mt-1 max-w-md">Pending: {pending.map((p) => p.full_name).join(", ") || "none"}</div></details>}
                </div>
              </Card>
            );
          })}
          {!items?.length && <p className="text-sm text-slate-500">No announcements yet.</p>}
        </div>
        {hr && (
          <Card title="Post an announcement">
            <ActionForm action={post} className="space-y-3" resetOnSuccess>
              <Field label="Title"><input className="input" name="title" required /></Field>
              <Field label="Message"><textarea className="input" name="body" rows={6} required /></Field>
              <SubmitButton className="btn-primary w-full">Post to everyone</SubmitButton>
            </ActionForm>
          </Card>
        )}
      </div>
    </>
  );
}
