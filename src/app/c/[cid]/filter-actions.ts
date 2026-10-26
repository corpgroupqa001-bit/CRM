"use server";
import { revalidatePath } from "next/cache";
import { getCtx } from "@/lib/context";
import { attempt, must, str, type ActionState } from "@/lib/actions";

// COM-14 saved filters per user and list page
export async function saveFilter(cid: string, page: string, _: ActionState, fd: FormData): Promise<ActionState> {
  return attempt(async () => {
    const { supabase, user } = await getCtx(cid);
    const name = str(fd, "name");
    if (!name) throw new Error("Name the filter.");
    must(await supabase.from("saved_filters").insert({ user_id: user.id, company_id: cid, page, name, query: str(fd, "query") ?? "" }));
    revalidatePath(`/c/${cid}/${page}`);
    return { ok: "Filter saved." };
  });
}

export async function deleteFilter(cid: string, page: string, id: string) {
  const { supabase } = await getCtx(cid);
  await supabase.from("saved_filters").delete().eq("id", id);
  revalidatePath(`/c/${cid}/${page}`);
}
