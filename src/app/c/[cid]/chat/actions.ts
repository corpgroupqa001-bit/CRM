"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { attempt, must, str, type ActionState } from "@/lib/actions";

export async function openDm(cid: string, otherUserId: string) {
  const { supabase } = await getCtx(cid);
  const id = must(await supabase.rpc("open_dm", { p_company: cid, p_other: otherUserId })) as string;
  redirect(`/c/${cid}/chat/${id}`);
}

export async function createGroup(cid: string, _: ActionState, fd: FormData): Promise<ActionState> {
  let id = "";
  const r = await attempt(async () => {
    const { supabase } = await getCtx(cid);
    const name = str(fd, "name");
    if (!name) throw new Error("Give the group a name.");
    id = must(await supabase.rpc("create_group", { p_company: cid, p_name: name, p_users: fd.getAll("users").map(String) })) as string;
  });
  if (r?.error) return r;
  revalidatePath(`/c/${cid}/chat`, "layout");
  redirect(`/c/${cid}/chat/${id}`);
}

export async function toggleMute(cid: string, convId: string, muted: boolean) {
  const { supabase, user } = await getCtx(cid);
  await supabase.from("conversation_members").update({ muted }).eq("conversation_id", convId).eq("user_id", user.id);
  revalidatePath(`/c/${cid}/chat`, "layout");
}

export async function leaveGroup(cid: string, convId: string) {
  const { supabase, user } = await getCtx(cid);
  await supabase.from("conversation_members").delete().eq("conversation_id", convId).eq("user_id", user.id);
  revalidatePath(`/c/${cid}/chat`, "layout");
  redirect(`/c/${cid}/chat`);
}
