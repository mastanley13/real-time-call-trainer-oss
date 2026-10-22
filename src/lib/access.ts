/** Shared (edge + node) helpers for the optional TRAINER_ACCESS_CODE gate. Uses Web Crypto only. */

export const ACCESS_COOKIE = "trainer_access";
export const ACCESS_MAX_AGE = 30 * 24 * 60 * 60;

export function accessCode(): string | null {
  return process.env.TRAINER_ACCESS_CODE?.trim() || null;
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
