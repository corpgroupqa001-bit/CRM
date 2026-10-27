import type { SupabaseClient } from "@supabase/supabase-js";
import { Camera } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { fmtDate } from "@/lib/format";

type Shot = { key: string; date: string; label: string; at: string | null; path: string | null; missing: boolean; lat: number | null; lng: number | null; note?: string };

const time = (t: string | null) => t ? new Date(t).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kolkata" }) : "—";

/**
 * ATT-25: attendance selfies of one employee for a month, for HR and their reporting manager only. The
 * photos are private files; each link is signed for five minutes with the viewer's own rights, so the
 * storage policy (selfies_read) decides who sees them.
 */
export async function SelfieLog({ supabase, empId, from, to }: { supabase: SupabaseClient; empId: string; from: string; to: string }) {
  const [{ data: sessions }, { data: punches }] = await Promise.all([
    supabase.from("work_sessions").select("id, date, started_at, ended_at, end_reason, selfie_in, selfie_out, photo_missing_in, photo_missing_out, lat, lng")
      .eq("employee_id", empId).gte("date", from).lte("date", to).order("started_at", { ascending: false }),
    supabase.from("punches_raw").select("id, punched_at, selfie_path, lat, lng").eq("employee_id", empId).eq("source", "mobile")
      .gte("punched_at", `${from}T00:00:00+05:30`).lte("punched_at", `${to}T23:59:59+05:30`).order("punched_at", { ascending: false }),
  ]);
  const shots: Shot[] = [];
  for (const s of sessions ?? []) {
    shots.push({ key: `${s.id}-in`, date: s.date, label: "WFH check-in", at: s.started_at, path: s.selfie_in, missing: s.photo_missing_in, lat: s.lat, lng: s.lng });
    if (s.ended_at) shots.push({ key: `${s.id}-out`, date: s.date, label: s.end_reason === "auto" ? "WFH closed automatically" : "WFH check-out", at: s.ended_at,
      path: s.selfie_out, missing: s.end_reason !== "auto" && s.photo_missing_out, lat: null, lng: null, note: s.end_reason === "auto" ? "No check-out: closed at the last activity" : undefined });
  }
  for (const p of punches ?? []) {
    shots.push({ key: `p-${p.id}`, date: p.punched_at.slice(0, 10), label: "Field punch", at: p.punched_at, path: p.selfie_path, missing: !p.selfie_path, lat: p.lat, lng: p.lng });
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
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
