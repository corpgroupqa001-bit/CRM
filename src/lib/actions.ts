// Shared helpers for server actions
export type ActionState = { ok?: string; error?: string; data?: Record<string, unknown> } | null;

export const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};
export const numOrNull = (fd: FormData, k: string) => {
  const v = str(fd, k);
  return v === null ? null : Number(v);
};
export const bool = (fd: FormData, k: string) => fd.get(k) === "on" || fd.get(k) === "true";

/** Turn database / RLS errors into a message a user can act on. */
export function errorMessage(err: unknown): string {
  const e = err as { message?: string; code?: string; details?: string };
  if (e?.code === "42501" || /row-level security/i.test(e?.message ?? "")) return e.message && !/row-level/.test(e.message) ? e.message : "You don't have permission to do that.";
  if (e?.code === "23505") return "That already exists.";
  return e?.message ?? "Something went wrong.";
}

export async function attempt(fn: () => Promise<string | ActionState | void>): Promise<ActionState> {
  try {
    const r = await fn();
    if (typeof r === "string") return { ok: r };
    return r ?? { ok: "Saved." };
  } catch (err) {
    // let Next.js redirects and not-found propagate
    if (err && typeof err === "object" && "digest" in err && String((err as { digest: string }).digest).startsWith("NEXT_")) throw err;
    return { error: errorMessage(err) };
  }
}

/** throw on a Supabase { error } result */
export function must<T>(res: { data: T; error: unknown }): NonNullable<T> {
  if (res.error) throw res.error;
  return res.data as NonNullable<T>;
}
