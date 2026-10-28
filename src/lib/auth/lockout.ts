// AUTH-02 lockout: five failed sign-ins within 15 minutes lock the login for the company's lock time
// (15 minutes by default, configurable) or until an administrator unlocks it. A successful sign-in or an
// administrator's unlock (both stored as a successful attempt) starts the count again.

export const LOCK_FAILURES = 5;
export const LOCK_WINDOW_MIN = 15;
export const LOCKOUT_CHOICES = [15, 30, 60, 1440] as const;
export const lockoutLabel = (m: number) => (m >= 60 ? `${m / 60} hour${m > 60 ? "s" : ""}` : `${m} minutes`);

/** when the login stays locked until, or null; attempts newest first */
export function lockedUntil(attempts: { success: boolean; at: string }[], lockMinutes: number, now = Date.now()): Date | null {
  const fails: number[] = [];
  for (const a of attempts) {
    if (a.success) break;
    fails.push(Date.parse(a.at));
  }
  // the newest run of five failures inside the 15-minute window starts the lock
  for (let k = 0; k + LOCK_FAILURES - 1 < fails.length; k++) {
    if (fails[k] - fails[k + LOCK_FAILURES - 1] <= LOCK_WINDOW_MIN * 60_000) {
      const until = fails[k] + lockMinutes * 60_000;
      return until > now ? new Date(until) : null;
    }
  }
  return null;
}

/** "3:45 pm" (or "28 Oct, 3:45 pm" when it isn't today), India time */
export function lockTimeText(d: Date, now = new Date()) {
  const day = (x: Date) => x.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  const time = d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" });
  return day(d) === day(now) ? time : `${d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" })}, ${time}`;
}
