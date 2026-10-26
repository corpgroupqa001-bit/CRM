import { notFound } from "next/navigation";
import { getCtx } from "@/lib/context";
import { Conversation } from "./conversation";

export const metadata = { title: "Chat" };

export default async function ConversationPage({ params }: { params: Promise<{ cid: string; convId: string }> }) {
  const { cid, convId } = await params;
  const { supabase, user } = await getCtx(cid);
  const { data: conv } = await supabase.from("conversations").select("*").eq("id", convId).eq("company_id", cid).maybeSingle();
  if (!conv) notFound();
  const [{ data: members }, { data: messages }, { data: dir }, { data: stars }, { data: mine }] = await Promise.all([
    supabase.from("conversation_members").select("user_id, last_read_at, muted").eq("conversation_id", convId),
    supabase.from("messages").select("*").eq("conversation_id", convId).order("created_at", { ascending: false }).limit(200),
    supabase.from("employee_directory").select("user_id, full_name, photo_url").eq("company_id", cid).not("user_id", "is", null),
    supabase.from("message_stars").select("message_id").eq("user_id", user.id).eq("company_id", cid),
    supabase.from("conversation_members").select("conversations(id, kind, name, dm_key)").eq("user_id", user.id).eq("company_id", cid),
  ]);
  const names = Object.fromEntries((dir ?? []).map((d) => [d.user_id, d.full_name]));
  const other = conv.kind === "dm" ? conv.dm_key.split(":").find((u: string) => u !== user.id) : null;
  const title = other ? names[other] ?? "Former colleague" : conv.name;
  const me = (members ?? []).find((m) => m.user_id === user.id);
  // forward targets: every conversation I'm in, named the way the sidebar names them
  const targets = (mine ?? []).map((m) => {
    const c = m.conversations as unknown as { id: string; kind: string; name: string | null; dm_key: string | null };
    const o = c.kind === "dm" ? c.dm_key!.split(":").find((u) => u !== user.id) : null;
    return { id: c.id, name: o ? names[o] ?? "Former colleague" : c.name ?? "Group" };
  }).filter((c) => c.id !== convId).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Conversation
      cid={cid} convId={convId} kind={conv.kind} title={title} meId={user.id} names={names}
      initialMessages={(messages ?? []).reverse()} initialMembers={members ?? []} muted={!!me?.muted}
      starred={(stars ?? []).map((x) => x.message_id)} forwardTargets={targets}
    />
  );
}
