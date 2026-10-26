import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { OtpPurpose, OtpRecord, OtpStore } from "./otp";

/** OTP rows live in public.otp_codes, readable only with the service role (AUTH-10). */
export function supabaseOtpStore(): OtpStore {
  const db = createAdminClient();
  return {
    async latest(email: string, purpose: OtpPurpose) {
      const { data, error } = await db.from("otp_codes").select("*")
        .eq("email", email).eq("purpose", purpose).is("used_at", null).is("invalidated_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) throw error;
      return data as OtpRecord | null;
    },
    async countSince(since, by) {
      let q = db.from("otp_codes").select("id", { count: "exact", head: true }).gte("created_at", since.toISOString());
      if (by.email) q = q.eq("email", by.email);
      if (by.ip) q = q.eq("ip", by.ip);
      const { count, error } = await q;
      if (error) throw error;
      return count ?? 0;
    },
    async invalidateAll(email, purpose, at) {
      const { error } = await db.from("otp_codes").update({ invalidated_at: at.toISOString() })
        .eq("email", email).eq("purpose", purpose).is("used_at", null).is("invalidated_at", null);
      if (error) throw error;
    },
    async insert(rec) {
      const { error } = await db.from("otp_codes").insert(rec);
      if (error) throw error;
    },
    async update(id, patch) {
      const { error } = await db.from("otp_codes").update(patch).eq("id", id);
      if (error) throw error;
    },
  };
}
