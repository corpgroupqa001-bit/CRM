import { NextResponse } from "next/server";
import { pushToUser } from "@/lib/push";

export const runtime = "nodejs";

// Called by a Supabase Database Webhook on INSERT into public.notifications
// (header x-webhook-secret: PUSH_WEBHOOK_SECRET). Delivers the notification as web push.
export async function POST(req: Request) {
  const secret = process.env.PUSH_WEBHOOK_SECRET;
  if (!secret || req.headers.get("x-webhook-secret") !== secret) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const payload = await req.json() as { type?: string; record?: Parameters<typeof pushToUser>[0] };
  if (payload.type !== "INSERT" || !payload.record) return NextResponse.json({ skipped: true });
  return NextResponse.json(await pushToUser(payload.record));
}
