"use client";
import { useCallback, useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { refreshMfaFlag } from "@/app/(auth)/actions";

type Factor = { id: string; friendly_name?: string; status: string; factor_type: string };

// AUTH-14: TOTP authenticator app (Google Authenticator, Microsoft Authenticator, Authy…)
export function TwoFactor() {
  const supabase = createClient();
  const [factors, setFactors] = useState<Factor[]>([]);
  const [enroll, setEnroll] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});

  const load = useCallback(async () => {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.all ?? []) as Factor[]);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const verified = factors.filter((f) => f.status === "verified" && f.factor_type === "totp");

  async function start() {
    setMsg({});
    // clear half-finished enrolments first
    for (const f of factors.filter((x) => x.status !== "verified")) await supabase.auth.mfa.unenroll({ factorId: f.id });
    const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp", friendlyName: `Authenticator ${new Date().toISOString().slice(0, 10)}` });
    if (error) return setMsg({ err: error.message });
    setEnroll({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }
  async function verifyEnrolment() {
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: enroll!.id, code: code.trim() });
    if (error) return setMsg({ err: "That code didn't match. Check the time on your phone and try again." });
    setEnroll(null); setCode(""); setMsg({ ok: "Two-factor authentication is on. You'll be asked for a code when you sign in." });
    await refreshMfaFlag();
    load();
  }
  async function remove(id: string) {
    if (!window.confirm("Turn off two-factor authentication?")) return;
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    if (error) return setMsg({ err: error.message.includes("aal2") ? "Sign out and back in with your code first, then try again." : error.message });
    setMsg({ ok: "Two-factor authentication turned off." });
    await refreshMfaFlag();
    load();
  }

  return (
    <div className="space-y-4">
      {verified.length ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-emerald-50 px-2 py-1 text-sm font-medium text-emerald-700"><ShieldCheck className="h-4 w-4" /> On</span>
          {verified.map((f) => <button key={f.id} onClick={() => remove(f.id)} className="btn-secondary btn-sm">Turn off</button>)}
        </div>
      ) : !enroll ? (
        <button onClick={start} className="btn-primary">Set up authenticator app</button>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={enroll.qr} alt="QR code for your authenticator app" className="h-40 w-40 rounded-lg border border-slate-200 bg-white p-2" />
          <div className="space-y-3 text-sm">
            <p>1. Scan the QR code with your authenticator app, or enter this key: <code className="break-all rounded bg-slate-100 px-1.5 py-0.5 text-xs">{enroll.secret}</code></p>
            <p>2. Enter the 6-digit code it shows:</p>
            <div className="flex gap-2">
              <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" className="input w-36 text-center tracking-[0.3em]" placeholder="000000" />
              <button onClick={verifyEnrolment} disabled={code.length !== 6} className="btn-primary">Turn on</button>
              <button onClick={() => setEnroll(null)} className="btn-ghost">Cancel</button>
            </div>
          </div>
        </div>
      )}
      {msg.err && <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{msg.err}</p>}
      {msg.ok && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{msg.ok}</p>}
    </div>
  );
}
