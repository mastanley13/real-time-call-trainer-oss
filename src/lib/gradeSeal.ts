import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Grade seals. /api/evaluate-call signs every grade it produces with an HMAC keyed by
 * JWT_SECRET, over the user, the persona id, a digest of the graded transcript and the
 * whole evaluation. POST /api/transcripts stores a score only when the seal checks out,
 * so a client can't save a grade it made up (team KPIs and assignment completion read
 * these rows). Without JWT_SECRET nothing is sealed and nothing verifies.
 */

const VERSION = "grade-seal-v1";

/** JSON with object keys sorted, so a parse and re-stringify in the browser can't change the digest. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x === undefined ? null : x)).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}

/** Digest of what was said, in order. Timestamps are ignored: they are not graded. */
export function transcriptDigest(turns: { role: string; text: string }[]): string {
  return createHash("sha256").update(JSON.stringify(turns.map((t) => [t.role, t.text]))).digest("hex");
}

export interface SealInput {
  userId: string;
  scenarioId: string;
  transcript: { role: string; text: string }[];
  /** The evaluation exactly as returned to the client, without the seal itself. */
  evaluation: unknown;
}

function mac(key: string, input: SealInput): string {
  const payload = stableStringify({ v: VERSION, u: input.userId, s: input.scenarioId, t: transcriptDigest(input.transcript), e: input.evaluation });
  return createHmac("sha256", key).update(payload).digest("hex");
}

const sealKey = () => process.env.JWT_SECRET?.trim() || undefined;

/** Seal for a grade the server just produced, or undefined when JWT_SECRET is unset. */
export function sealEvaluation(input: SealInput, key = sealKey()): string | undefined {
  return key ? mac(key, input) : undefined;
}

/** True only when `seal` is the server's own seal over exactly this user, persona, transcript and evaluation. */
export function verifySeal(input: SealInput, seal: unknown, key = sealKey()): boolean {
  if (!key || typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal)) return false;
  return timingSafeEqual(Buffer.from(mac(key, input), "hex"), Buffer.from(seal, "hex"));
}
