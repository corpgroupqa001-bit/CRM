import type { SupabaseClient } from "@supabase/supabase-js";
import { Camera, Flag } from "lucide-react";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Sheet } from "@/components/sheet";
import { Badge, Card, Field } from "@/components/ui";
import { fmtDate, label } from "@/lib/format";
import { closeSelfieFlag, flagSelfie } from "../actions";

type Shot = { key: string; source: "wfh_in" | "wfh_out" | "field_punch"; ref: string; date: string; label: string; at: string | null; path: string | null; missing: boolean; lat: number | null; lng: number | null; note?: string };
type SelfieFlag = { id: string; source: string; ref_id: string; reason: string; note: string; status: string; explanation: string | null };

const time = (t: string | null) => t ? new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";

/**
 * ATT-25: attendance selfies of one employee for a month, for HR and their reporting manager only. The
 * photos are private files; each link is signed for five minutes with the viewer's own rights, so the
 * storage policy (selfies_read) decides who sees them.
 */
export async function SelfieLog({ cid, supabase, empId, from, to }: { cid: string; supabase: SupabaseClient; empId: string; from: string; to: string }) {
  const [{ data: sessions }, { data: punches }, { data: flagRows }] = await Promise.all([
    supabase.from("work_sessions").select("id, date, started_at, ended_at, end_reason, selfie_in, selfie_out, photo_missing_in, photo_missing_out, lat, lng")
      .eq("employee_id", empId).gte("date", from).lte("date", to).order("started_at", { ascending: false }),
    supabase.from("punches_raw").select("id, punched_at, selfie_path, lat, lng").eq("employee_id", empId).eq("source", "mobile")
      .gte("punched_at", `${from}T00:00:00+05:30`).lte("punched_at", `${to}T23:59:59+05:30`).order("punched_at", { ascending: false }),
    supabase.from("selfie_flags").select("id, source, ref_id, reason, note, status, explanation").eq("employee_id", empId).gte("date", from).lte("date", to),
  ]);
  const flags = new Map((flagRows as SelfieFlag[] | null ?? []).map((f) => [`${f.source}|${f.ref_id}`, f]));
  const shots: Shot[] = [];
  for (const s of sessions ?? []) {
    shots.push({ key: `${s.id}-in`, source: "wfh_in", ref: s.id, date: s.date, label: "WFH check-in", at: s.started_at, path: s.selfie_in, missing: s.photo_missing_in, lat: s.lat, lng: s.lng });
    if (s.ended_at) shots.push({ key: `${s.id}-out`, source: "wfh_out", ref: s.id, date: s.date, label: s.end_reason === "auto" ? "WFH closed automatically" : "WFH check-out", at: s.ended_at,
      path: s.selfie_out, missing: s.end_reason !== "auto" && s.photo_missing_out, lat: null, lng: null, note: s.end_reason === "auto" ? "No check-out: closed at the last activity" : undefined });
  }
  for (const p of punches ?? []) {
    shots.push({ key: `p-${p.id}`, source: "field_punch", ref: String(p.id), date: p.punched_at.slice(0, 10), label: "Field punch", at: p.punched_at, path: p.selfie_path, missing: !p.selfie_path, lat: p.lat, lng: p.lng });
  }
  shots.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  const paths = shots.map((s) => s.path).filter((p): p is string => !!p);
  const urls = new Map<string, string>();
  if (paths.length) {
    const { data } = await supabase.storage.from("selfies").createSignedUrls(paths, 300);
    for (const d of data ?? []) if (d.signedUrl && d.path) urls.set(d.path, d.signedUrl);
  }
  const hidden = paths.length > 0 && urls.size === 0;

  return (
    <Card title="Selfies" description="Work-from-home check-ins and field punches this month. Visible only to HR and the reporting manager (ATT-25).">
      {!shots.length ? <p className="text-sm text-slate-500">No selfies this month.</p>
        : hidden ? <p className="text-sm text-slate-500">Only HR and this employee&apos;s reporting manager can see their selfies.</p> : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shots.map((s) => {
            const url = s.path ? urls.get(s.path) : undefined;
            return (
              <li key={s.key} className="overflow-hidden rounded-xl border border-slate-200">
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" className="block bg-black">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={url} alt={`${s.label}, ${fmtDate(s.date)} ${time(s.at)}`} className="aspect-[4/3] w-full object-cover" loading="lazy" />
                  </a>
                ) : (
                  <div className="flex aspect-[4/3] flex-col items-center justify-center gap-1 bg-slate-50 text-slate-500">
                    <Camera className="h-6 w-6" /><span className="text-xs">{s.missing ? "Photo missing" : "No photo"}</span>
                  </div>
                )}
                <div className="space-y-1 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-slate-900">{s.label}</span>
                    {s.missing && <Badge value="pending" text="Photo missing" />}
                  </div>
                  <div className="text-slate-600">{fmtDate(s.date)} · {time(s.at)}</div>
                  {s.lat != null && s.lng != null && (
                    <a className="text-xs font-medium text-brand-600 hover:underline" href={`https://www.google.com/maps?q=${s.lat},${s.lng}`} target="_blank" rel="noreferrer">
                      Location {s.lat.toFixed(4)}, {s.lng.toFixed(4)}
                    </a>
                  )}
                  {s.note && <div className="text-xs text-amber-700">{s.note}</div>}
                  <FlagBlock cid={cid} shot={s} flag={flags.get(`${s.source}|${s.ref}`)} canFlag={!!url} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// flag a selfie (decision 27 Oct 2026), or follow up a flag that exists
function FlagBlock({ cid, shot, flag, canFlag }: { cid: string; shot: Shot; flag?: SelfieFlag; canFlag: boolean }) {
  if (flag) {
    const open = flag.status === "open" || flag.status === "explained";
    return (
      <div className="mt-2 space-y-1.5 rounded-lg bg-rose-50 p-2.5 text-xs text-rose-800">
        <div className="flex items-center gap-1.5 font-semibold"><Flag className="h-3.5 w-3.5" /> {label(flag.reason)}
          <span className="ml-auto font-medium">{{ open: "Waiting for explanation", explained: "Explained", accepted: "Explanation accepted", upheld: "Flag upheld" }[flag.status]}</span></div>
        <div>{flag.note}</div>
        {flag.explanation && <div className="rounded-md bg-surface p-2 text-slate-700"><span className="font-medium">Employee: </span>{flag.explanation}</div>}
        {open && (
          <div className="flex gap-2 pt-1">
            <form action={closeSelfieFlag.bind(null, cid, flag.id, false)}><button className="btn-secondary btn-sm">Accept explanation</button></form>
            <form action={closeSelfieFlag.bind(null, cid, flag.id, true)}><button className="btn-danger btn-sm">Uphold flag</button></form>
          </div>
        )}
      </div>
    );
  }
  if (!canFlag) return null;
  return (
    <div className="pt-1">
      <Sheet trigger={<><Flag className="h-3.5 w-3.5" /> Flag</>} triggerClassName="btn-ghost btn-sm text-rose-700" title="Flag this selfie"
        description={`${shot.label} · ${fmtDate(shot.date)} ${time(shot.at)}`}>
        <ActionForm action={flagSelfie.bind(null, cid, shot.source, shot.ref)}>
          <Field label="What's wrong"><select name="reason" className="input" required defaultValue="">
            <option value="" disabled>Choose…</option><option value="wrong_person">Wrong person</option><option value="wrong_place">Wrong place</option><option value="other">Other</option></select></Field>
          <Field label="Note for the employee" hint="They're notified and asked to explain. Attendance and pay don't change unless HR corrects the day.">
            <textarea name="note" rows={3} className="input" required placeholder="e.g. The photo doesn't show you" /></Field>
          <SubmitButton className="btn-danger w-full" pendingText="Flagging…">Flag selfie</SubmitButton>
        </ActionForm>
      </Sheet>
    </div>
  );
}
