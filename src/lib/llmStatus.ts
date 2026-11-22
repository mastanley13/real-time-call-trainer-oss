import "server-only";

/**
 * Outcome of the most recent chat model call on this server instance, kept in process memory only. /api/health
 * reads it so `checks.llm` reflects what the provider actually said, without making a billable call itself.
 *
 * Stores the outcome class, a timestamp and a failure counter. Never a key, URL, model id, provider body, user or
 * prompt.
 */
export type LlmOutcome = "ok" | "auth_failed" | "quota" | "error";

export interface LlmStatus {
  last: LlmOutcome | null;
  at: string | null;
  consecutiveFailures: number;
}

let last: LlmOutcome | null = null;
let at: string | null = null;
let consecutiveFailures = 0;
/** Bumped by every record and reset, so a late refinement only applies to the record it belongs to. */
let seq = 0;

/** Maps an HTTP status to an outcome. A 429 counts as quota only when the caller knows it was a quota answer. */
export function llmOutcomeFromStatus(status: number, opts: { quota?: boolean } = {}): LlmOutcome {
  if (status >= 200 && status < 300) return "ok";
  if (status === 401 || status === 403) return "auth_failed";
  if (status === 429 && opts.quota) return "quota";
  return "error";
}

/** Records one call's outcome. Returns a token for refineLlmOutcome. */
export function recordLlmOutcome(outcome: LlmOutcome, now: number = Date.now()): number {
  last = outcome;
  at = new Date(now).toISOString();
  consecutiveFailures = outcome === "ok" ? 0 : consecutiveFailures + 1;
  return ++seq;
}

/**
 * Replaces a provisional failure outcome (recorded from the HTTP status alone) once the error body has been read, for
 * example error to quota for a 429. Applies only while `token` is still the latest record, and only failure to failure,
 * so the time and the failure count stay those of the original record. Returns whether it applied.
 */
export function refineLlmOutcome(token: number, outcome: LlmOutcome): boolean {
  if (token !== seq || last === null || last === "ok" || outcome === "ok") return false;
  last = outcome;
  return true;
}

export function getLlmStatus(): LlmStatus {
  return { last, at, consecutiveFailures };
}

/** Tests only. */
export function resetLlmStatus(): void {
  last = null;
  at = null;
  consecutiveFailures = 0;
  seq++;
}
