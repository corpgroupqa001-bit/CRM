// Decision of 29 Oct 2026 (migrations 0048, 0050, COMMS-07): the Chat menu badge counts chats with unread messages
// (not messages); opening a chat clears it; muted chats, your own messages and deleted messages don't count. 0049: deleting works.
import { beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { addMember, asUser, createDb, createUser } from "./db";

let db: PGlite, cid: string, cidB: string, owner: string, hr: string, admin: string, dm: string, group: string;
const sys = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await db.query<T>(sql, p)).rows;
const unread = (u: string, c = cid) => asUser(db, u, async () => (await db.query<{ n: number }>(`select chat_unread($1) n`, [c])).rows[0].n);
const send = (u: string, conv: string, body: string) => asUser(db, u, () => db.query(`insert into messages (conversation_id, company_id, body) values ($1, $2, $3)`, [conv, cid, body]));
const openChat = (u: string, conv: string) => asUser(db, u, () => db.query(`update conversation_members set last_read_at = now() + interval '1 second' where conversation_id = $1 and user_id = auth.uid()`, [conv]));

beforeAll(async () => {
  db = await createDb();
  owner = await createUser(db, "owner@corp.in");
  [{ id: cid }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Acme') returning id`, [owner]);
  [{ id: cidB }] = await sys<{ id: string }>(`insert into companies (owner_id, name) values ($1, 'Other') returning id`, [owner]);
  hr = await addMember(db, cid, "hr@corp.in", "hr");
  admin = await addMember(db, cid, "admin@corp.in", "company_admin");
  [{ open_dm: dm }] = await asUser(db, hr, async () => (await db.query<{ open_dm: string }>(`select open_dm($1, $2)`, [cid, owner])).rows);
  [{ create_group: group }] = await asUser(db, admin, async () => (await db.query<{ create_group: string }>(`select create_group($1, 'Leads', $2)`, [cid, [owner, hr]])).rows);
}, 120000);

describe("unread chat messages (menu badge)", () => {
  it("counts chats with messages from others, not messages; your own don't count", async () => {
    await send(hr, dm, "Hi Olivia");
    await send(hr, dm, "Are you free?");
    expect(await unread(owner)).toBe(1);     // two messages from one person = 1
    await send(admin, group, "Meeting at 3");
    expect(await unread(owner)).toBe(2);     // the DM and the group
    expect(await unread(hr)).toBe(1);        // only the group: her own two messages don't count
  });
  it("opening a chat clears that chat's count only", async () => {
    await openChat(owner, dm);
    expect(await unread(owner)).toBe(1);
    await openChat(owner, group);
    expect(await unread(owner)).toBe(0);
  });
  it("muted chats and deleted messages don't count", async () => {
    await asUser(db, owner, () => db.query(`update conversation_members set muted = true where conversation_id = $1 and user_id = auth.uid()`, [group]));
    await new Promise((r) => setTimeout(r, 1100));
    await send(admin, group, "muted for Olivia");
    expect(await unread(owner)).toBe(0);
    await send(hr, dm, "oops");
    expect(await unread(owner)).toBe(1);
    await asUser(db, hr, () => db.query(`update messages set deleted = true where body = 'oops'`));   // "Delete for everyone"
    expect(await unread(owner)).toBe(0);
  });
  it("Delete for everyone empties the message (0049); an empty message can't be sent", async () => {
    expect(await sys(`select body, attachment_path, deleted from messages where deleted`)).toEqual([{ body: null, attachment_path: null, deleted: true }]);
    await expect(asUser(db, hr, () => db.query(`insert into messages (conversation_id, company_id) values ($1, $2)`, [dm, cid]))).rejects.toThrow(/messages_check/);
    await expect(asUser(db, owner, () => db.query(`update messages set deleted = true where conversation_id = $1 and sender_id <> auth.uid()`, [dm])))
      .rejects.toThrow(/only change your own messages/);
  });
  it("is per company, and only your own count", async () => {
    await send(hr, dm, "one more");
    expect(await unread(owner, cidB)).toBe(0);
    expect(await unread(admin)).toBe(0);     // the admin isn't in the DM
    await expect(db.transaction(async (tx) => { await tx.query(`set local role anon`); await tx.query(`select chat_unread($1)`, [cid]); }))
      .rejects.toThrow(/permission denied/);
  });
});
