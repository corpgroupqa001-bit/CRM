import "server-only";
import webpush from "web-push";
import { createAdminClient } from "@/lib/supabase/admin";
import { notificationHref } from "@/lib/notification-link";

// COMMS-07 web push. Sends to every subscribed browser of a user unless they muted that event type
// or are inside their do-not-disturb hours (India time).

let configured = false;
function setup() {
  if (configured) return true;
  const pub = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY, priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) return false;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@corpgroup.com", pub, priv);
  configured = true;
  return true;
}

export function inQuietHours(start: string | null, end: string | null, now = new Date()) {
  if (!start || !end) return false;
  const ist = new Date(now.getTime() + 5.5 * 3600000);
  const m = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(start), e = toMin(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;   // window may cross midnight
}

export async function pushToUser(n: { user_id: string; company_id: string | null; title: string; body: string | null; link: string | null; kind?: string }) {
  if (!setup()) return { sent: 0, reason: "VAPID keys not configured" };
  const db = createAdminClient();
  const [{ data: pref }, { data: profile }, { data: subs }] = await Promise.all([
    db.from("notification_prefs").select("push").eq("user_id", n.user_id).eq("kind", n.kind ?? "general").maybeSingle(),
    db.from("profiles").select("dnd_start, dnd_end").eq("id", n.user_id).maybeSingle(),
    db.from("push_subscriptions").select("*").eq("user_id", n.user_id),
  ]);
  if (pref && !pref.push) return { sent: 0, reason: "muted" };
  if (inQuietHours(profile?.dnd_start ?? null, profile?.dnd_end ?? null)) return { sent: 0, reason: "quiet hours" };
  const url = notificationHref(n.link, n.company_id);
  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: n.title, body: n.body ?? "", url }), { TTL: 3600 });
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from("push_subscriptions").delete().eq("id", s.id);  // expired subscription
    }
  }
  return { sent };
}
