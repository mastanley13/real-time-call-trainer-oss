import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Grade seals. /api/evaluate-call signs every grade it produces with an HMAC keyed by
 * JWT_SECRET, over the user, the call's sessionId, the persona id, a digest of the graded
 * transcript and the whole evaluation. POST /api/transcripts stores a score only when the
 * seal checks out for the sessionId it saves under and the grade is fresh, so a client can't
 * save a grade it made up (team KPIs and assignment completion read these rows), attach one
 * call's grade to another call, or keep a grade and save it much later. Single use (one graded
 * row per seal) is enforced by the save itself; see the comments in POST /api/transcripts.
 * Without JWT_SECRET nothing is sealed and nothing verifies.
 */

/** v2 binds the sessionId. A v1 seal (no sessionId) never verifies, so it can't be saved under any call. */
const VERSION = "grade-seal-v2";

/**
 * How old a sealed grade may be when it is saved. The client saves right after grading, so this only has to cover
 * a slow network; a grade kept longer than this is saved ungraded and can be re-graded later.
 */
export const GRADE_SEAL_MAX_AGE_MS = 30 * 60 * 1000;
/** Clock skew allowed between server instances for evaluatedAt. */
const SKEW_MS = 60_000;

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
  /** The call the grade belongs to: the same id the client later saves it under as `sessionId`. */
  sessionId: string;
  scenarioId: string;
  transcript: { role: string; text: string }[];
  /** The evaluation exactly as returned to the client, without the seal itself. */
  evaluation: unknown;
}

function mac(key: string, input: SealInput): string {
  const payload = stableStringify({ v: VERSION, u: input.userId, c: input.sessionId, s: input.scenarioId, t: transcriptDigest(input.transcript), e: input.evaluation });
  return createHmac("sha256", key).update(payload).digest("hex");
}

const sealKey = () => process.env.JWT_SECRET?.trim() || undefined;

/** Seal for a grade the server just produced, or undefined when JWT_SECRET is unset or there is no sessionId to bind. */
export function sealEvaluation(input: SealInput, key = sealKey()): string | undefined {
  return key && input.sessionId ? mac(key, input) : undefined;
}

/**
 * True when the sealed evaluation's evaluatedAt is a parseable time no older than GRADE_SEAL_MAX_AGE_MS and not in
 * the future beyond a small skew. evaluatedAt is inside the MAC, so it is the server's own grading time.
 */
export function isSealFresh(evaluation: unknown, now = Date.now()): boolean {
  const at = evaluation && typeof evaluation === "object" ? (evaluation as { evaluatedAt?: unknown }).evaluatedAt : undefined;
  if (typeof at !== "string") return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t <= now + SKEW_MS && now - t <= GRADE_SEAL_MAX_AGE_MS;
}

/**
 * True only when `seal` is the server's own seal over exactly this user, sessionId, persona, transcript and
 * evaluation, and the grade is still fresh (isSealFresh). Single use is not checked here: the save enforces it.
 */
export function verifySeal(input: SealInput, seal: unknown, key = sealKey(), now = Date.now()): boolean {
  if (!key || typeof seal !== "string" || !/^[0-9a-f]{64}$/.test(seal) || !input.sessionId) return false;
  if (!timingSafeEqual(Buffer.from(mac(key, input), "hex"), Buffer.from(seal, "hex"))) return false;
  return isSealFresh(input.evaluation, now);
}
