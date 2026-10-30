/** Shared (edge + node) helpers for the optional access gate (shared TRAINER_ACCESS_CODE and invite codes). Uses Web Crypto only. */

export const ACCESS_COOKIE = "trainer_access";
export const ACCESS_MAX_AGE = 30 * 24 * 60 * 60;
/**
 * Gate cookies issued for an invite code last at most this long (or until the
 * invite expires, if sooner). The edge middleware can't read the database, so
 * revoking an invite stops new gate passes and redemptions at once, and a pass
 * already handed out lapses within this window.
 */
export const INVITE_ACCESS_MAX_AGE = 7 * 24 * 60 * 60;

export function accessCode(): string | null {
  return process.env.TRAINER_ACCESS_CODE?.trim() || null;
}

/**
 * Migration flag for the shared code. Default true so existing deployments keep
 * working; ALLOW_SHARED_ACCESS_CODE=false makes TRAINER_ACCESS_CODE (and gate
 * cookies made from it) stop working, so only invite codes get in.
 */
export function sharedCodeAllowed(): boolean {
  return process.env.ALLOW_SHARED_ACCESS_CODE?.trim().toLowerCase() !== "false";
}

/**
 * The gate is on when a shared code is set, or when the shared code has been
 * switched off (invite-only), so turning the flag off never opens the site.
 */
export function accessGateEnabled(): boolean {
  return Boolean(accessCode()) || !sharedCodeAllowed();
}

const enc = new TextEncoder();

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (length leak only, which is fixed for hex digests). */
export function safeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Cookie value: HMAC of the code, keyed by JWT_SECRET (or a key derived from the code if unset). Never the raw code. */
export async function accessToken(code: string): Promise<string> {
  const key = process.env.JWT_SECRET || `access-key:${code}`;
  return hmacHex(key, `trainer-access:${code}`);
}

/** Compares digests of both values so the comparison is constant-time regardless of input length. */
export async function codeMatches(input: string, code: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmacHex("code-compare", input), hmacHex("code-compare", code)]);
  return safeEqual(a, b);
}

const INVITE_PREFIX = "inv.";

/**
 * Gate cookie for an invite: `inv.<inviteId>.<expiresAtSec>.<hmac>`, keyed by
 * JWT_SECRET. Carries the invite id so registration can attribute the account.
 * Returns null without a usable JWT_SECRET (no secret, no invite passes).
 */
export async function inviteAccessToken(inviteId: string, expiresAtSec: number): Promise<string | null> {
  const key = process.env.JWT_SECRET;
  if (!key || key.length < 32 || !/^[A-Za-z0-9_-]{1,64}$/.test(inviteId)) return null;
  const exp = Math.floor(expiresAtSec);
  return `${INVITE_PREFIX}${inviteId}.${exp}.${await hmacHex(key, `trainer-invite:${inviteId}:${exp}`)}`;
}

/** The invite id from a valid, unexpired invite gate cookie, else null. Signature only; the database is not consulted. */
export async function verifyInviteAccessToken(value: string, nowMs = Date.now()): Promise<string | null> {
  if (!value.startsWith(INVITE_PREFIX)) return null;
  const parts = value.slice(INVITE_PREFIX.length).split(".");
  if (parts.length !== 3) return null;
  const [id, expRaw] = parts;
  const exp = Number(expRaw);
  if (!/^\d{1,12}$/.test(expRaw) || exp * 1000 <= nowMs) return null;
  const expected = await inviteAccessToken(id, exp);
  if (!expected) return null;
  return safeEqual(value, expected) ? id : null;
}

/** Whether a gate cookie lets the request through: the shared-code cookie (while allowed) or a signed invite cookie. */
export async function gateCookieValid(cookie: string, nowMs = Date.now()): Promise<boolean> {
  if (!cookie) return false;
  if (cookie.startsWith(INVITE_PREFIX)) return (await verifyInviteAccessToken(cookie, nowMs)) !== null;
  const code = accessCode();
  if (!code || !sharedCodeAllowed()) return false;
  return safeEqual(cookie, await accessToken(code));
}
