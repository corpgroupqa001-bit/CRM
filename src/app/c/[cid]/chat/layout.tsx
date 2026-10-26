import Link from "next/link";
import { getCtx, requirePerm } from "@/lib/context";
import { ChatSidebar } from "./sidebar";

// Conversation list beside the open conversation
export default async function ChatLayout({ children, params }: { children: React.ReactNode; params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "chat.use");
  const { supabase, user } = ctx;
  const { data: mine } = await supabase.from("conversation_members").select("conversation_id, last_read_at, muted, conversations(id, kind, name, last_message_at, dm_key)")
    .eq("user_id", user.id).eq("company_id", cid);
  const { data: dir } = await supabase.from("employee_directory").select("user_id, full_name, photo_url").eq("company_id", cid).not("user_id", "is", null);
  const nameOf = new Map((dir ?? []).map((d) => [d.user_id, d.full_name]));

  const convs = await Promise.all((mine ?? []).map(async (m) => {
    const c = m.conversations as unknown as { id: string; kind: string; name: string | null; last_message_at: string; dm_key: string | null };
    const other = c.kind === "dm" ? c.dm_key!.split(":").find((u) => u !== user.id) : null;
    const { count } = await supabase.from("messages").select("id", { count: "exact", head: true })
      .eq("conversation_id", c.id).gt("created_at", m.last_read_at).neq("sender_id", user.id);
    return { id: c.id, kind: c.kind, name: other ? nameOf.get(other) ?? "Former colleague" : c.name ?? "Group", otherUserId: other,
      last: c.last_message_at, unread: count ?? 0, muted: m.muted };
  }));
  convs.sort((a, b) => b.last.localeCompare(a.last));
  const people = (dir ?? []).filter((d) => d.user_id !== user.id).map((d) => ({ userId: d.user_id!, name: d.full_name, photo: d.photo_url }));

  return (
    <div className="-mx-4 -mb-28 -mt-5 flex h-[calc(100dvh-60px-4rem-env(safe-area-inset-bottom))] sm:-mx-6 lg:-my-8 lg:h-[calc(100dvh-60px)]">
      <ChatSidebar cid={cid} convs={convs} people={people} meId={user.id} />
      <section className="flex min-w-0 flex-1 flex-col bg-surface">{children}</section>
      <Link href={`/c/${cid}/announcements`} className="sr-only">Announcements</Link>
    </div>
  );
}
