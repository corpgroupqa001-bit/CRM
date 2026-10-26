"use client";
import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookieOptionsFor, scopedCookieOptions, type SessionScope } from "./scopes";

// @supabase/ssr keeps ONE cached browser client regardless of options, so the admin portal's client
// is cached separately here (isSingleton: false); otherwise moving between /admin and a company page
// without a full reload could reuse the other session's client.
let adminClient: SupabaseClient | null = null;

/** scope "admin" = the /admin portal's own session (cookie on path /admin) */
export function createClient(scope: SessionScope = "company"): SupabaseClient {
  if (scope === "admin") {
    adminClient ??= createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      cookieOptions: cookieOptionsFor("admin"), isSingleton: false,
      // written by hand so a token refresh in the browser also keeps them session cookies (no lifetime)
      cookies: {
        getAll: () => document.cookie.split(";").map((c) => c.trim()).filter(Boolean).map((c) => {
          const i = c.indexOf("=");
          return { name: decodeURIComponent(c.slice(0, i)), value: decodeURIComponent(c.slice(i + 1)) };
        }),
        setAll: (list) => list.forEach(({ name, value, options }) => {
          const o = scopedCookieOptions("admin", options);
          document.cookie = [`${encodeURIComponent(name)}=${encodeURIComponent(value)}`, `Path=${o.path ?? "/admin"}`, `SameSite=${o.sameSite === "strict" ? "Strict" : "Lax"}`,
            ...(o.secure ? ["Secure"] : []), ...(o.maxAge === 0 ? ["Max-Age=0"] : [])].join("; ");
        }),
      },
    });
    return adminClient;
  }
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
