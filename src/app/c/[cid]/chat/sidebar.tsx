"use client";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { BellOff, Hash, Plus, Search, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Avatar } from "@/components/ui";
import { openDm } from "./actions";

type Conv = { id: string; kind: string; name: string; otherUserId?: string | null; last: string; unread: number; muted: boolean };
type Person = { userId: string; name: string; photo: string | null };

export function ChatSidebar({ cid, convs, people, meId }: { cid: string; convs: Conv[]; people: Person[]; meId: string }) {
  const { convId } = useParams<{ convId?: string }>();
  const router = useRouter();
  const [filter, setFilter] = useState("");
  const [online, setOnline] = useState<Set<string>>(new Set());
  const [picker, setPicker] = useState(false);

  // COMMS-04 presence across the company
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`presence-${cid}`, { config: { presence: { key: meId } } });
    ch.on("presence", { event: "sync" }, () => setOnline(new Set(Object.keys(ch.presenceState()))))
      .subscribe(async (s) => { if (s === "SUBSCRIBED") await ch.track({ at: Date.now() }); });
    return () => { supabase.removeChannel(ch); };
  }, [cid, meId]);

  // refresh the list when a new message arrives anywhere I'm a member
  useEffect(() => {
    const supabase = createClient();
    const ch = supabase.channel(`inbox-${cid}-${meId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `company_id=eq.${cid}` }, () => router.refresh())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cid, meId, router]);

  const shown = convs.filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
  const icon = (c: Conv) => c.kind === "dm" ? (
    <span className="relative"><Avatar name={c.name} size={32} />{c.otherUserId && online.has(c.otherUserId) && <span className="absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />}</span>
  ) : <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-500">{c.kind === "group" ? <Users className="h-4 w-4" /> : <Hash className="h-4 w-4" />}</span>;

  return (
    <aside className={`w-full shrink-0 flex-col border-r border-slate-200 bg-white md:flex md:w-80 ${convId ? "hidden" : "flex"}`}>
      <div className="flex items-center gap-2 border-b border-slate-200 p-3">
        <div className="relative flex-1"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a chat" className="input pl-8" /></div>
        <button onClick={() => setPicker((p) => !p)} className="btn-secondary px-2.5" aria-label="New chat"><Plus className="h-4 w-4" /></button>
      </div>
      {picker && (
        <div className="max-h-72 overflow-y-auto border-b border-slate-200 bg-slate-50 p-2">
          <Link href={`/c/${cid}/chat?new=group`} onClick={() => setPicker(false)} className="mb-1 flex items-center gap-2 rounded-lg px-2 py-2 text-sm font-medium text-brand-700 hover:bg-white"><Users className="h-4 w-4" /> New group</Link>
          {people.map((p) => (
            <form key={p.userId} action={openDm.bind(null, cid, p.userId)}>
              <button className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-white">
                <Avatar name={p.name} url={p.photo} size={26} />{p.name}{online.has(p.userId) && <span className="ml-auto h-2 w-2 rounded-full bg-emerald-500" />}
              </button>
            </form>
          ))}
        </div>
      )}
      <nav className="flex-1 overflow-y-auto">
        {shown.map((c) => (
          <Link key={c.id} href={`/c/${cid}/chat/${c.id}`}
            className={`flex items-center gap-3 border-b border-slate-50 px-3 py-2.5 ${convId === c.id ? "bg-brand-50" : "hover:bg-slate-50"}`}>
            {icon(c)}
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm ${c.unread ? "font-semibold" : ""}`}>{c.name}</span>
              <span className="block text-xs capitalize text-slate-400">{c.kind === "dm" ? (c.otherUserId && online.has(c.otherUserId) ? "online" : "direct") : c.kind}</span>
            </span>
            {c.muted && <BellOff className="h-3.5 w-3.5 text-slate-400" />}
            {c.unread > 0 && !c.muted && <span className="rounded-full bg-brand-600 px-1.5 text-xs font-semibold text-white">{c.unread}</span>}
          </Link>
        ))}
        {!shown.length && <p className="p-6 text-center text-sm text-slate-500">No conversations yet. Press + to start one.</p>}
      </nav>
    </aside>
  );
}
