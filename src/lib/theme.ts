// Light / dark theme, chosen by each person from the profile menu (or the sign-in pages). The choice is a
// plain preference cookie, read by the root layout so the first paint already has the right theme.
export const THEME_COOKIE = "cg_theme";
export type Theme = "light" | "dark";

export function parseTheme(value: string | undefined | null): Theme {
  return value === "dark" ? "dark" : "light";
}

/** Cookie string for document.cookie: one year, whole site, not sent cross-site. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${secure ? "; Secure" : ""}`;
}
