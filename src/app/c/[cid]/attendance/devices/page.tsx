import { getCtx, requirePerm } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Badge, Card, PageHeader, Table } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { AttendanceTabs } from "../tabs";
import { deleteDevice, importPunches, mapException, saveAllowlist } from "../actions";
import { RegisterDevice } from "./register";

export const metadata = { title: "Devices" };

export default async function Devices({ params }: { params: Promise<{ cid: string }> }) {
  const { cid } = await params;
  const ctx = await getCtx(cid);
  requirePerm(ctx, "attendance.manage");
  const { supabase, perms } = ctx;
  const [{ data: devices }, { data: branches }, { data: unmapped }, { data: people }] = await Promise.all([
    supabase.from("devices").select("*, branches(name)").eq("company_id", cid).order("name"),
    supabase.from("branches").select("id, name").eq("company_id", cid),
    supabase.from("punches_raw").select("device_id, device_user_id, punched_at").eq("company_id", cid).is("employee_id", null).order("punched_at", { ascending: false }).limit(1000),
    supabase.from("employee_directory").select("id, full_name, emp_code").eq("company_id", cid).in("status", ["active", "notice"]).order("first_name"),
  ]);
  // exceptions queue grouped by device + device user ID
  const queue = new Map<string, { device_id: string; device_user_id: string; count: number; last: string }>();
  for (const p of unmapped ?? []) {
    const k = `${p.device_id}|${p.device_user_id}`;
    const q = queue.get(k);
    if (q) q.count++; else queue.set(k, { device_id: p.device_id, device_user_id: p.device_user_id, count: 1, last: p.punched_at });
  }
  const deviceName = new Map((devices ?? []).map((d) => [d.id, d.name]));
  const endpoint = `${process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""}/functions/v1/punch-webhook`;

  return (
    <>
      <PageHeader title="Devices & exceptions" />
      <AttendanceTabs cid={cid} active="devices" perms={perms} />
      <div className="space-y-6">
        <Card title={`Exceptions queue (${queue.size})`} pad={false}>
          <Table head={["Device", "Device user ID", "Punches waiting", "Latest", "Map to employee"]} empty="No unmapped punches. 🎉">
            {[...queue.values()].map((q) => (
              <tr key={`${q.device_id}|${q.device_user_id}`}>
                <td className="td">{deviceName.get(q.device_id) ?? "—"}</td><td className="td font-mono">{q.device_user_id}</td>
                <td className="td">{q.count}</td><td className="td">{fmtDateTime(q.last)}</td>
                <td className="td">
                  <ActionForm action={mapException.bind(null, cid)} className="flex gap-2">
                    <input type="hidden" name="device_id" value={q.device_id} /><input type="hidden" name="device_user_id" value={q.device_user_id} />
                    <select name="employee_id" className="input w-56 h-8" required><option value="">Choose…</option>
                      {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.full_name} ({p.emp_code})</option>)}</select>
                    <SubmitButton className="btn-secondary btn-sm">Map</SubmitButton>
                  </ActionForm>
                </td>
              </tr>
            ))}
          </Table>
        </Card>

        <Card title="Registered devices" pad={false}>
          <Table head={["Device", "Serial", "Branch", "Vendor / model", "Mode", "Status", "Last sync", "IP allow-list", ""]}>
            {(devices ?? []).map((d) => (
              <tr key={d.id}>
                <td className="td font-medium">{d.name}</td><td className="td font-mono text-xs">{d.serial_no}</td>
                <td className="td">{(d.branches as { name: string } | null)?.name ?? "—"}</td><td className="td">{[d.vendor, d.model].filter(Boolean).join(" ")}</td>
                <td className="td">{d.mode}</td><td className="td"><Badge value={d.status} /></td><td className="td">{fmtDateTime(d.last_seen_at)}</td>
                <td className="td">{perms.has("settings.manage") ? (
                  <ActionForm action={saveAllowlist.bind(null, cid)} className="flex gap-1">
                    <input type="hidden" name="id" value={d.id} />
                    <input name="ip_allowlist" defaultValue={(d.ip_allowlist ?? []).join(", ")} placeholder="any" className="input w-36 h-8 text-xs" />
                    <SubmitButton className="btn-ghost btn-sm">Save</SubmitButton>
                  </ActionForm>) : (d.ip_allowlist ?? []).join(", ") || "any"}</td>
                <td className="td text-right">{perms.has("settings.manage") && <form action={deleteDevice.bind(null, cid, d.id)}><button className="text-sm text-rose-600">Remove</button></form>}</td>
              </tr>
            ))}
          </Table>
        </Card>

        <div className="grid gap-6 lg:grid-cols-2">
          {perms.has("settings.manage") && <Card title="Register a device"><RegisterDevice cid={cid} branches={branches ?? []} endpoint={endpoint} /></Card>}
          <Card title="Import punches (CSV / Excel)">
            <p className="mb-3 text-sm text-slate-600">For devices without an API. Columns: <code className="rounded bg-slate-100 px-1">emp_code</code>, <code className="rounded bg-slate-100 px-1">timestamp</code> (YYYY-MM-DD HH:MM, local time).</p>
            <ActionForm action={importPunches.bind(null, cid)} className="space-y-3" resetOnSuccess>
              <input className="input" type="file" name="file" accept=".csv,.xlsx,.xls" required />
              <SubmitButton>Import</SubmitButton>
            </ActionForm>
          </Card>
          <Card title="How devices connect" className="lg:col-span-2">
            <div className="space-y-2 text-sm text-slate-600">
              <p><b>Push mode:</b> the device or vendor cloud POSTs each punch to <code className="break-all rounded bg-slate-100 px-1">{endpoint}</code> with header <code className="rounded bg-slate-100 px-1">x-device-serial</code> and either <code className="rounded bg-slate-100 px-1">x-signature</code> (HMAC-SHA256 of the body with the device secret) or <code className="rounded bg-slate-100 px-1">x-api-key</code>.</p>
              <p>Body: <code className="rounded bg-slate-100 px-1">{`{"punches":[{"device_user_id":"17","timestamp":"2026-10-22 09:02:00","direction":"in","verify_type":"fingerprint"}]}`}</code>. Duplicates are ignored; offline devices can resend everything on reconnect.</p>
              <p><b>Pull mode / LAN-only devices:</b> run the sync agent (<code className="rounded bg-slate-100 px-1">agent/sync-agent.mjs</code>) on a branch PC. It buffers punches locally and pushes them to the same endpoint.</p>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
