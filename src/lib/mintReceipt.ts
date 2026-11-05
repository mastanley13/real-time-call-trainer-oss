import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Mint receipts. /api/realtime/session signs the model it actually minted a voice call with, for
 * the signed-in user, with an HMAC keyed by JWT_SECRET (the same key as grade seals, with its own
 * version tag). POST /api/transcripts logs TrainerSession.realtimeModel only from a receipt that
 * verifies for that user and is still fresh, and takes the model from inside the receipt. A model id
 * the client sends is never trusted, so a forged Premium id can't skew cost logs.
 * Without JWT_SECRET nothing is signed and nothing is logged.
 *
 * Format: base64url(JSON { v, u, m, t }) + "." + hex HMAC-SHA256 over the base64url part.
 */

const VERSION = "mint-receipt-v1";
/** A receipt outlives the call and its grading, not much more. Calls longer than this log no model. */
export const MINT_RECEIPT_TTL_MS = 4 * 60 * 60 * 1000;
/** Clock skew allowed between server instances. */
const SKEW_MS = 60_000;
const MAX_RECEIPT_CHARS = 512;

const receiptKey = () => process.env.JWT_SECRET?.trim() || undefined;
const mac = (key: string, body: string) => createHmac("sha256", key).update(`${VERSION}:${body}`).digest("hex");

/** Receipt for a call the server just minted, or undefined when JWT_SECRET is unset. */
export function signMintReceipt(userId: string, model: string, now = Date.now(), key = receiptKey()): string | undefined {
  if (!key) return undefined;
  const body = Buffer.from(JSON.stringify({ v: VERSION, u: userId, m: model, t: Math.floor(now / 1000) })).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

/** The minted model id when `receipt` is the server's own, for this user, and fresh. Otherwise null. */
export function verifyMintReceipt(receipt: unknown, userId: string, now = Date.now(), key = receiptKey()): string | null {
  if (!key || typeof receipt !== "string" || receipt.length > MAX_RECEIPT_CHARS) return null;
  const dot = receipt.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = receipt.slice(0, dot);
  const sig = receipt.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(mac(key, body), "hex"), Buffer.from(sig, "hex"))) return null;
  let payload: { v?: unknown; u?: unknown; m?: unknown; t?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== VERSION || payload.u !== userId) return null;
  if (typeof payload.m !== "string" || !payload.m || payload.m.length > 80) return null;
  if (typeof payload.t !== "number" || !Number.isFinite(payload.t)) return null;
  const issued = payload.t * 1000;
  if (issued > now + SKEW_MS || now - issued > MINT_RECEIPT_TTL_MS) return null;
  return payload.m;
}
