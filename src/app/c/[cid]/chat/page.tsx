import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { Field } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import Link from "next/link";
import { createGroup } from "./actions";

export const metadata = { title: "Chat" };

export default async function ChatHome({ params, searchParams }: { params: Promise<{ cid: string }>; searchParams: Promise<{ new?: string; q?: string }> }) {
  const { cid } = await params;
  const sp = await searchParams;
  const { supabase, user } = await getCtx(cid);

  if (sp.new === "group") {
    const { data: people } = await supabase.from("employee_directory").select("user_id, full_name").eq("company_id", cid).not("user_id", "is", null).neq("user_id", user.id).order("first_name");
    return (
      <div className="mx-auto w-full max-w-md p-6">
        <h2 className="mb-4 text-lg font-semibold">New group</h2>
        <ActionForm action={createGroup.bind(null, cid)} className="space-y-4">
          <Field label="Group name"><input className="input" name="name" required autoFocus /></Field>
          <Field label="Members" hint="Ctrl / ⌘ to pick several"><select className="input h-64" name="users" multiple>{(people ?? []).map((p) => <option key={p.user_id} value={p.user_id!}>{p.full_name}</option>)}</select></Field>
          <SubmitButton className="btn-primary w-full">Create group</SubmitButton>
        </ActionForm>
      </div>
    );
  }

  // COMMS-06 search across messages and file names in my conversations (RLS)
  const results = sp.q ? (await supabase.from("messages").select("id, conversation_id, body, attachment_name, created_at")
    .eq("company_id", cid).eq("deleted", false).textSearch("search", sp.q.split(/\s+/).filter(Boolean).map((w) => `${w}:*`).join(" & ")).order("created_at", { ascending: false }).limit(50)).data : null;

  return (
    <div className="flex flex-1 flex-col p-6">
      <form className="mx-auto mb-6 flex w-full max-w-lg gap-2"><input name="q" defaultValue={sp.q} placeholder="Search messages and files" className="input" /><button className="btn-secondary">Search</button></form>
      {results ? (
        <ul className="mx-auto w-full max-w-lg divide-y divide-slate-100">
          {results.map((m) => <li key={m.id} className="py-2"><Link href={`/c/${cid}/chat/${m.conversation_id}#m-${m.id}`} className="block text-sm hover:underline">{m.body ?? `📎 ${m.attachment_name}`}</Link><span className="text-xs text-slate-500">{fmtDateTime(m.created_at)}</span></li>)}
          {!results.length && <li className="py-6 text-center text-sm text-slate-500">No messages found.</li>}
        </ul>
      ) : (
        <div className="m-auto text-center text-sm text-slate-500">
          <div className="text-base font-medium text-slate-700">Team chat</div>
          Pick a conversation, or press + to message a colleague. Department and project channels are created automatically.
        </div>
      )}
    </div>
  );
}
