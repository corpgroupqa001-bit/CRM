import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/guard";

// Save (POST) or remove (DELETE) this browser's push subscription for the signed-in user.
export async function POST(req: Request) {
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase, user } = auth;
  const sub = await req.json() as { endpoint: string; keys: { p256dh: string; auth: string } };
  if (!sub?.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) return NextResponse.json({ error: "Invalid subscription" }, { status: 400 });
  await supabase.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
  const { error } = await supabase.from("push_subscriptions").insert({ user_id: user.id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase } = auth;
  const { endpoint } = await req.json() as { endpoint: string };
  await supabase.from("push_subscriptions").delete().eq("endpoint", endpoint);
  return NextResponse.json({ ok: true });
}
