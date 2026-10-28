// Supabase Edge Function: biometric device webhook (ATT-02/05/07).
// Deploy:  npx supabase functions deploy punch-webhook --no-verify-jwt
// Devices authenticate with x-device-serial + x-signature (HMAC-SHA256 of the raw body) or x-api-key;
// verification, IP allow-list and idempotent insert all happen in public.ingest_punches().
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return Response.json({ error: "POST only" }, { status: 405 });
  const serial = req.headers.get("x-device-serial");
  if (!serial) return Response.json({ error: "x-device-serial header is required" }, { status: 400 });
  const body = await req.text();
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || null;
  const { data, error } = await db.rpc("ingest_punches", {
    p_serial: serial, p_body: body, p_signature: req.headers.get("x-signature"),
    p_api_key: req.headers.get("x-api-key"), p_ip: ip,
  });
  if (error) {
    const auth = error.code === "28000";
    console.error("ingest failed", serial, error.message);
    // NFR-12: recorded and alerted to HR and the Company Admin (hourly at most); unknown serials are ignored
    await db.rpc("record_ingest_failure", { p_serial: serial,
      p_detail: auth ? "the device's key, signature or IP address was rejected" : error.message });
    return Response.json({ error: auth ? "unauthorized" : error.message }, { status: auth ? 401 : 400 });
  }
  return Response.json(data);
});
