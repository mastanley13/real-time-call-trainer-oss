import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Mint receipts. /api/realtime/session seals the model it actually minted a voice call with, for the signed-in
 * user AND one call. POST /api/transcripts logs TrainerSession.realtimeModel only from a receipt that opens for
 * that user and for the exact call id the save names (`sessionId`), is still fresh, and has not been used before.
 * The model comes from inside the receipt; a model id the client sends is never trusted.
 *
 * The receipt goes to the browser, which must not learn the model: it is AES-256-GCM (authenticated encryption),
 * not a readable signed payload. The key is derived with HKDF from JWT_SECRET under its own label, so it is never
 * the JWT signing key itself. The user id and the call id are bound as additional authenticated data, so a receipt
 * opens only for its own user and its own call. The plaintext is padded to a fixed size, so every receipt has the
 * same length and the length does not hint at the tier. Without JWT_SECRET nothing is sealed and nothing is logged.
 *
 * The call id is generated on the server before the secret is minted: the metering call id when the call is
 * metered, otherwise a random UUID. The client gets it back as `sessionId` and saves the call under it, so a
 * receipt from one call can't be attached to another call or to a text save. It logs on exactly one row:
 * - metered: the call's own TrainerSession row (id = callId), by a conditional update that only writes while
 *   realtimeModel is still unset, so a replayed or concurrent save changes nothing;
 * - unmetered: a new row whose primary key is receiptRowId(callId), so a second save with the same receipt
 *   hits a unique violation and is stored without a model.
 * Single use keys on the call id, never on the receipt string, so re-encoding a receipt does not reopen it.
 *
 * The effective voice tier is not sealed separately: a metered call's tier is written on its own row at mint
 * (src/lib/voiceMintLog.ts), and the tier a logged model stands for on an unmetered save is resolved on the server
 * from the model id (src/lib/voiceTierServer.ts tierOfModel), so the receipt keeps exactly this shape.
 *
 * Format: "mr3." + base64url(iv[12] | ciphertext[PLAINTEXT_BYTES] | tag[16]).
 */

const PREFIX = "mr3.";
const VERSION = "mint-receipt-v3";
/** A receipt outlives the call and its grading, not much more. Calls longer than this log no model. */
export const MINT_RECEIPT_TTL_MS = 4 * 60 * 60 * 1000;
/** Clock skew allowed between server instances. */
const SKEW_MS = 60_000;
const MAX_MODEL_CHARS = 80;
/** Fixed plaintext size: fits { m: <80 chars>, t } with room to spare. */
const PLAINTEXT_BYTES = 160;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_RECEIPT_CHARS = 512;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Call ids are server-made (a cuid or a UUID); anything else is refused at seal and open time. */
const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

const receiptSecret = () => process.env.JWT_SECRET?.trim() || undefined;
const deriveKey = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", VERSION, 32));
const aad = (userId: string, callId: string) => Buffer.from(JSON.stringify([VERSION, userId, callId]), "utf8");

/** Primary key of the one row an unmetered call's receipt may log a model on. Deterministic, so a replay collides. */
export const receiptRowId = (callId: string) => `rt_${callId}`;

/** True for the unique-constraint error Prisma raises when receiptRowId(callId) already exists. */
export const isReceiptReplay = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";

/**
 * Opaque receipt for a call the server just minted, or undefined when JWT_SECRET is unset, the call id is
 * malformed, or the model id is too long to seal.
 */
export function sealMintReceipt(userId: string, callId: string, model: string, now = Date.now(), secret = receiptSecret()): string | undefined {
  if (!secret || !CALL_ID.test(callId) || !model || model.length > MAX_MODEL_CHARS) return undefined;
  const json = Buffer.from(JSON.stringify({ m: model, t: Math.floor(now / 1000) }), "utf8");
  if (json.length > PLAINTEXT_BYTES) return undefined;
  // Trailing spaces are valid JSON whitespace, so the padded plaintext still parses.
  const plaintext = Buffer.concat([json, Buffer.alloc(PLAINTEXT_BYTES - json.length, 0x20)]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(aad(userId, callId));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
}

/**
 * The minted model id when `receipt` is the server's own, for this user and exactly this call id, and fresh.
 * Otherwise null. Single use is enforced by the caller through receiptRowId.
 */
export function verifyMintReceipt(receipt: unknown, userId: string, callId: unknown, now = Date.now(), secret = receiptSecret()): string | null {
  if (!secret || typeof receipt !== "string" || receipt.length > MAX_RECEIPT_CHARS || !receipt.startsWith(PREFIX)) return null;
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return null;
  const encoded = receipt.slice(PREFIX.length);
  if (!BASE64URL.test(encoded)) return null;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== IV_BYTES + PLAINTEXT_BYTES + TAG_BYTES) return null;
  let payload: { m?: unknown; t?: unknown };
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId, callId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    const plain = Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]);
    payload = JSON.parse(plain.toString("utf8"));
  } catch {
    // Tampered, forged, another user's or another call's, or sealed under a different key.
    return null;
  }
  if (!payload || typeof payload.m !== "string" || !payload.m || payload.m.length > MAX_MODEL_CHARS) return null;
  if (typeof payload.t !== "number" || !Number.isFinite(payload.t)) return null;
  const issued = payload.t * 1000;
  if (issued > now + SKEW_MS || now - issued > MINT_RECEIPT_TTL_MS) return null;
  return payload.m;
}
