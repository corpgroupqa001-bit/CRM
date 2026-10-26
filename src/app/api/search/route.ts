import { NextResponse } from "next/server";
import { requireApiUser } from "@/lib/auth/guard";

// X-06 global search. Runs as the signed-in user, so RLS limits every result to what they may see.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cid = url.searchParams.get("company") ?? "";
  const q = (url.searchParams.get("q") ?? "").trim().replace(/[%,()]/g, " ");
  if (q.length < 2) return NextResponse.json({ results: [] });
  const auth = await requireApiUser();
  if (auth.error) return auth.error;
  const { supabase } = auth;

  const like = `%${q}%`;
  const [people, tasks, projects, messages] = await Promise.all([
    supabase.from("employee_directory").select("id, full_name, emp_code, designation, department").eq("company_id", cid)
      .or(`full_name.ilike.${like},emp_code.ilike.${like},email.ilike.${like}`).limit(6),
    supabase.from("tasks").select("id, title, status").eq("company_id", cid).ilike("title", like).limit(6),
    supabase.from("projects").select("id, name, client").eq("company_id", cid).or(`name.ilike.${like},client.ilike.${like}`).limit(5),
    supabase.from("messages").select("id, conversation_id, body").eq("company_id", cid).eq("deleted", false).ilike("body", like)
      .order("created_at", { ascending: false }).limit(5),
  ]);
  const base = `/c/${cid}`;
  const results = [
    ...(people.data ?? []).map((p) => ({ type: "Employee", title: p.full_name, sub: [p.emp_code, p.designation, p.department].filter(Boolean).join(" · "), href: `${base}/employees/${p.id}` })),
    ...(projects.data ?? []).map((p) => ({ type: "Project", title: p.name, sub: p.client ?? "", href: `${base}/projects/${p.id}` })),
    ...(tasks.data ?? []).map((t) => ({ type: "Task", title: t.title, sub: t.status.replace(/_/g, " "), href: `${base}/tasks/${t.id}` })),
    ...(messages.data ?? []).map((m) => ({ type: "Message", title: (m.body ?? "").slice(0, 90), sub: "Chat", href: `${base}/chat/${m.conversation_id}#m-${m.id}` })),
  ];
  return NextResponse.json({ results });
}
