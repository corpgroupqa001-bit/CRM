import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

// ATT-25 / NFR-09 file retention, once a day by Vercel Cron (vercel.json) with
// "Authorization: Bearer <CRON_SECRET>": work selfies older than the company's retention period
// (default 90 days) and documents of companies purged 90 days after archiving. The database lists
// what is due (retention_storage_due, migration 0029); files are deleted through the Storage API.
export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  let removed = 0;
  // a few batches per run; whatever is left goes the next day
  for (let i = 0; i < 5; i++) {
    const { data: due, error } = await db.rpc("retention_storage_due", { p_limit: 500 });
    if (error) return NextResponse.json({ error: error.message, removed }, { status: 500 });
    const rows = (due ?? []) as { bucket: string; name: string }[];
    if (!rows.length) break;
    for (const bucket of new Set(rows.map((r) => r.bucket))) {
      const paths = rows.filter((r) => r.bucket === bucket).map((r) => r.name);
      const { error: rmError } = await db.storage.from(bucket).remove(paths);
      if (rmError) return NextResponse.json({ error: rmError.message, removed }, { status: 500 });
      removed += paths.length;
    }
  }
  return NextResponse.json({ removed });
}
