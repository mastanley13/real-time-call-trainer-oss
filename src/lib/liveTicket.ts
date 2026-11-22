import "server-only";
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

/**
 * Live tickets. GPT-Live has no ephemeral client secret: the server must post the browser's SDP offer to
 * /v1/live/sessions with the project key itself. So when OPENAI_VOICE_API=live, /api/realtime/session does
 * everything it always does (cap check, metering, mint log, receipt) and hands the browser this ticket in place of
 * a client secret. /api/live/sdp then accepts the offer only with a ticket that opens for the same signed-in user and
 * the same call, is fresh, and has not been used in this process.
 *
 * Sealed like mint receipts (src/lib/mintReceipt.ts): AES-256-GCM, key derived from JWT_SECRET with its own HKDF
 * label, user id and call id bound as additional data, so the browser cannot read or change the model or voice.
 * Format: "lt1." + base64url(iv[12] | ciphertext | tag[16]).
 */

const PREFIX = "lt1.";
const VERSION = "live-ticket-v1";
/** The SDP exchange follows the session answer immediately; two minutes is generous. */
export const LIVE_TICKET_TTL_MS = 2 * 60 * 1000;
const SKEW_MS = 30_000;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TICKET_CHARS = 600;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface LiveTicket { model: string; voice: string }

const ticketSecret = () => process.env.JWT_SECRET?.trim() || undefined;
const deriveKey = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", VERSION, 32));
const aad = (userId: string, callId: string) => Buffer.from(JSON.stringify([VERSION, userId, callId]), "utf8");

/**
 * Best-effort single use, per server process: a ticket that already started a session is refused. On serverless
 * another instance would not know, so the short TTL and the per-user rate limit on /api/live/sdp are the real bound.
 */
const used = new Map<string, number>();
function markUsed(nonce: string, now: number): boolean {
  for (const [k, exp] of used) if (exp < now) used.delete(k);
  if (used.has(nonce)) return false;
  used.set(nonce, now + LIVE_TICKET_TTL_MS + SKEW_MS);
  return true;
}

/** Ticket for one call, or undefined without JWT_SECRET or with a malformed call id. */
export function sealLiveTicket(userId: string, callId: string, t: LiveTicket, now = Date.now(), secret = ticketSecret()): string | undefined {
  if (!secret || !CALL_ID.test(callId) || !t.model || t.model.length > 80 || !t.voice || t.voice.length > 40) return undefined;
  const plaintext = Buffer.from(JSON.stringify({ m: t.model, v: t.voice, t: now, n: randomBytes(9).toString("base64url") }), "utf8");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  cipher.setAAD(aad(userId, callId));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return PREFIX + Buffer.concat([iv, ct, cipher.getAuthTag()]).toString("base64url");
}

/**
 * The model and voice when `ticket` is this server's, for this user and exactly this call id, fresh, and unused.
 * Opening it marks it used. Otherwise null.
 */
export function openLiveTicket(ticket: unknown, userId: string, callId: unknown, now = Date.now(), secret = ticketSecret()): LiveTicket | null {
  if (!secret || typeof ticket !== "string" || ticket.length > MAX_TICKET_CHARS || !ticket.startsWith(PREFIX)) return null;
  if (typeof callId !== "string" || !CALL_ID.test(callId)) return null;
  const encoded = ticket.slice(PREFIX.length);
  if (!BASE64URL.test(encoded)) return null;
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) return null;
  let p: { m?: unknown; v?: unknown; t?: unknown; n?: unknown };
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), raw.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
    decipher.setAAD(aad(userId, callId));
    decipher.setAuthTag(raw.subarray(raw.length - TAG_BYTES));
    p = JSON.parse(Buffer.concat([decipher.update(raw.subarray(IV_BYTES, raw.length - TAG_BYTES)), decipher.final()]).toString("utf8"));
  } catch {
    return null;
  }
  if (typeof p?.m !== "string" || !p.m || typeof p.v !== "string" || !p.v || typeof p.n !== "string") return null;
  if (typeof p.t !== "number" || p.t > now + SKEW_MS || now - p.t > LIVE_TICKET_TTL_MS) return null;
  if (!markUsed(p.n, now)) return null;
  return { model: p.m, voice: p.v };
}

/** Test hook. */
export function resetLiveTickets(): void { used.clear(); }
