import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { cookieOptionsFor, scopedCookieOptions, type SessionScope } from "./scopes";

/** Supabase client acting as the signed-in user (RLS applies). scope "admin" = the /admin portal's own session. */
export async function createClient(scope: SessionScope = "company") {
  const cookieStore = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: cookieOptionsFor(scope),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (list) => {
        try {
          list.forEach(({ name, value, options }) => cookieStore.set(name, value, scopedCookieOptions(scope, options)));
        } catch {
          // called from a Server Component; middleware refreshes the session instead
        }
      },
    },
  });
}
