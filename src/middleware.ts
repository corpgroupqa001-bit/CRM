import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { ADMIN_PATH, cookieOptionsFor, scopedCookieOptions, type SessionScope } from "@/lib/supabase/scopes";
import { ADMIN_ACTIVITY_COOKIE, adminActivityCookieOptions, adminIdleSeconds, adminSessionExpired, signAdminActivity } from "@/lib/auth/admin-idle";
import { COMPANY_LOCK_COOKIE, lockCookieOptions, readCompanyLock, signCompanyLock } from "@/lib/auth/company-lock";

// Session refresh (the @supabase/ssr pattern) plus the company lock, which records the company this
// session has open (switching needs no new sign-in, AUTH-11). No database queries here;
// role, company and two-factor checks run in the server layouts / pages / API routes that need them
// (src/lib/context.ts, src/lib/auth/guard.ts).
export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });
  // cookies refreshed by either session; re-applied whenever the response is rebuilt so neither is lost
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const client = (scope: SessionScope) => createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookieOptions: cookieOptionsFor(scope),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        list.forEach(({ name, value }) => request.cookies.set(name, value));
        pending.push(...list.map((c) => ({ ...c, options: scopedCookieOptions(scope, c.options) })));
        response = NextResponse.next({ request });
        pending.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });
  const supabase = client("company");

  // Verifies the access token (locally with asymmetric signing keys) and refreshes it when it is
  // about to expire; refreshed cookies are written to the response above.
  const { data } = await supabase.auth.getClaims();

  // The admin portal keeps its own session (cookie on path /admin); refresh it on its pages. The portal
  // shows its own sign-in, so it is not in the list below.
  const path = request.nextUrl.pathname;
  if (path === ADMIN_PATH || path.startsWith(`${ADMIN_PATH}/`)) {
    // admin portal: signed out after 15 minutes without an admin request (and on browser close)
    const admin = client("admin");
    const { data: ad } = await admin.auth.getClaims();
    const sid = ad?.claims?.session_id as string | undefined;
    if (sid) {
      const idle = await adminIdleSeconds(request.cookies.get(ADMIN_ACTIVITY_COOKIE)?.value, sid);
      if (adminSessionExpired(idle)) {
        await admin.auth.signOut({ scope: "local" });          // clears the admin cookies (setAll above) and revokes the session
        response.cookies.set(ADMIN_ACTIVITY_COOKIE, "", { ...adminActivityCookieOptions, maxAge: 0 });
        if (request.method === "GET" && path !== "/admin/ping") {
          const url = request.nextUrl.clone();
          url.pathname = ADMIN_PATH;
          url.search = "?expired=1";
          const redirect = NextResponse.redirect(url);
          response.cookies.getAll().forEach((c) => redirect.cookies.set(c));
          return redirect;
        }
        return response;                                       // a form post: the page's own check now finds no session
      }
      response.cookies.set(ADMIN_ACTIVITY_COOKIE, await signAdminActivity(sid), adminActivityCookieOptions);
    }
  }

  // Signed-out visitors to app pages go to sign-in with a way back. This reuses the result above;
  // it adds no request.
  const protectedPath = ["/c/", "/switch", "/owner", "/onboarding", "/set-password", "/account", "/mfa"].some((p) => path.startsWith(p));
  if (!data?.claims && protectedPath) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path)}`;
    return NextResponse.redirect(url);
  }

  const company = /^\/c\/([0-9a-f-]{36})(?:\/|$)/.exec(path)?.[1];
  const claims = data?.claims;
  if (company && claims?.session_id) {
    // AUTH-11: switching to another company the user belongs to needs no new sign-in. The lock only
    // records which company this session has open; membership is checked by the database (my_access)
    // on every page, so a company the user doesn't belong to still ends on /denied.
    const unlocked = await readCompanyLock(request.cookies.get(COMPANY_LOCK_COOKIE)?.value, claims.session_id);
    if (unlocked !== company) response.cookies.set(COMPANY_LOCK_COOKIE, await signCompanyLock(claims.session_id, company), lockCookieOptions);
  }
  return response;
}

export const config = {
  // static files, device webhooks and cron jobs carry no user session
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest|sw.js|icons/|api/punch|api/attendance/punch|api/push/dispatch|api/cron).*)"],
};
