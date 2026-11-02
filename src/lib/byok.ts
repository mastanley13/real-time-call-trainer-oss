import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Bring-your-own-key for Team plans (STR-690). A Team owner may store their own OpenAI API key; it is encrypted at
 * rest with AES-256-GCM under BYOK_ENCRYPTION_KEY (32 random bytes, base64) and used only for that team's members.
 *
 * Format: "v1.<iv>.<tag>.<ciphertext>", each part base64url. The organization id is the additional authenticated
 * data, so a ciphertext copied onto another organization's row does not decrypt. The plaintext key is never logged,
 * never returned to a client and never written anywhere but this ciphertext; clients only see the last four
 * characters and whether a key is set.
 */

const VERSION = "v1";
const IV_BYTES = 12;

/** An OpenAI secret key: "sk-" then URL-safe characters. Bounded so the column and the header stay small. */
export const BYOK_KEY_PATTERN = /^sk-[A-Za-z0-9_-]{20,256}$/;

export class ByokConfigError extends Error {
  constructor() {
    super("BYOK_NOT_CONFIGURED");
    this.name = "ByokConfigError";
  }
}

/** The 32-byte encryption key from BYOK_ENCRYPTION_KEY, or null when it is unset or the wrong length. */
export function byokEncryptionKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.BYOK_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? key : null;
}

export function encryptByok(plain: string, organizationId: string, key: Buffer | null = byokEncryptionKey()): string {
  if (!key) throw new ByokConfigError();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(organizationId, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws on a wrong key, a wrong organization, a tampered blob or an unknown version. The error never carries the plaintext. */
export function decryptByok(blob: string, organizationId: string, key: Buffer | null = byokEncryptionKey()): string {
  if (!key) throw new ByokConfigError();
  const [version, ivB64, tagB64, ctB64, ...rest] = blob.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || !ctB64 || rest.length) throw new Error("BYOK_BAD_FORMAT");
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== 16) throw new Error("BYOK_BAD_FORMAT");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(organizationId, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("BYOK_DECRYPT_FAILED");
  }
}

/** What a client may see about a stored key: whether one is set, its last four characters and when it changed. */
export interface ByokStatus {
  set: boolean;
  last4: string | null;
  updatedAt: string | null;
}

export const last4Of = (key: string): string => key.slice(-4);
