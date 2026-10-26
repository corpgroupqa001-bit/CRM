import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// Device webhook (same contract as the Supabase Edge Function `punch-webhook`). Signature / API-key
// checks, IP allow-list and idempotent insert all happen inside ingest_punches() in the database.
export async function POST(req: Request) {
  const serial = req.headers.get("x-device-serial");
  if (!serial) return NextResponse.json({ error: "x-device-serial header is required" }, { status: 400 });
  const body = await req.text();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const { data, error } = await createAdminClient().rpc("ingest_punches", {
    p_serial: serial, p_body: body, p_signature: req.headers.get("x-signature"), p_api_key: req.headers.get("x-api-key"), p_ip: ip,
  });
  if (error) {
    const auth = error.code === "28000";
    return NextResponse.json({ error: auth ? "unauthorized" : error.message }, { status: auth ? 401 : 400 });
  }
  return NextResponse.json(data);
}
