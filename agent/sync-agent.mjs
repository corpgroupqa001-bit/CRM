#!/usr/bin/env node
// corpgroup.com on-site sync agent (ATT-02 pull mode, NFR-03 buffering).
// Runs on a branch PC next to LAN-only biometric devices. It reads new punches from a source,
// keeps them in a local queue file, and pushes them to the webhook with an HMAC signature.
// Nothing is lost while the internet or the platform is down: the queue is retried every minute.
//
// Usage:
//   DEVICE_SERIAL=SN-001 DEVICE_SECRET=<hmac secret> ENDPOINT=https://<project>.supabase.co/functions/v1/punch-webhook \
//   SOURCE_CSV=./punches.csv node agent/sync-agent.mjs
//
// SOURCE_CSV is the simplest source: most vendor desktop tools (eSSL eTimeTrackLite, ZKTeco ZKAccess…)
// can export or append attendance logs to CSV with columns: device_user_id,timestamp[,direction].
// Replace readSource() with a vendor SDK / protocol reader where one is available.
import { createHmac } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const { DEVICE_SERIAL, DEVICE_SECRET, ENDPOINT, SOURCE_CSV = "./punches.csv", QUEUE = "./agent-queue.json", STATE = "./agent-state.json" } = process.env;
if (!DEVICE_SERIAL || !DEVICE_SECRET || !ENDPOINT) {
  console.error("Set DEVICE_SERIAL, DEVICE_SECRET and ENDPOINT");
  process.exit(1);
}

const load = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
const save = (f, v) => writeFileSync(f, JSON.stringify(v));

function readSource() {
  if (!existsSync(SOURCE_CSV)) return [];
  const state = load(STATE, { line: 0 });
  const lines = readFileSync(SOURCE_CSV, "utf8").split(/\r?\n/).filter(Boolean);
  const fresh = lines.slice(state.line).filter((l) => !/^device_user_id/i.test(l)).map((l) => {
    const [device_user_id, timestamp, direction] = l.split(",").map((s) => s.trim());
    return { device_user_id, timestamp, direction: direction || undefined };
  });
  save(STATE, { line: lines.length });
  return fresh;
}

async function tick() {
  const queue = [...load(QUEUE, []), ...readSource()];
  save(QUEUE, queue);
  if (!queue.length) return;
  const batch = queue.slice(0, 500);
  const body = JSON.stringify({ punches: batch });
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-serial": DEVICE_SERIAL,
        "x-signature": createHmac("sha256", DEVICE_SECRET).update(body).digest("hex") },
      body,
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    save(QUEUE, queue.slice(batch.length));    // duplicates are ignored server-side, so a retry is safe
    console.log(new Date().toISOString(), "sent", batch.length, await res.json());
  } catch (err) {
    console.error(new Date().toISOString(), "push failed, will retry:", err.message, `(${queue.length} queued)`);
  }
}

await tick();
setInterval(tick, 60_000);
