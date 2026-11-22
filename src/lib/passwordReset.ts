import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { RESET_TTL_MINUTES } from "./passwordReset-types";

/**
 * Stateless password reset tokens. No database table: the token carries the user id, an expiry and a fingerprint of
 * the user's current password hash, all signed with HMAC-SHA256 under a key derived from JWT_SECRET. Once the
 * password changes the fingerprint no longer matches, so a link works at most once in practice.
 *
 * Format: v1.<base64url(userId)>.<expiryMs>.<fingerprint>.<signature>
 *
 * The sign and verify functions are pure: the caller passes the secret and the current time.
 */

export const RESET_TOKEN_TTL_MS = RESET_TTL_MINUTES * 60 * 1000;
export const RESET_TOKEN_MAX_LENGTH = 512;
const VERSION = "v1";
/** Stands in for the hash on accounts with no password (Google-only), so they can still set one. */
const NO_PASSWORD_MARKER = "no-password-set";

/** A key used only for reset tokens, so a reset signature can never be replayed as any other HMAC keyed by JWT_SECRET. */
function resetKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("password-reset-token-key").digest();
}

/** HMAC of the current password hash (or the no-password marker). Reveals nothing about the hash itself. */
export function passwordFingerprint(passwordHash: string | null | undefined, secret: string): string {
  return createHmac("sha256", resetKey(secret))
    .update(`fingerprint:${passwordHash ?? NO_PASSWORD_MARKER}`)
    .digest("base64url");
}

function signature(body: string, secret: string): string {
  return createHmac("sha256", resetKey(secret)).update(body).digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export interface SignResetInput {
  userId: string;
  passwordHash: string | null | undefined;
  secret: string;
  now: number;
  ttlMs?: number;
}

export function signResetToken({ userId, passwordHash, secret, now, ttlMs = RESET_TOKEN_TTL_MS }: SignResetInput): string {
  const exp = Math.floor(now + ttlMs);
  const body = [VERSION, Buffer.from(userId, "utf8").toString("base64url"), String(exp), passwordFingerprint(passwordHash, secret)].join(".");
  return `${body}.${signature(body, secret)}`;
}

export interface VerifiedReset {
  userId: string;
  expiresAt: number;
  fingerprint: string;
}

/** The token's claims when the signature is valid and it has not expired, else null. Does not check the fingerprint. */
export function verifyResetToken(token: string, { secret, now }: { secret: string; now: number }): VerifiedReset | null {
  if (typeof token !== "string" || token.length === 0 || token.length > RESET_TOKEN_MAX_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 5) return null;
  const [version, userPart, expPart, fingerprint, sig] = parts;
  if (version !== VERSION || !/^\d{1,16}$/.test(expPart)) return null;
  if (!safeEqual(sig, signature(parts.slice(0, 4).join("."), secret))) return null;
  const expiresAt = Number(expPart);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  const userId = Buffer.from(userPart, "base64url").toString("utf8");
  if (!userId) return null;
  return { userId, expiresAt, fingerprint };
}

/** True when the token's fingerprint matches the user's current password hash. Constant time. */
export function fingerprintMatches(fingerprint: string, passwordHash: string | null | undefined, secret: string): boolean {
  return safeEqual(fingerprint, passwordFingerprint(passwordHash, secret));
}

type Env = Record<string, string | undefined>;

/**
 * Origin for the link in the reset email. Read from APP_URL only, the same way googleAuth.ts does; the Host header
 * is never used. Outside production an unset APP_URL falls back to localhost so the flow can be tested locally.
 * Null in production when APP_URL is unset or not an http(s) URL: the caller must not send the email.
 */
export function resetLinkOrigin(env: Env = process.env): string | null {
  const raw = env.APP_URL?.trim();
  if (raw && /^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).origin;
    } catch {
      /* fall through */
    }
  }
  if (env.NODE_ENV === "production") return null;
  const port = /^\d{2,5}$/.test(env.PORT ?? "") ? env.PORT : "3000";
  return `http://localhost:${port}`;
}

export function resetLink(origin: string, token: string): string {
  return `${origin}/reset-password?token=${encodeURIComponent(token)}`;
}
