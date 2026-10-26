"use client";
import { useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import type { SessionScope } from "@/lib/supabase/scopes";

/**
 * Keeps an open tab honest about who is signed in. A browser holds one session per site address, so
 * signing in as someone else (or signing out) in another tab changes the session for every tab. When
 * this tab comes back into view, or every few seconds, the session in the browser is compared with the
 * account this page was rendered for: signed out → sign-in page, different account → reload, so the
 * page never shows one person while acting as another. The server checks every request anyway.
 */
export function SessionGuard({ userId, scope = "company", signInPath }: { userId: string; scope?: SessionScope; signInPath?: string }) {
  useEffect(() => {
    const supabase = createClient(scope);
    let stopped = false;
    const check = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const { data } = await supabase.auth.getSession();
      const current = data.session?.user.id ?? null;
      if (current === userId) return;
      stopped = true;
      if (!current) window.location.assign(signInPath ?? `/login?next=${encodeURIComponent(window.location.pathname)}`);
      else window.location.reload();
    };
    const timer = window.setInterval(check, 5000);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [userId, scope, signInPath]);
  return null;
}
