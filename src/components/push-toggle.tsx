"use client";
import { useEffect, useState } from "react";
import { BellRing, BellOff } from "lucide-react";

const b64ToBytes = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

// Subscribe / unsubscribe this browser for web push (COMMS-07)
export function PushToggle() {
  const [state, setState] = useState<"loading" | "unsupported" | "denied" | "off" | "on">("loading");
  const [err, setErr] = useState<string | null>(null);
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

  useEffect(() => {
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window) || !key) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      setState((await reg.pushManager.getSubscription()) ? "on" : "off");
    })().catch(() => setState("unsupported"));
  }, [key]);

  async function enable() {
    setErr(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("denied");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key!) });
      const r = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(sub) });
      if (!r.ok) throw new Error((await r.json()).error);
      setState("on");
    } catch (e) { setErr((e as Error).message); }
  }
  async function disable() {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch("/api/push/subscribe", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
      await sub.unsubscribe();
    }
    setState("off");
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      {state === "on" ? <button onClick={disable} className="btn-secondary"><BellOff className="h-4 w-4" /> Turn off on this device</button>
        : <button onClick={enable} disabled={state !== "off"} className="btn-primary"><BellRing className="h-4 w-4" /> Enable push on this device</button>}
      <span className="text-xs text-slate-500">
        {state === "on" && "This device receives push notifications."}
        {state === "denied" && "Notifications are blocked in this browser's site settings."}
        {state === "unsupported" && "Push isn't available here (needs HTTPS or localhost, and on iPhone the app added to the Home Screen, iOS 16.4+)."}
      </span>
      {err && <span className="text-xs text-rose-600">{err}</span>}
    </div>
  );
}
