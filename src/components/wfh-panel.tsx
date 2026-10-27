"use client";
import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Camera, Coffee, LogIn, LogOut, MapPin, Play } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { wfhBreak, wfhCheckIn, wfhCheckOut } from "@/app/c/[cid]/attendance/actions";
import type { ActionState } from "@/lib/actions";

export type WfhStatus = {
  eligible: boolean; day_status: string | null; state: "out" | "in" | "break";
  worked_seconds: number; break_seconds: number; target_seconds: number; sessions: number; capture_gps: boolean;
};

const hms = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 3600)}:${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
};

/**
 * ATT-29: today's worked time, break time and time left to the target, ticking every second from the
 * server's figure. The figure itself is computed by the database (wfh_status) from stored sessions
 * (ATT-33) and refreshed through Supabase Realtime and at least every 60 seconds.
 */
export function WfhPanel({ cid, employeeId, initial, compact = false }: { cid: string; employeeId: string; initial: WfhStatus; compact?: boolean }) {
  const [st, setSt] = useState(initial);
  const [base, setBase] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const [camera, setCamera] = useState<null | "in" | "out">(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<ActionState>(null);
  const [askBreak, setAskBreak] = useState(false);              // "Start your break now?" (a mis-tap would stop the work timer)
  const [breakSince, setBreakSince] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await createClient().rpc("wfh_status", { p_company: cid });
    if (data) { setSt(data as WfhStatus); setBase(Date.now()); }
  }, [cid]);

  // when the open break started, for the "on break since" reminder
  useEffect(() => {
    if (st.state !== "break") { setBreakSince(null); return; }
    createClient().from("work_breaks").select("started_at").eq("employee_id", employeeId).is("ended_at", null)
      .order("started_at", { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => setBreakSince(data?.started_at ?? null));
  }, [st.state, employeeId]);

  useEffect(() => { setSt(initial); setBase(Date.now()); }, [initial]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  useEffect(() => {
    const t = setInterval(refresh, 60_000);
    const supabase = createClient();
    const ch = supabase.channel(`wfh-${employeeId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "work_sessions", filter: `employee_id=eq.${employeeId}` }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "work_breaks", filter: `employee_id=eq.${employeeId}` }, refresh)
      .subscribe();
    return () => { clearInterval(t); supabase.removeChannel(ch); };
  }, [employeeId, refresh]);

  const elapsed = (now - base) / 1000;
  const worked = st.worked_seconds + (st.state === "in" ? elapsed : 0);
  const onBreak = st.break_seconds + (st.state === "break" ? elapsed : 0);
  const left = Math.max(0, st.target_seconds - worked);
  const pct = st.target_seconds ? Math.min(100, (worked / st.target_seconds) * 100) : 0;

  const brk = (startBreak: boolean) => start(async () => { setAskBreak(false); setMsg(await wfhBreak(cid, startBreak)); await refresh(); });

  if (st.day_status !== "approved") return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs font-medium text-slate-500">Worked today</div>
          <div className={`${compact ? "text-3xl" : "text-4xl"} font-semibold tabular-nums tracking-tight text-slate-900`} aria-live="polite">{hms(worked)}</div>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${st.state === "in" ? "bg-emerald-50 text-emerald-700" : st.state === "break" ? "bg-amber-50 text-amber-800" : "bg-slate-100 text-slate-600"}`}>
          {st.state === "in" ? "Working" : st.state === "break" ? "On break" : st.sessions ? "Checked out" : "Not checked in"}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to today's target">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <dl className="grid grid-cols-2 gap-2 text-center">
        <div className="flex flex-col-reverse rounded-xl bg-slate-50 px-2 py-2.5"><dt className="text-xs text-slate-500">Break</dt><dd className="text-base font-semibold tabular-nums text-slate-900">{hms(onBreak)}</dd></div>
        <div className="flex flex-col-reverse rounded-xl bg-slate-50 px-2 py-2.5"><dt className="text-xs text-slate-500">Left to target</dt><dd className="text-base font-semibold tabular-nums text-slate-900">{hms(left)}</dd></div>
      </dl>
      <div className="flex flex-wrap gap-2">
        {st.state === "out" && !st.sessions && <button type="button" className="btn-primary h-11 flex-1" onClick={() => setCamera("in")}><LogIn className="h-4 w-4" /> Check in</button>}
        {st.state === "out" && st.sessions > 0 && (
          // one session per work-from-home day (decision of 27 Oct 2026): the day is finished and saved
          <p role="status" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
            ✅ <b>Checked out for today.</b> {hms(worked)} worked is saved. Checked out by mistake? Use <b>Request a correction</b>.
          </p>
        )}
        {st.state === "in" && !askBreak && <>
          <button type="button" className="btn-secondary h-11 flex-1" disabled={pending} onClick={() => { setMsg(null); setAskBreak(true); }}><Coffee className="h-4 w-4" /> Start break</button>
          <button type="button" className="btn-primary h-11 flex-1" onClick={() => setCamera("out")}><LogOut className="h-4 w-4" /> Check out</button>
        </>}
        {st.state === "break" && <button type="button" className="btn-primary h-11 flex-1" disabled={pending} onClick={() => brk(false)}><Play className="h-4 w-4" /> End break</button>}
      </div>
      {st.state === "in" && askBreak && (
        <div role="alertdialog" aria-labelledby="wfh-break-q" className="rounded-xl border border-amber-200 bg-amber-50 p-3">
          <p id="wfh-break-q" className="flex items-center gap-2 font-semibold text-amber-900"><Coffee className="h-4 w-4" /> Start your break now?</p>
          <p className="mt-1 text-sm text-amber-900">Your work timer will pause. Remember to press <b>End break</b> when you&apos;re back.</p>
          <div className="mt-3 flex gap-2">
            <button type="button" className="btn-secondary h-11 flex-1" onClick={() => setAskBreak(false)} autoFocus>Cancel</button>
            <button type="button" className="btn-primary h-11 flex-1" disabled={pending} onClick={() => brk(true)}>{pending ? "Starting…" : "Start break"}</button>
          </div>
        </div>
      )}
      {st.state === "break" && (
        <p role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          ☕ You&apos;re on break{breakSince ? ` since ${new Date(breakSince).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}` : ""}. Your work timer is paused: press <b>End break</b> when you&apos;re back.
        </p>
      )}
      {st.capture_gps && st.state === "out" && <p className="flex items-center gap-1.5 text-xs text-slate-500"><MapPin className="h-3.5 w-3.5" /> Your company records your location when you check in.</p>}
      {msg?.error && <p role="alert" className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{msg.error}</p>}
      {msg?.ok && <p role="status" className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg.ok}</p>}
      {camera && <SelfieCapture cid={cid} kind={camera} gps={st.capture_gps} onDone={async (r) => { setCamera(null); setMsg(r); await refresh(); }} onCancel={() => setCamera(null)} />}
    </div>
  );
}

// ATT-23: a selfie from the live camera only (no gallery upload); ATT-27: if the camera can't be used,
// the check-in still goes through and is flagged "photo missing".
function SelfieCapture({ cid, kind, gps, onDone, onCancel }: { cid: string; kind: "in" | "out"; gps: boolean; onDone: (r: ActionState) => void; onCancel: () => void }) {
  const action = kind === "in" ? wfhCheckIn.bind(null, cid) : wfhCheckOut.bind(null, cid);
  const [state, formAction, pending] = useActionState(action, null);
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [shot, setShot] = useState<Blob | null>(null);
  const [noCamera, setNoCamera] = useState(false);
  const [pos, setPos] = useState<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    let s: MediaStream | null = null;
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: "user" }, audio: false })
      .then((m) => { s = m; setStream(m); })
      .catch(() => setNoCamera(true));
    if (gps && kind === "in") navigator.geolocation?.getCurrentPosition((p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }), () => {}, { timeout: 10000 });
    return () => s?.getTracks().forEach((t) => t.stop());
  }, [gps, kind]);
  useEffect(() => { if (stream && video.current) { video.current.srcObject = stream; video.current.play().catch(() => {}); } }, [stream]);
  useEffect(() => { if (state) onDone(state); }, [state, onDone]);

  function capture() {
    const v = video.current;
    if (!v) return;
    const c = document.createElement("canvas");
    c.width = 480; c.height = Math.round((v.videoHeight / v.videoWidth) * 480) || 360;
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    c.toBlob((b) => setShot(b), "image/jpeg", 0.7);   // about 100 KB (BRD §10.3)
  }
  function submit(fd: FormData) {
    if (shot) fd.set("selfie", new File([shot], "selfie.jpg", { type: "image/jpeg" }));
    if (pos) { fd.set("lat", String(pos.lat)); fd.set("lng", String(pos.lng)); }
    fd.set("device", navigator.userAgent.slice(0, 200));
    formAction(fd);
  }

  return (
    <form action={submit} className="space-y-3 rounded-xl border border-slate-200 p-3">
      <div className="text-sm font-semibold text-slate-900">{kind === "in" ? "Check-in selfie" : "Check-out selfie"}</div>
      {!noCamera ? (
        <div className="overflow-hidden rounded-xl bg-black">
          <video ref={video} playsInline muted className={`w-full ${shot ? "hidden" : ""}`} />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {shot && <img src={URL.createObjectURL(shot)} alt="Your selfie" className="w-full" />}
        </div>
      ) : <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">The camera isn&apos;t available. You can still {kind === "in" ? "check in" : "check out"}; it&apos;s marked &ldquo;photo missing&rdquo; for your manager.</p>}
      <div className="flex gap-2">
        {!noCamera && (!shot
          ? <button type="button" className="btn-secondary flex-1" onClick={capture} disabled={!stream}><Camera className="h-4 w-4" /> Take selfie</button>
          : <button type="button" className="btn-secondary flex-1" onClick={() => setShot(null)}>Retake</button>)}
        <button className="btn-primary flex-1" disabled={pending || (!shot && !noCamera)}>{pending ? "Saving…" : kind === "in" ? "Check in" : "Check out"}</button>
      </div>
      <button type="button" className="btn-ghost btn-sm w-full" onClick={onCancel}>Cancel</button>
    </form>
  );
}
