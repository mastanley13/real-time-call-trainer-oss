import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Mint receipts. /api/realtime/session seals what it actually minted a voice call with (the model, the effective voice
 * tier and, for a metered call, the call id) for the signed-in user. POST /api/transcripts logs TrainerSession.realtimeModel
 * and the tier only from a receipt that opens for that user, is fresh, and (when it names a call) names the call being
 * saved. A model id or tier the client sends is never trusted.
 *
 * The receipt is OPAQUE to the browser: AES-256-GCM authenticated encryption, not a signed plaintext. Nothing in it is
 * readable without the server key, and any edit fails the GCM tag. The key is derived from JWT_SECRET with HKDF under
 * its own label, so it is never the JWT key itself. The user id is bound as additional authenticated data, so a
 * receipt cannot be opened as anyone else's. Without JWT_SECRET nothing is sealed and nothing is logged.
 *
 * Replay: a metered call's receipt is bound to its call id, and the save fills that call's row only once (an empty
 * transcript is required). An unmetered receipt is user-bound and expires after MINT_RECEIPT_TTL_MS; replaying it within
 * that window can only label the same user's own sessions with the model they were really minted (cost log, not billing).
 *
 * Format: "mr2." + base64url(12-byte IV || ciphertext || 16-byte tag). Plaintext JSON { m, t, n, q?, c? }.
 */

const VERSION = "mint-receipt-v2";
const PREFIX = "mr2.";
/** A receipt outlives the call and its grading, not much more. Calls longer than this log no model. */
export const MINT_RECEIPT_TTL_MS = 4 * 60 * 60 * 1000;
/** Clock skew allowed between server instances. */
const SKEW_MS = 60_000;
const MAX_RECEIPT_CHARS = 512;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const receiptSecret = () => process.env.JWT_SECRET?.trim() || undefined;
const derive = (secret: string): Buffer => Buffer.from(hkdfSync("sha256", secret, "", VERSION, 32));
const aad = (userId: string) => Buffer.from(`${VERSION}:${userId}`, "utf8");

export interface MintReceipt { model: string; tier: "premium" | "standard" | null; callId: string | null }

/**
 * Sealed receipt for a call the server just minted, or undefined when JWT_SECRET is unset. `extra` adds the effective
 * voice tier and the metered call id. A fresh random IV and nonce make every receipt different, even for the same call.
 */
export function signMintReceipt(userId: string, model: string, now = Date.now(), key = receiptSecret(), extra: { tier?: "premium" | "standard"; callId?: string } = {}): string | undefined {
  if (!key) return undefined;
  const payload = JSON.stringify({
    m: model, t: Math.floor(now / 1000), n: randomBytes(6).toString("hex"),
    ...(extra.tier ? { q: extra.tier } : {}), ...(extra.callId ? { c: extra.callId } : {}),
  });
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", derive(key), iv);
  cipher.setAAD(aad(userId));
  const ct = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
}

/** Everything a valid receipt carries, or null: wrong user, wrong key, edited, stale, from the future, or junk. */
export function readMintReceipt(receipt: unknown, userId: string, now = Date.now(), key = receiptSecret()): MintReceipt | null {
  if (!key || typeof receipt !== "string" || receipt.length > MAX_RECEIPT_CHARS || !receipt.startsWith(PREFIX)) return null;
  const raw = Buffer.from(receipt.slice(PREFIX.length), "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  let p: { m?: unknown; t?: unknown; q?: unknown; c?: unknown };
  try {
    const decipher = createDecipheriv("aes-256-gcm", derive(key), raw.subarray(0, IV_BYTES));
    decipher.setAAD(aad(userId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    p = JSON.parse(plain);
  } catch {
    return null;
  }
  if (!p || typeof p.m !== "string" || !p.m || p.m.length > 80) return null;
  if (typeof p.t !== "number" || !Number.isFinite(p.t)) return null;
  const issued = p.t * 1000;
  if (issued > now + SKEW_MS || now - issued > MINT_RECEIPT_TTL_MS) return null;
  return {
    model: p.m,
    tier: p.q === "premium" || p.q === "standard" ? p.q : null,
    callId: typeof p.c === "string" && p.c.length <= 64 ? p.c : null,
  };
}

/** The minted model id when `receipt` is the server's own, for this user, and fresh. Otherwise null. Server-side only. */
export function verifyMintReceipt(receipt: unknown, userId: string, now = Date.now(), key = receiptSecret()): string | null {
  return readMintReceipt(receipt, userId, now, key)?.model ?? null;
}
