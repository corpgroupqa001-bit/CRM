import { describe, expect, it } from "vitest";
import { createDb } from "./db";

describe("migrations", () => {
  it("apply cleanly and enable RLS on every public table", async () => {
    const db = await createDb();
    const r = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`);
    expect(r.rows.map((x) => x.relname)).toEqual([]);
  });
});
