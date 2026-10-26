import Link from "next/link";
import { Bookmark, X } from "lucide-react";
import { getCtx } from "@/lib/context";
import { ActionForm, SubmitButton } from "@/components/action-form";
import { deleteFilter, saveFilter } from "@/app/c/[cid]/filter-actions";

/** Chips for the user's saved filters on a list page, plus "save current filter". */
export async function SavedFilters({ cid, page, query }: { cid: string; page: string; query: string }) {
  const { supabase, user } = await getCtx(cid);
  const { data } = await supabase.from("saved_filters").select("id, name, query").eq("user_id", user.id).eq("company_id", cid).eq("page", page).order("created_at");
  const clean = query.replace(/(^|&)page=\d+/, "");
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {(data ?? []).map((f) => (
        <span key={f.id} className={`inline-flex items-center gap-1 rounded-full border py-1 pl-3 pr-1 text-xs font-medium ${f.query === clean ? "border-brand-300 bg-brand-50 text-brand-700" : "border-slate-200 bg-white text-slate-600"}`}>
          <Link href={`/c/${cid}/${page}?${f.query}`} className="hover:underline">{f.name}</Link>
          <form action={deleteFilter.bind(null, cid, page, f.id)}><button className="rounded-full p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Delete ${f.name}`}><X className="h-3 w-3" /></button></form>
        </span>
      ))}
      {clean && (
        <details className="relative">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs font-medium text-slate-500 hover:border-slate-400 hover:text-slate-700">
            <Bookmark className="h-3 w-3" /> Save this filter
          </summary>
          <div className="absolute left-0 z-20 mt-2 w-64 rounded-xl border border-slate-200 bg-white p-3 shadow-(--shadow-pop)">
            <ActionForm action={saveFilter.bind(null, cid, page)} className="space-y-2" resetOnSuccess>
              <input type="hidden" name="query" value={clean} />
              <input name="name" className="input" placeholder="e.g. Sales, Hyderabad" required />
              <SubmitButton className="btn-primary btn-sm w-full">Save</SubmitButton>
            </ActionForm>
          </div>
        </details>
      )}
    </div>
  );
}
