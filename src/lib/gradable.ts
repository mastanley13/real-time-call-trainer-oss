/**
 * What the grader reads, and who may re-grade a stored call. Pure and client-safe:
 * POST /api/evaluate-call, the PATCH re-grade and the debrief share one copy, so they can't drift.
 */

/**
 * The grader reads whole calls, so its limits are far above the live coach's: a
 * 60-minute voice call is roughly 600 turns and 60,000 characters. Anything past
 * these is graded on the opening part and the debrief says so, instead of failing.
 */
export const GRADE_MAX_TURNS = 1000;
export const GRADE_MAX_CHARS = 120_000;

/** The opening turns that fit the grader's limits. Keeps the head so evidence line numbers still match the transcript. */
export function gradable<T extends { text: string }>(turns: T[]): T[] {
  let chars = 0;
  let n = 0;
  while (n < turns.length && n < GRADE_MAX_TURNS && chars + turns[n].text.length <= GRADE_MAX_CHARS) chars += turns[n++].text.length;
  return turns.slice(0, Math.max(1, n));
}

const CAPPED = "This call was longer than the grader reads";

/** The grader's own note plus, when `gradable` dropped turns, a line saying how many were graded. Undefined when both are empty. */
export function gradedNote(note: string | undefined, graded: number, total: number): string | undefined {
  const cappedNote = graded < total ? `${CAPPED}, so only the first ${graded} of ${total} turns were graded.` : "";
  return [note, cappedNote].filter(Boolean).join(" ") || undefined;
}

/** True when a stored grade's note has the line `gradedNote` adds for a capped call, so the debrief doesn't claim it read the full transcript. */
export function wasCapped(note: string | undefined): boolean {
  return !!note?.includes(CAPPED);
}

/** A grade the AI model produced. Rules-based grades, legacy grades and missing grades are not. */
export function isAiGrade(evaluation: unknown): boolean {
  return !!evaluation && typeof evaluation === "object" && (evaluation as { method?: unknown }).method === "llm";
}

/**
 * Managers and owners of the session's org, and platform admins, can always re-grade it.
 * The session's own trainee can re-grade only while it has no AI grade, so a rep can't
 * re-roll an AI score that team views and assignment completion read.
 */
export function canRegrade(actor: { managesOrg: boolean; ownsSession: boolean }, evaluation: unknown): boolean {
  return actor.managesOrg || (actor.ownsSession && !isAiGrade(evaluation));
}
