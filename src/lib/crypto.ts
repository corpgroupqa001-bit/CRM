import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Column-level encryption for PAN, Aadhaar and bank account numbers (NFR-05).
// Format: base64(iv).base64(tag).base64(ciphertext), AES-256-GCM.

function key() {
  const raw = process.env.FIELD_ENCRYPTION_KEY;
  if (!raw) throw new Error("FIELD_ENCRYPTION_KEY is not set");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("FIELD_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decrypt(payload: string | null | undefined): string | null {
  if (!payload) return null;
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export const last4 = (v: string) => v.replace(/\s/g, "").slice(-4);
