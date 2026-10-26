"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft, Bell, BellOff, Check, CheckCheck, CornerUpLeft, Forward, ListPlus, Mic, Paperclip, Pencil, Pin, PinOff, Send,
  Square, Star, Trash2, X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { fmtDateTime, fmtTime } from "@/lib/format";
import { leaveGroup, toggleMute } from "../actions";

type Msg = { id: string; sender_id: string; body: string | null; attachment_path: string | null; attachment_name: string | null;
  attachment_type: string | null; created_at: string; edited_at: string | null; deleted: boolean; reply_to_id: string | null;
  forwarded: boolean; pinned_at: string | null; company_id: string };
type Member = { user_id: string; last_read_at: string; muted: boolean };
type Preview = { url: string; host?: string; title?: string | null; description?: string | null; image?: string | null };

const MAX_FILE = 25 * 1024 * 1024; // COMMS-03
const URL_RE = /(https?:\/\/[^\s]+)/;
const previews = new Map<string, Promise<Preview | null>>();
function getPreview(url: string) {
  if (!previews.has(url)) previews.set(url, fetch(`/api/link-preview?url=${encodeURIComponent(url)}`).then((r) => r.json()).then((d) => (d.title ? d : null)).catch(() => null));
  return previews.get(url)!;
}

function LinkPreview({ url, mine }: { url: string; mine: boolean }) {
  const [p, setP] = useState<Preview | null>(null);
  useEffect(() => { getPreview(url).then(setP); }, [url]);
  if (!p) return null;
  return (
    <a href={p.url} target="_blank" rel="noreferrer" className={`mt-2 block overflow-hidden rounded-lg border ${mine ? "border-white/20 bg-white/10" : "border-slate-200 bg-slate-50"}`}>
      {p.image && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={p.image} alt="" className="max-h-36 w-full object-cover" />
      )}
      <div className="px-2.5 py-2">
        <div className={`text-[11px] ${mine ? "text-white/80" : "text-slate-500"}`}>{p.host}</div>
        <div className="line-clamp-2 text-sm font-medium">{p.title}</div>
        {p.description && <div className={`line-clamp-2 text-xs ${mine ? "text-white/80" : "text-slate-500"}`}>{p.description}</div>}
      </div>
    </a>
  );
}

