import Link from "next/link";
import { revalidatePath } from "next/cache";
import { Bell, CheckCheck } from "lucide-react";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Card, Empty, Field, PageHeader, Tabs } from "@/components/ui";
import { PushToggle } from "@/components/push-toggle";
import { fmtDateTime } from "@/lib/format";
import { attempt, must, str, type ActionState } from "@/lib/actions";
import { notificationHref } from "@/lib/notification-link";

export const metadata = { title: "Notifications" };

const KINDS: [string, string, string][] = [
  ["leave", "Leave", "Requests, approvals and rejections"],
  ["attendance", "Attendance", "Corrections, device alerts"],
  ["tasks", "Tasks", "Assignments, mentions, due dates, status changes"],
  ["announcements", "Announcements", "Company-wide announcements"],
  ["payroll", "Payroll", "Payslips and payroll updates"],
  ["chat", "Chat messages", "New messages in chats you haven't muted (push only)"],
  ["general", "Other", "Everything else"],
];

// X-01 notification centre and per-event-type preferences; COMMS-07 push and do-not-disturb
export default async function Notifications({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ tab?: string }> }) {
  const { cid } = await params;
  const { tab = "inbox" } = await searchParams;
  const { supabase, user } = await getCtx(cid);

  async function markAll() {
    "use server";
    const { supabase, user } = await getCtx(cid);
    await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("user_id", user.id).is("read_at", null).neq("kind", "chat");
    revalidatePath(`/c/${cid}`, "layout");
  }
  async function savePrefs(_: ActionState, fd: FormData): Promise<ActionState> {
    "use server";
    return attempt(async () => {
      const { supabase, user } = await getCtx(cid);
      must(await supabase.from("notification_prefs").upsert(KINDS.map(([k]) => ({
        user_id: user.id, kind: k, in_app: fd.get(`${k}_in_app`) === "on", push: fd.get(`${k}_push`) === "on", email: fd.get(`${k}_email`) === "on",
      })), { onConflict: "user_id,kind" }));
      must(await supabase.from("profiles").update({ dnd_start: str(fd, "dnd_start"), dnd_end: str(fd, "dnd_end") }).eq("id", user.id));
      return "Preferences saved.";
    });
  }

  const tabs = [{ key: "inbox", label: "Inbox", href: "?tab=inbox" }, { key: "preferences", label: "Preferences", href: "?tab=preferences" }];
  let body: React.ReactNode;
  if (tab === "preferences") {
    const [{ data: prefs }, { data: profile }] = await Promise.all([
      supabase.from("notification_prefs").select("*").eq("user_id", user.id),
      supabase.from("profiles").select("dnd_start, dnd_end").eq("id", user.id).maybeSingle(),
    ]);
    const p = (k: string) => prefs?.find((x) => x.kind === k) ?? { in_app: true, push: true, email: false };
    body = (
      <div className="space-y-6">
        <Card title="Push notifications" description="Alerts on this phone or computer, even when the app is closed.">
          <PushToggle />
        </Card>
        <Card title="What to notify me about" pad={false}>
          <ActionForm action={savePrefs} className="space-y-0">
            <table className="min-w-full">
              <thead className="border-b border-slate-100 bg-slate-50/70"><tr><th className="th">Event</th><th className="th text-center">In app</th><th className="th text-center">Push</th><th className="th text-center">Email</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {KINDS.map(([k, l, d]) => (
                  <tr key={k}>
                    <td className="td"><div className="font-medium text-slate-900">{l}</div><div className="text-xs text-slate-500">{d}</div></td>
                    <td className="td text-center"><input type="checkbox" name={`${k}_in_app`} defaultChecked={p(k).in_app} aria-label={`${l} in app`} /></td>
                    <td className="td text-center"><input type="checkbox" name={`${k}_push`} defaultChecked={p(k).push} aria-label={`${l} push`} /></td>
                    <td className="td text-center"><input type="checkbox" name={`${k}_email`} defaultChecked={p(k).email} aria-label={`${l} email`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 p-4">
              <Field label="Do not disturb from"><input className="input w-36" type="time" name="dnd_start" defaultValue={profile?.dnd_start?.slice(0, 5) ?? ""} /></Field>
              <Field label="until"><input className="input w-36" type="time" name="dnd_end" defaultValue={profile?.dnd_end?.slice(0, 5) ?? ""} /></Field>
              <p className="pb-2 text-xs text-slate-500">No push alerts in these hours (India time). Chats can also be muted one by one.</p>
              <div className="ml-auto"><SubmitButton>Save preferences</SubmitButton></div>
            </div>
          </ActionForm>
        </Card>
        <p className="text-xs text-slate-500">Email notifications are sent once a mail server is configured (SMTP in <code>.env.local</code>). SMS and WhatsApp need a messaging provider and are not connected yet.</p>
      </div>
    );
  } else {
    const { data } = await supabase.from("notifications").select("*").eq("user_id", user.id).neq("kind", "chat").order("created_at", { ascending: false }).limit(100);
    body = data?.length ? (
      <Card pad={false}>
        <ul className="divide-y divide-slate-100">
          {data.map((n) => (
            <li key={n.id} className={`flex items-start gap-3 px-4 py-3 ${n.read_at ? "" : "bg-brand-50/40"}`}>
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read_at ? "bg-transparent" : "bg-brand-500"}`} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-900">{n.link ? <Link href={notificationHref(n.link, n.company_id ?? cid)} className="hover:underline">{n.title}</Link> : n.title}</div>
                {n.body && <div className="text-sm text-slate-600">{n.body}</div>}
              </div>
              <div className="whitespace-nowrap text-xs text-slate-500">{fmtDateTime(n.created_at)}</div>
            </li>
          ))}
        </ul>
      </Card>
    ) : <Empty title="No notifications yet" icon={Bell}>Approvals, task updates and announcements will show up here.</Empty>;
  }

  return (
    <>
      <PageHeader title="Notifications" actions={tab === "inbox" && <form action={markAll}><button className="btn-secondary"><CheckCheck className="h-4 w-4" /> Mark all as read</button></form>} />
      <Tabs tabs={tabs} active={tab} />
      {body}
    </>
  );
}
