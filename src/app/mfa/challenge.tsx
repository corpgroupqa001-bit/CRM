"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { SessionScope } from "@/lib/supabase/scopes";

export function MfaChallenge({ next, scope = "company" }: { next: string; scope?: SessionScope }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const supabase = createClient(scope);
    const { data } = await supabase.auth.mfa.listFactors();
    const factor = data?.totp?.[0];
    if (!factor) { router.replace(next); return; }
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) { setErr("That code didn't match. Try the newest code."); setBusy(false); return; }
    router.replace(next);
    router.refresh();
  }
  return (
    <form onSubmit={submit} className="mt-6 space-y-4">
      <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} autoFocus inputMode="numeric" autoComplete="one-time-code"
        className="input h-12 text-center text-2xl tracking-[0.5em]" placeholder="••••••" />
      {err && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{err}</p>}
      <button className="btn-primary w-full" disabled={code.length !== 6 || busy}>{busy ? "Checking…" : "Verify"}</button>
    </form>
  );
}
