// Company chosen on the sign-in form. The company id from the form is never trusted: after the
// password check, public.my_access(company) is asked as the signed-in user, and only an allowed
// answer lets the sign-in through. Messages never mention the user's other companies.

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Access = { allowed: boolean; reason?: string; role?: string } | null;

/** null when the user may use the company, otherwise the message to show (and the user is signed out) */
export function companyAccessError(access: Access): string | null {
  if (access?.allowed) return null;
  switch (access?.reason) {
    case "membership_inactive":
    case "employee_inactive":
      return "Your account is inactive in this company. Contact your company administrator.";
    default:
      return "This account doesn't have access to the selected company. Check the company and try again.";
  }
}

/** where to go after signing in to a company: a deep link inside that company, or a page outside any
 *  company (e.g. /account), is kept; a link into a different company — or into the admin portal, which
 *  has its own sign-in — falls back to the company's dashboard */
export function companyLanding(companyId: string, next: string | null) {
  if (next && next.startsWith("/") && !next.startsWith("//")) {
    if (next === `/c/${companyId}` || next.startsWith(`/c/${companyId}/`)) return next;
    if (!next.startsWith("/c/") && !next.startsWith("/admin") && next !== "/") return next;
  }
  return `/c/${companyId}/dashboard`;
}
