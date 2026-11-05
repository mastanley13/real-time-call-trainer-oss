import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Mint receipts. /api/realtime/session signs the model it actually minted a voice call with, for
 * the signed-in user AND one call, with an HMAC keyed by JWT_SECRET (the same key as grade seals, with
 * its own version tag). POST /api/transcripts logs TrainerSession.realtimeModel only from a receipt that
 * verifies for that user and for the exact call id the save names (`sessionId`), is still fresh, and has
 * not been used before. The model comes from inside the receipt; a model id the client sends is never trusted.
 * Without JWT_SECRET nothing is signed and nothing is logged.
 *
 * The call id is generated on the server before the secret is minted: the metering call id when the call is
 * metered, otherwise a random UUID. The client gets it back as `sessionId` and saves the call under it, so a
 * receipt from one call can't be attached to another call or to a text save, and it logs at most one row:
 * that row's primary key is receiptRowId(callId), so a second save with the same receipt hits a unique
 * violation and is stored without a model.
 *
 * Format: base64url(JSON { v, u, s, m, t }) + "." + hex HMAC-SHA256 over the base64url part.
 */

const VERSION = "mint-receipt-v2";
/** A receipt outlives the call and its grading, not much more. Calls longer than this log no model. */
export const MINT_RECEIPT_TTL_MS = 4 * 60 * 60 * 1000;
/** Clock skew allowed between server instances. */
const SKEW_MS = 60_000;
const MAX_RECEIPT_CHARS = 512;
/** Call ids are server-made (a cuid or a UUID); anything else is refused at sign and verify time. */
const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

const receiptKey = () => process.env.JWT_SECRET?.trim() || undefined;
const mac = (key: string, body: string) => createHmac("sha256", key).update(`${VERSION}:${body}`).digest("hex");

/** Primary key of the one TrainerSession row a receipt may log a model on. Deterministic, so a replay collides. */
export const receiptRowId = (callId: string) => `rt_${callId}`;

/** True for the unique-constraint error Prisma raises when receiptRowId(callId) already exists. */
export const isReceiptReplay = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/** Receipt for a call the server just minted, or undefined when JWT_SECRET is unset or the call id is malformed. */
export function signMintReceipt(userId: string, callId: string, model: string, now = Date.now(), key = receiptKey()): string | undefined {
  if (!key || !CALL_ID.test(callId)) return undefined;
  const body = Buffer.from(JSON.stringify({ v: VERSION, u: userId, s: callId, m: model, t: Math.floor(now / 1000) })).toString("base64url");
  return `${body}.${mac(key, body)}`;
}

/**
 * The minted model id when `receipt` is the server's own, for this user and exactly this call id, and fresh.
 * Otherwise null. Single use is enforced by the caller through receiptRowId.
 */
export function verifyMintReceipt(receipt: unknown, userId: string, callId: unknown, now = Date.now(), key = receiptKey()): string | null {
  if (!key || typeof receipt !== "string" || receipt.length > MAX_RECEIPT_CHARS) return null;
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return null;
  const dot = receipt.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = receipt.slice(0, dot);
  const sig = receipt.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(mac(key, body), "hex"), Buffer.from(sig, "hex"))) return null;
  let payload: { v?: unknown; u?: unknown; s?: unknown; m?: unknown; t?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.v !== VERSION || payload.u !== userId || payload.s !== callId) return null;
  if (typeof payload.m !== "string" || !payload.m || payload.m.length > 80) return null;
  if (typeof payload.t !== "number" || !Number.isFinite(payload.t)) return null;
  const issued = payload.t * 1000;
  if (issued > now + SKEW_MS || now - issued > MINT_RECEIPT_TTL_MS) return null;
  return payload.m;
}
