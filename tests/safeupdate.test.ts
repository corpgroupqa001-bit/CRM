// Hosted Supabase refuses DELETE / UPDATE without a WHERE clause on API requests (safeupdate), which the
// test database doesn't enforce. No database function may contain one (0032 fixed run_payroll).
import { expect, it } from "vitest";
import { createDb } from "./db";

it("no function deletes or updates without a WHERE clause", async () => {
  const db = await createDb();
  const { rows } = await db.query<{ name: string; def: string }>(
    `select p.proname as name, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind = 'f'`);
  const offenders: string[] = [];
  for (const { name, def } of rows) {
    const body = def.replace(/--[^\n]*/g, "").replace(/'(?:[^']|'')*'/g, "''");   // comments and quoted text out
    for (const stmt of body.split(";")) {
      const s = stmt.replace(/\s+/g, " ").trim();
      if (/\b(delete from|update [\w.]+ set)\b/i.test(s) && !/\bwhere\b/i.test(s.slice(s.search(/\b(delete from|update [\w.]+ set)\b/i)))) offenders.push(`${name}: ${s.slice(0, 80)}`);
    }
  }
  expect(offenders).toEqual([]);
}, 120000);
