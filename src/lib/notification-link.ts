// Where a notification opens. Links are stored relative to their company ("/leave", "/tasks/<id>") and
// shown under /c/<company>. A few are stored as full app paths ("/c/<company>/employees/approvals");
// those are used as they are, so the company part never appears twice.
export function notificationHref(link: string | null | undefined, companyId: string | null | undefined): string {
  if (!link || !link.startsWith("/") || link.startsWith("//")) return "/";
  if (link.startsWith("/c/") || !companyId) return link;
  return `/c/${companyId}${link}`;
}
