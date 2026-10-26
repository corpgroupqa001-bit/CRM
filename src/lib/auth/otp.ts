// Email OTP rules (AUTH-06/07). Pure logic over a small store interface so it can be unit-tested;
// the Supabase-backed store lives in otp-store.ts.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export type OtpPurpose = "signup" | "login" | "reset" | "invite" | "change_email";

export interface OtpRecord {
  id: string;
  email: string;
  purpose: OtpPurpose;
  code_hash: string;
  expires_at: string;
  attempts: number;
  used_at: string | null;
  invalidated_at: string | null;
  ip: string | null;
  payload: Record<string, unknown> | null;
  link_hash: string | null;
  created_at: string;
}

export interface OtpStore {
  /** most recent live (unused, not invalidated) code for email + purpose */
  latest(email: string, purpose: OtpPurpose): Promise<OtpRecord | null>;
  /** number of codes created since `since` for this email, and for this IP */
  countSince(since: Date, by: { email?: string; ip?: string }): Promise<number>;
  invalidateAll(email: string, purpose: OtpPurpose, at: Date): Promise<void>;
  insert(rec: Omit<OtpRecord, "id" | "attempts" | "used_at" | "invalidated_at" | "created_at"> & { created_at?: string }): Promise<void>;
  update(id: string, patch: Partial<Pick<OtpRecord, "attempts" | "used_at" | "invalidated_at">>): Promise<void>;
}

export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_COOLDOWN_MS = 60 * 1000;
export const OTP_HOURLY_LIMIT = 5;

export class OtpError extends Error {
  constructor(public code: "cooldown" | "rate_limited" | "invalid" | "expired" | "too_many_attempts" | "not_found", message: string) {
    super(message);
  }
}

export const normaliseEmail = (e: string) => e.trim().toLowerCase();

export function hashOtp(email: string, purpose: string, code: string, pepper = process.env.OTP_PEPPER ?? "") {
  return createHash("sha256").update(`${pepper}:${normaliseEmail(email)}:${purpose}:${code}`).digest("hex");
}

/** 6 digits from a CSPRNG */
export const generateCode = () => String(randomInt(0, 1_000_000)).padStart(6, "0");

/** token for the one-click verify link: 32 random bytes, URL-safe */
export const generateLinkToken = () => randomBytes(32).toString("base64url");

const same = (a: string, b: string | null) => {
  if (!b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function issueOtp(
  store: OtpStore,
  opts: { email: string; purpose: OtpPurpose; ip: string | null; payload?: Record<string, unknown>; now?: Date },
): Promise<{ code: string; linkToken: string }> {
  const now = opts.now ?? new Date();
  const email = normaliseEmail(opts.email);

  const last = await store.latest(email, opts.purpose);
  if (last && now.getTime() - new Date(last.created_at).getTime() < OTP_COOLDOWN_MS) {
    const wait = Math.ceil((OTP_COOLDOWN_MS - (now.getTime() - new Date(last.created_at).getTime())) / 1000);
    throw new OtpError("cooldown", `Please wait ${wait} s before requesting another code.`);
  }
  const hourAgo = new Date(now.getTime() - 3600_000);
  if ((await store.countSince(hourAgo, { email })) >= OTP_HOURLY_LIMIT) {
    throw new OtpError("rate_limited", "Too many codes requested for this email. Try again in an hour.");
  }
  if (opts.ip && (await store.countSince(hourAgo, { ip: opts.ip })) >= OTP_HOURLY_LIMIT) {
    throw new OtpError("rate_limited", "Too many codes requested from this network. Try again in an hour.");
  }

  // resending invalidates the previous code
  await store.invalidateAll(email, opts.purpose, now);
  const code = generateCode();
  const linkToken = generateLinkToken();
  await store.insert({
    email, purpose: opts.purpose, code_hash: hashOtp(email, opts.purpose, code),
    link_hash: hashOtp(email, opts.purpose, `link:${linkToken}`),
    expires_at: new Date(now.getTime() + OTP_TTL_MS).toISOString(), ip: opts.ip, payload: opts.payload ?? null,
    created_at: now.toISOString(),
  });
  return { code, linkToken };
}

export async function verifyOtp(
  store: OtpStore,
  opts: { email: string; purpose: OtpPurpose; code: string; now?: Date },
): Promise<OtpRecord> {
  const now = opts.now ?? new Date();
  const email = normaliseEmail(opts.email);
  const rec = await store.latest(email, opts.purpose);
  if (!rec) throw new OtpError("not_found", "No active code. Request a new one.");
  if (new Date(rec.expires_at) <= now) {
    await store.update(rec.id, { invalidated_at: now.toISOString() });
    throw new OtpError("expired", "This code has expired. Request a new one.");
  }
  if (!same(hashOtp(email, opts.purpose, opts.code.trim()), rec.code_hash)) {
    const attempts = rec.attempts + 1;
    if (attempts >= OTP_MAX_ATTEMPTS) {
      await store.update(rec.id, { attempts, invalidated_at: now.toISOString() });
      throw new OtpError("too_many_attempts", "Too many wrong attempts. Request a new code.");
    }
    await store.update(rec.id, { attempts });
    throw new OtpError("invalid", `Incorrect code. ${OTP_MAX_ATTEMPTS - attempts} attempt(s) left.`);
  }
  await store.update(rec.id, { used_at: now.toISOString() });
  return rec;
}

/**
 * Verify the one-click link. Same record, expiry and single-use rules as the code; a wrong token
 * counts as a failed attempt. Using either the link or the code consumes both.
 */
export async function verifyOtpLink(
  store: OtpStore,
  opts: { email: string; purpose: OtpPurpose; token: string; now?: Date },
): Promise<OtpRecord> {
  const now = opts.now ?? new Date();
  const email = normaliseEmail(opts.email);
  const rec = await store.latest(email, opts.purpose);
  if (!rec) throw new OtpError("not_found", "This link was already used or replaced by a newer one. Request a new code.");
  if (new Date(rec.expires_at) <= now) {
    await store.update(rec.id, { invalidated_at: now.toISOString() });
    throw new OtpError("expired", "This link has expired. Request a new code.");
  }
  if (!same(hashOtp(email, opts.purpose, `link:${opts.token}`), rec.link_hash)) {
    const attempts = rec.attempts + 1;
    await store.update(rec.id, attempts >= OTP_MAX_ATTEMPTS ? { attempts, invalidated_at: now.toISOString() } : { attempts });
    throw new OtpError("invalid", "This link is not valid. Use the newest email, or enter the code instead.");
  }
  await store.update(rec.id, { used_at: now.toISOString() });
  return rec;
}
