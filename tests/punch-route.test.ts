// POST /api/attendance/punch (ATT-04 / ATT-05 / ATT-07): the real route handler, with the
// service-role Supabase client swapped for one that runs the real SQL in PGlite.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { addAdmin, asOwnerUser, createDb, createUser } from "./db";

let db: PGlite;

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: string) => ({
          maybeSingle: async () => {
            const r = await db.query(`select ${cols} from public.${table} where ${col} = $1 limit 1`, [val]);
            return { data: r.rows[0] ?? null, error: null };
          },
        }),
      }),
    }),
    rpc: async (fn: string, args: Record<string, unknown>) => {
      const keys = Object.keys(args);
      try {
        const r = await db.query<{ v: unknown }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) as v`, Object.values(args));
        return { data: r.rows[0].v, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message, code: (e as { code?: string }).code } };
      }
    },
  }),
}));

const { POST } = await import("@/app/api/attendance/punch/route");

let device: { device_id: string; hmac_secret: string; api_key: string };
let emp: string;
const SERIAL = "ZK-0001";

const post = (body: unknown, headers: Record<string, string> = { "x-api-key": device.api_key }) =>
  POST(new Request("http://localhost/api/attendance/punch", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
const count = async () => Number((await db.query<{ n: string }>(`select count(*) n from punches_raw`)).rows[0].n);

beforeAll(async () => {
  db = await createDb();
  const owner = await createUser(db, "owner@acme.in");
  const [{ id: cid }] = (await asOwnerUser(db, owner, () => db.query<{ id: string }>(
    `insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner]))).rows;
  const admin = await addAdmin(db);   // devices: the Admin (BRD §5.3; the Super Admin, 0055)
  emp = (await asOwnerUser(db, admin, () => db.query<{ id: string }>(
    `insert into employees (company_id, first_name, email, date_of_joining) values ($1, 'Ravi', 'ravi@acme.in', '2025-01-01') returning id`, [cid]))).rows[0].id;
  device = (await asOwnerUser(db, admin, () => db.query<{ r: typeof device }>(
    `select register_device($1, null, 'Gate', $2, 'ZKTeco', 'K40', null, 'push') as r`, [cid, SERIAL]))).rows[0].r;
  await asOwnerUser(db, admin, () => db.query(`select map_device_user($1, '17', $2)`, [device.device_id, emp]));
});

describe("POST /api/attendance/punch", () => {
  const punch = { device_id: SERIAL, device_user_id: "17", timestamp: "2026-10-22T09:02:00+05:30", direction: "in" };

  it("stores a new punch raw (ATT-04) and returns 201", async () => {
    const res = await post(punch);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: "ok", duplicate: false, mapped: true });
    const [row] = (await db.query<Record<string, unknown>>(`select * from punches_raw`)).rows;
    expect(row).toMatchObject({ device_id: device.device_id, device_user_id: "17", employee_id: emp, direction: "in", source: "device" });
    expect(new Date(row.punched_at as string).toISOString()).toBe("2026-10-22T03:32:00.000Z");
  });

  it("ignores the exact same punch and returns 200 (ATT-05)", async () => {
    const res = await post(punch);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", duplicate: true });
    expect(await count()).toBe(1);
  });

  it("treats the same instant in another offset, or by device UUID, as the same punch", async () => {
    expect((await post({ ...punch, timestamp: "2026-10-22T03:32:00Z" })).status).toBe(200);
    expect((await post({ ...punch, device_id: device.device_id, timestamp: "2026-10-22 09:02:00" })).status).toBe(200);
    expect(await count()).toBe(1);
  });

  it("stores a different timestamp or device user as a new punch", async () => {
    expect((await post({ ...punch, timestamp: "2026-10-22T18:05:00+05:30", direction: "out" })).status).toBe(201);
    expect((await post({ ...punch, device_user_id: "99" })).status).toBe(201);   // unmapped → exceptions queue
    const [u] = (await db.query<{ employee_id: string | null }>(`select employee_id from punches_raw where device_user_id = '99'`)).rows;
    expect(u.employee_id).toBeNull();
  });

  it("accepts an HMAC signature of the raw body instead of the API key", async () => {
    const body = JSON.stringify({ ...punch, timestamp: "2026-10-21T09:00:00+05:30" });
    const sig = createHmac("sha256", device.hmac_secret).update(body).digest("hex");
    expect((await post(body, { "x-signature": sig })).status).toBe(201);
    expect((await post(body, { "x-signature": "0".repeat(64) })).status).toBe(401);
  });

  it("rejects missing or wrong credentials and unknown devices with 401, storing nothing", async () => {
    const before = await count();
    const fresh = { ...punch, timestamp: "2026-10-20T09:00:00+05:30" };
    expect((await post(fresh, {})).status).toBe(401);
    expect((await post(fresh, { "x-api-key": "wrong" })).status).toBe(401);
    expect((await post({ ...fresh, device_id: "NO-SUCH-DEVICE" })).status).toBe(401);
    expect(await count()).toBe(before);
  });

  it.each([
    ["not JSON", "{oops"],
    ["missing device_user_id", { device_id: SERIAL, timestamp: "2026-10-22T09:00:00Z" }],
    ["bad timestamp", { ...punch, timestamp: "yesterday" }],
    ["bad direction", { ...punch, direction: "sideways" }],
    ["future timestamp", { ...punch, timestamp: new Date(Date.now() + 3600_000).toISOString() }],
  ])("returns 400 for %s", async (_, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
  });

  it("raw punches stay immutable", async () => {
    await expect(db.query(`update punches_raw set punched_at = now()`)).rejects.toThrow(/immutable/);
  });
});
