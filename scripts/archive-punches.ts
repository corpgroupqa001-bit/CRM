// NFR-09 / free-tier storage: archive raw punches older than 13 months to Storage, then delete them.
//   pnpm archive:punches            (dry run: shows what would be archived)
//   pnpm archive:punches --apply
// Uses the service role from .env.local. Files land in the private "archives" bucket as
// {company_id}/punches-<YYYY-MM>.csv; daily attendance and payroll are not touched.
import { createClient } from "@supabase/supabase-js";
import { existsSync, readFileSync } from "node:fs";

if (existsSync(".env.local")) {
  for (const l of readFileSync(".env.local", "utf8").split("\n")) {
    const m = l.match(/^([A-Z_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
const apply = process.argv.includes("--apply");
const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

async function main() {
  const now = new Date();
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 13, 1)).toISOString();
  console.log(`Archiving punches before ${cutoff.slice(0, 10)}${apply ? "" : " (dry run)"}`);
  const { data: companies } = await db.from("companies").select("id, name");
  for (const c of companies ?? []) {
    const rows: Record<string, unknown>[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db.from("punches_raw").select("*").eq("company_id", c.id).lt("punched_at", cutoff).order("id").range(from, from + 999);
      if (error) throw error;
      rows.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (!rows.length) continue;
    const byMonth = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) { const k = String(r.punched_at).slice(0, 7); byMonth.set(k, [...(byMonth.get(k) ?? []), r]); }
    console.log(`${c.name}: ${rows.length} punch(es) in ${byMonth.size} month(s)`);
    if (!apply) continue;
    for (const [month, list] of byMonth) {
      const keys = Object.keys(list[0]);
      const csv = [keys.join(","), ...list.map((r) => keys.map((k) => JSON.stringify(r[k] ?? "")).join(","))].join("\n");
      const { error } = await db.storage.from("archives").upload(`${c.id}/punches-${month}.csv`, csv, { contentType: "text/csv", upsert: true });
      if (error) throw new Error(`Upload failed for ${c.name} ${month}: ${error.message} — nothing deleted`);
    }
    const { data: n, error } = await db.rpc("purge_punches_before", { p_company: c.id, p_before: cutoff });
    if (error) throw error;
    console.log(`  archived and removed ${n} punch(es)`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