export function Conversation({ cid, convId, kind, title, meId, names, initialMessages, initialMembers, muted, starred, forwardTargets }: {
  cid: string; convId: string; kind: string; title: string; meId: string; names: Record<string, string>;
  initialMessages: Msg[]; initialMembers: Member[]; muted: boolean; starred: string[]; forwardTargets: { id: string; name: string }[];
}) {
  const supabase = useRef(createClient()).current;
  const [messages, setMessages] = useState<Msg[]>(initialMessages);
  const [members, setMembers] = useState<Member[]>(initialMembers);
  const [stars, setStars] = useState<Set<string>>(new Set(starred));
  const [text, setText] = useState("");
  const [typing, setTyping] = useState<Record<string, number>>({});
  const [editing, setEditing] = useState<Msg | null>(null);
  const [replyTo, setReplyTo] = useState<Msg | null>(null);
  const [forwarding, setForwarding] = useState<Msg | null>(null);
  const [showStarred, setShowStarred] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [recording, setRecording] = useState<MediaRecorder | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const channel = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // one merge for realtime events and our own inserts, so a message never shows twice
  const upsertMessage = useCallback((m: Msg) => {
    setMessages((list) => list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m]);
  }, []);

  const markRead = useCallback(async () => {
    await supabase.from("conversation_members").update({ last_read_at: new Date().toISOString() }).eq("conversation_id", convId).eq("user_id", meId);
  }, [supabase, convId, meId]);

  useEffect(() => {
    markRead();
    const ch = supabase.channel(`conv-${convId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `conversation_id=eq.${convId}` }, (p) => {
        const m = p.new as Msg;
        upsertMessage(m);
        if (p.eventType === "INSERT" && m.sender_id !== meId) markRead();
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "conversation_members", filter: `conversation_id=eq.${convId}` }, (p) => {
        const m = p.new as Member;
        setMembers((list) => list.map((x) => (x.user_id === m.user_id ? m : x)));
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (payload.user !== meId) setTyping((t) => ({ ...t, [payload.user]: Date.now() }));
      })
      .subscribe();
    channel.current = ch;
    return () => { supabase.removeChannel(ch); };
  }, [supabase, convId, meId, markRead, upsertMessage]);

  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);
  useEffect(() => {
    const t = setInterval(() => setTyping((x) => Object.fromEntries(Object.entries(x).filter(([, at]) => Date.now() - at < 3000))), 1000);
    return () => clearInterval(t);
  }, []);

  // signed URLs for attachments (private bucket); they last an hour, so re-sign every 50 minutes
  useEffect(() => {
    const t = setInterval(() => setUrls({}), 50 * 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const need = messages.filter((m) => m.attachment_path && !urls[m.attachment_path]).map((m) => m.attachment_path!);
    if (!need.length) return;
    supabase.storage.from("chat").createSignedUrls(need, 3600).then(({ data }) => {
      if (data) setUrls((u) => ({ ...u, ...Object.fromEntries(data.filter((d) => d.signedUrl && d.path).map((d) => [d.path as string, d.signedUrl as string])) }));
    });
  }, [messages, urls, supabase]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;
    setErr(null);
    if (editing) {
      const { error } = await supabase.from("messages").update({ body }).eq("id", editing.id);
      if (error) setErr(error.message); else { setEditing(null); setText(""); }
      return;
    }
    setText("");
    const { data, error } = await supabase.from("messages")
      .insert({ conversation_id: convId, company_id: cid, sender_id: meId, body, reply_to_id: replyTo?.id ?? null }).select().single();
    if (error) { setErr(error.message); setText(body); return; }
    upsertMessage(data as Msg);   // visible at once; the Realtime echo is merged by id
    setReplyTo(null);
  }

  // COMMS-03: files go to the private "chat" bucket under {company}/{conversation}/; 25 MB limit
  // (checked here, by the bucket's file_size_limit and by the messages table)
  async function upload(file: File) {
    if (file.size > MAX_FILE) { setErr(`“${file.name}” is ${(file.size / 1048576).toFixed(1)} MB. Files must be 25 MB or smaller.`); return; }
    if (file.size === 0) { setErr("That file is empty."); return; }
    setBusy(true); setErr(null); setUploading(file.name);
    const path = `${cid}/${convId}/${Date.now()}-${file.name.replace(/[^\w.\-]/g, "_")}`;
    const up = await supabase.storage.from("chat").upload(path, file, { contentType: file.type || "application/octet-stream" });
    if (up.error) {
      setErr(/exceed|too large|413/i.test(up.error.message) ? "Files must be 25 MB or smaller." : `Upload failed: ${up.error.message}`);
      setBusy(false); setUploading(null); return;
    }
    const { data, error } = await supabase.from("messages").insert({ conversation_id: convId, company_id: cid, sender_id: meId,
      attachment_path: path, attachment_name: file.name, attachment_type: file.type || "application/octet-stream", attachment_size: file.size,
      reply_to_id: replyTo?.id ?? null }).select().single();
    if (error) {
      setErr(error.message);
      await supabase.storage.from("chat").remove([path]);   // don't leave an orphaned file behind
    } else { upsertMessage(data as Msg); setReplyTo(null); }
    setBusy(false); setUploading(null);
  }

  // COMMS-03 voice notes
  async function toggleRecording() {
    if (recording) { recording.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(null);
        const type = rec.mimeType || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        upload(new File([new Blob(chunks, { type })], `voice-note-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${ext}`, { type }));
      };
      rec.start();
      setRecording(rec);
    } catch { setErr("Microphone access was blocked."); }
  }

  // a forwarded file is copied into the target conversation's folder, so its members can open it
  async function forwardTo(target: string) {
    const m = forwarding!;
    setForwarding(null);
    let path: string | null = null;
    if (m.attachment_path) {
      path = `${cid}/${target}/${Date.now()}-${m.attachment_path.split("/").pop()}`;
      const { error } = await supabase.storage.from("chat").copy(m.attachment_path, path);
      if (error) { setErr(`Couldn't forward the file: ${error.message}`); return; }
    }
    const { error } = await supabase.from("messages").insert({ conversation_id: target, company_id: cid, sender_id: meId, body: m.body,
      attachment_path: path, attachment_name: m.attachment_name, attachment_type: m.attachment_type, forwarded: true });
    setErr(error ? error.message : null);
  }

  async function togglePin(m: Msg) {
    const { error } = await supabase.from("messages").update({ pinned_at: m.pinned_at ? null : new Date().toISOString() }).eq("id", m.id);
    if (error) setErr(error.message);
  }

  async function toggleStar(m: Msg) {
    if (stars.has(m.id)) {
      await supabase.from("message_stars").delete().eq("message_id", m.id).eq("user_id", meId);
      setStars((s) => { const n = new Set(s); n.delete(m.id); return n; });
    } else {
      const { error } = await supabase.from("message_stars").insert({ message_id: m.id, company_id: cid });
      if (!error) setStars((s) => new Set(s).add(m.id));
    }
  }

  const byId = new Map(messages.map((m) => [m.id, m]));
  const others = members.filter((m) => m.user_id !== meId);
  const seenByAll = (m: Msg) => others.length > 0 && others.every((o) => o.last_read_at >= m.created_at);
  const typers = Object.keys(typing).map((u) => names[u]?.split(" ")[0]).filter(Boolean);
  const canEdit = (m: Msg) => m.sender_id === meId && !m.deleted && Date.now() - new Date(m.created_at).getTime() < 15 * 60_000;
  const linkify = (s: string) => s.split(/(https?:\/\/\S+)/g).map((p, i) => /^https?:\/\//.test(p) ? <a key={i} href={p} target="_blank" rel="noreferrer" className="underline">{p}</a> : p);
  const pinned = messages.filter((m) => m.pinned_at && !m.deleted);
  const shown = showStarred ? messages.filter((m) => stars.has(m.id)) : messages;
  const jump = (id: string) => document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const snippet = (m?: Msg) => (m ? (m.deleted ? "Deleted message" : m.body ?? `📎 ${m.attachment_name}`) : "Original message");
  const Act = ({ title: t, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) => (
    <button title={t} aria-label={t} onClick={onClick} className="rounded p-1 text-slate-500 hover:bg-surface hover:text-slate-700">{children}</button>
  );

  return (
    <>
      <header className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
        <Link href={`/c/${cid}/chat`} className="md:hidden" aria-label="Back"><ArrowLeft className="h-5 w-5" /></Link>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold text-slate-900">{title}</div>
          <div className="text-xs text-slate-500">{typers.length ? `${typers.join(", ")} typing…` : kind === "dm" ? "Direct message" : `${members.length} members · ${kind}`}</div>
        </div>
        <button onClick={() => setShowStarred((s) => !s)} className={`btn-ghost btn-sm ${showStarred ? "bg-amber-50 text-amber-700" : ""}`} title="Starred messages">
          <Star className="h-4 w-4" /> <span className="hidden sm:inline">{showStarred ? "Show all" : "Starred"}</span>
        </button>
        <form action={toggleMute.bind(null, cid, convId, !muted)}><button className="btn-ghost btn-sm" title={muted ? "Unmute" : "Mute"}>{muted ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}</button></form>
        {kind === "group" && <form action={leaveGroup.bind(null, cid, convId)}><button className="btn-ghost btn-sm">Leave</button></form>}
      </header>
      {pinned.length > 0 && !showStarred && (
        <div className="flex items-center gap-2 overflow-x-auto border-b border-slate-200 bg-amber-50/60 px-4 py-2 text-xs">
          <Pin className="h-3.5 w-3.5 shrink-0 text-amber-600" />
          {pinned.map((m) => <button key={m.id} onClick={() => jump(m.id)} className="max-w-64 shrink-0 truncate rounded-md bg-surface px-2 py-1 text-slate-700 ring-1 ring-amber-200 hover:ring-amber-300">{snippet(m)}</button>)}
        </div>
      )}
      <div className="thin-scroll flex-1 space-y-1 overflow-y-auto bg-slate-50 px-4 py-4">
        {showStarred && !shown.length && <p className="py-10 text-center text-sm text-slate-500">No starred messages in this chat.</p>}
        {shown.map((m, i) => {
          const mine = m.sender_id === meId;
          const showName = !mine && kind !== "dm" && shown[i - 1]?.sender_id !== m.sender_id;
          const url = m.attachment_path ? urls[m.attachment_path] : null;
          const link = m.body?.match(URL_RE)?.[1];
          const parent = m.reply_to_id ? byId.get(m.reply_to_id) : undefined;
          return (
            <div key={m.id} id={`m-${m.id}`} className={`group flex items-center gap-1 ${mine ? "flex-row-reverse" : ""}`}>
              <div className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "bg-accent text-white" : "bg-surface text-slate-800"}`}>
                {showName && <div className="mb-0.5 text-xs font-semibold text-brand-700">{names[m.sender_id] ?? "Someone"}</div>}
                {m.forwarded && !m.deleted && <div className={`mb-0.5 flex items-center gap-1 text-[11px] italic ${mine ? "text-white/80" : "text-slate-500"}`}><Forward className="h-3 w-3" /> Forwarded</div>}
                {m.reply_to_id && !m.deleted && (
                  <button onClick={() => parent && jump(parent.id)} className={`mb-1.5 block w-full rounded-md border-l-2 px-2 py-1 text-left text-xs ${mine ? "border-white/60 bg-white/10 text-white/85" : "border-brand-400 bg-slate-100 text-slate-600"}`}>
                    <span className="block font-semibold">{parent ? names[parent.sender_id] ?? "Someone" : ""}</span>
                    <span className="line-clamp-2">{snippet(parent)}</span>
                  </button>
                )}
                {m.deleted ? <i className="opacity-70">This message was deleted</i> : <>
                  {m.attachment_path && (
                    m.attachment_type?.startsWith("image/") && url
                      // eslint-disable-next-line @next/next/no-img-element
                      ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={m.attachment_name ?? ""} className="mb-1 max-h-64 rounded-lg" /></a>
                      : m.attachment_type?.startsWith("audio/") && url
                        ? <audio controls src={url} className="mb-1 h-10 max-w-64" />
                        : <a href={url ?? "#"} target="_blank" rel="noreferrer" className="mb-1 flex items-center gap-1 underline"><Paperclip className="h-3.5 w-3.5" />{m.attachment_name}</a>
                  )}
                  {m.body && <p className="whitespace-pre-wrap break-words">{linkify(m.body)}</p>}
                  {link && <LinkPreview url={link} mine={mine} />}
                </>}
                <div className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] ${mine ? "text-white/80" : "text-slate-500"}`} title={fmtDateTime(m.created_at)}>
                  {m.pinned_at && <Pin className="h-3 w-3" />}{stars.has(m.id) && <Star className="h-3 w-3 fill-current" />}
                  {m.edited_at && "edited ·"} {fmtTime(m.created_at)}
                  {mine && !m.deleted && (seenByAll(m) ? <CheckCheck className="h-3 w-3" /> : <Check className="h-3 w-3" />)}
                </div>
              </div>
              {!m.deleted && (
                <div className="hidden items-center gap-0.5 group-hover:flex">
                  <Act title="Reply" onClick={() => { setReplyTo(m); setEditing(null); }}><CornerUpLeft className="h-3.5 w-3.5" /></Act>
                  <Act title="Forward" onClick={() => setForwarding(m)}><Forward className="h-3.5 w-3.5" /></Act>
                  <Act title={m.pinned_at ? "Unpin" : "Pin"} onClick={() => togglePin(m)}>{m.pinned_at ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</Act>
                  <Act title={stars.has(m.id) ? "Unstar" : "Star"} onClick={() => toggleStar(m)}><Star className={`h-3.5 w-3.5 ${stars.has(m.id) ? "fill-amber-400 text-amber-500" : ""}`} /></Act>
                  {m.body && <Link title="Create task" aria-label="Create task" href={`/c/${cid}/tasks?new=1&from_message=${m.id}&text=${encodeURIComponent(m.body.slice(0, 500))}`} className="rounded p-1 text-slate-500 hover:bg-surface hover:text-slate-700"><ListPlus className="h-3.5 w-3.5" /></Link>}
                  {canEdit(m) && m.body && <Act title="Edit" onClick={() => { setEditing(m); setReplyTo(null); setText(m.body!); }}><Pencil className="h-3.5 w-3.5" /></Act>}
                  {mine && <Act title="Delete for everyone" onClick={() => { supabase.from("messages").update({ deleted: true }).eq("id", m.id).then(({ error }) => error && setErr(error.message)); }}><Trash2 className="h-3.5 w-3.5" /></Act>}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      <form onSubmit={send} className="border-t border-slate-200 bg-surface p-3">
        {(editing || replyTo) && (
          <div className="mb-2 flex items-start justify-between gap-2 rounded-lg border-l-2 border-brand-500 bg-slate-50 px-3 py-1.5 text-xs">
            <span className="min-w-0"><b className="text-brand-700">{editing ? "Editing message" : `Replying to ${names[replyTo!.sender_id] ?? "message"}`}</b>
              {replyTo && <span className="block truncate text-slate-500">{snippet(replyTo)}</span>}</span>
            <button type="button" onClick={() => { setEditing(null); setReplyTo(null); if (editing) setText(""); }} aria-label="Cancel"><X className="h-4 w-4 text-slate-400" /></button>
          </div>
        )}
        {err && <div className="mb-2 text-xs text-rose-600">{err}</div>}
        {uploading && <div className="mb-2 flex items-center gap-2 text-xs text-slate-500"><span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" /> Uploading {uploading}…</div>}
        <div className="flex items-end gap-2">
          <label className={`btn-ghost cursor-pointer px-2 ${busy ? "opacity-50" : ""}`} title="Attach a file (≤ 25 MB)">
            <Paperclip className="h-5 w-5" />
            <input type="file" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ""; }} />
          </label>
          <button type="button" onClick={toggleRecording} disabled={busy} title={recording ? "Stop and send" : "Record a voice note"}
            className={`btn-ghost px-2 ${recording ? "animate-pulse text-rose-600" : ""}`}>{recording ? <Square className="h-5 w-5" /> : <Mic className="h-5 w-5" />}</button>
          <textarea value={text} rows={1} placeholder={recording ? "Recording… press ■ to send" : "Type a message"}
            onChange={(e) => { setText(e.target.value); channel.current?.send({ type: "broadcast", event: "typing", payload: { user: meId } }); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }}
            className="input max-h-40 flex-1 resize-none py-2" />
          <button className="btn-primary px-3" disabled={!text.trim()} aria-label="Send"><Send className="h-4 w-4" /></button>
        </div>
      </form>
      {forwarding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim px-4" onClick={() => setForwarding(null)}>
          <div className="w-full max-w-sm overflow-hidden rounded-2xl bg-surface shadow-(--shadow-pop)" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-slate-100 px-4 py-3 text-sm font-semibold">Forward to…</div>
            <ul className="thin-scroll max-h-80 overflow-y-auto p-1.5">
              {forwardTargets.map((t) => <li key={t.id}><button onClick={() => forwardTo(t.id)} className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-slate-100">{t.name}</button></li>)}
              {!forwardTargets.length && <li className="px-3 py-6 text-center text-sm text-slate-500">No other conversations.</li>}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
