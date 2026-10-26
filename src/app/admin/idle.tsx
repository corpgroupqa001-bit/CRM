"use client";
import { useEffect } from "react";

/**
 * Admin console activity: while someone is using the page, the session is kept alive (a ping at most
 * once a minute renews the server's 15-minute activity stamp). After 15 minutes with no activity the
 * page reloads, and the server shows the sign-in.
 */
export function AdminIdle({ idleSeconds }: { idleSeconds: number }) {
  useEffect(() => {
    let lastActivity = Date.now(), lastPing = Date.now();
    const active = () => {
      lastActivity = Date.now();
      if (Date.now() - lastPing > 60_000) { lastPing = Date.now(); fetch("/admin/ping", { cache: "no-store" }).catch(() => {}); }
    };
    const events = ["keydown", "pointerdown", "pointermove", "scroll", "wheel"] as const;
    events.forEach((e) => window.addEventListener(e, active, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity > idleSeconds * 1000) window.location.assign("/admin?expired=1");
    }, 15_000);
    return () => { events.forEach((e) => window.removeEventListener(e, active)); window.clearInterval(timer); };
  }, [idleSeconds]);
  return null;
}
