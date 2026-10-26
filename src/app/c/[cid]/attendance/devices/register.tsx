"use client";
import { useActionState } from "react";
import { SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { registerDevice } from "../actions";

export function RegisterDevice({ cid, branches, endpoint }: { cid: string; branches: { id: string; name: string }[]; endpoint: string }) {
  const [state, action] = useActionState(registerDevice.bind(null, cid), null);
  const secrets = state?.data as { hmac_secret: string; api_key: string } | undefined;
  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <Field label="Name"><input className="input" name="name" placeholder="Front door" required /></Field>
      <Field label="Serial number"><input className="input" name="serial_no" required /></Field>
      <Field label="Branch"><select className="input" name="branch_id"><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
      <Field label="Vendor"><select className="input" name="vendor">{["eSSL", "ZKTeco", "Matrix", "Realtime", "Other"].map((v) => <option key={v}>{v}</option>)}</select></Field>
      <Field label="Model"><input className="input" name="model" /></Field>
      <Field label="Device IP"><input className="input" name="ip" /></Field>
      <Field label="Mode"><select className="input" name="mode"><option value="push">Push (device calls our webhook)</option><option value="pull">Pull (sync agent)</option></select></Field>
      <div className="flex items-end"><SubmitButton>Register</SubmitButton></div>
      {state?.error && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 sm:col-span-2">{state.error}</p>}
      {secrets && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm sm:col-span-2">
          <p className="font-medium text-amber-900">{state?.ok}</p>
          <div>Endpoint: <code className="break-all">{endpoint}</code></div>
          <div>HMAC secret: <code className="break-all">{secrets.hmac_secret}</code></div>
          <div>API key: <code className="break-all">{secrets.api_key}</code></div>
        </div>
      )}
    </form>
  );
}
