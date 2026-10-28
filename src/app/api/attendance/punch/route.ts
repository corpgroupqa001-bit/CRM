import { NextResponse } from "next/server";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Biometric punch endpoint, one punch per request (BRD ATT-04 / ATT-05).
//
//   POST /api/attendance/punch
//   { "device_id": "<device UUID or serial number>", "device_user_id": "17",
//     "timestamp": "2026-10-23T09:02:00+05:30", "direction": "in" }
//
// Authentication (ATT-07): header x-api-key (the device's key) or x-signature (hex HMAC-SHA256
// of the raw body with the device's secret). Both are issued when the device is registered.
//
// Storage (ATT-04): the punch is written raw and immutable to public.punches_raw by
// ingest_punches(), which also checks the credentials and the device's IP allow-list.
// Idempotency (ATT-05): punches_raw is unique on (device, device user, timestamp). Sending the
// same punch again inserts nothing and returns 200 { duplicate: true }; a new punch returns 201.
// An offline device can therefore resend its whole backlog safely when it reconnects.

const Punch = z.object({
  device_id: z.string().trim().min(1).max(100),
  device_user_id: z.string().trim().min(1).max(50),
  // ISO 8601; without an offset it is read as the company's local time (Asia/Kolkata by default)
  timestamp: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/, "timestamp must be ISO 8601, e.g. 2026-10-23T09:02:00+05:30"),
  direction: z.enum(["in", "out"]).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 10_000) return bad("Body too large", 413);

  let json: unknown;
  try { json = JSON.parse(raw); } catch { return bad("Body must be JSON"); }
  const parsed = Punch.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid punch", issues: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, { status: 400 });
  }
  const p = parsed.data;

  // reject clock errors: a punch can be old (back-fill) but not more than 10 minutes in the future
  const hasOffset = /(Z|[+-]\d{2}:?\d{2})$/.test(p.timestamp);
  const when = new Date(hasOffset ? p.timestamp : `${p.timestamp.replace(" ", "T")}+05:30`);
  if (Number.isNaN(when.getTime())) return bad("timestamp is not a valid date");
  if (when.getTime() > Date.now() + 10 * 60_000) return bad("timestamp is in the future; check the device clock");

  // device_id may be the device's UUID or its serial number
  const db = createAdminClient();
  const { data: device } = await (UUID.test(p.device_id)
    ? db.from("devices").select("serial_no").eq("id", p.device_id).maybeSingle()
    : db.from("devices").select("serial_no").eq("serial_no", p.device_id).maybeSingle());
  if (!device) return bad("unauthorized", 401);   // same answer as bad credentials: don't reveal which devices exist

  const { data, error } = await db.rpc("ingest_punches", {
    p_serial: device.serial_no,
    p_body: raw,                                   // the exact bytes, so an HMAC signature verifies
    p_signature: req.headers.get("x-signature"),
    p_api_key: req.headers.get("x-api-key"),
    p_ip: (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null,
  });
  if (error) {
    // NFR-12: a registered device whose punches can't be stored is recorded and alerted (hourly at most)
    const rejected = error.code === "28000";
    await db.rpc("record_ingest_failure", { p_serial: device.serial_no,
      p_detail: rejected ? "the device's key, signature or IP address was rejected" : error.message });
    if (rejected) return bad("unauthorized", 401);
    console.error("[punch] ingest failed", p.device_id, error.message);
    return bad("Could not store the punch", 500);
  }
  const r = data as { accepted: number; duplicates: number; unmapped: number };
  if (r.accepted === 0) return NextResponse.json({ status: "ok", duplicate: true }, { status: 200 });
  return NextResponse.json({ status: "ok", duplicate: false, mapped: r.unmapped === 0 }, { status: 201 });
}
