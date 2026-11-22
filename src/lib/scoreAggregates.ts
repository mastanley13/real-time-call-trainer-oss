/**
 * Which stored scores may enter score math: averages, best score, trends, sparklines and per-criterion averages on the
 * rep dashboard and in the team view. Pure and client-safe.
 *
 * A failed AI grade (isLlmFailedGrade) keeps a rules-based rough score in the stored row, so the call still counts as
 * a call (session counts, minutes, practice days), but that score never enters score math.
 */
import { isLlmFailedGrade } from "./grader-types";

/** A stored evaluation blob of unknown shape is a failed AI grade (evaluation.llmFailed on a non-AI grade). */
export function isLlmFailedEvaluation(evaluation: unknown): boolean {
  if (!evaluation || typeof evaluation !== "object" || Array.isArray(evaluation)) return false;
  const ev = evaluation as { method?: unknown; llmFailed?: unknown };
  return isLlmFailedGrade({ method: typeof ev.method === "string" ? ev.method : null, llmFailed: ev.llmFailed });
}

/**
 * The one include/exclude rule: the score to use in aggregates, or null when the call has no finite score or its
 * score is a failed-grade rough estimate.
 */
export function aggregateScore(entry: { score: number | null | undefined; llmFailed?: boolean }): number | null {
  if (entry.llmFailed) return null;
  return typeof entry.score === "number" && Number.isFinite(entry.score) ? entry.score : null;
}

type Scored = { score: number | null | undefined; llmFailed?: boolean };

/** Rounded mean of the scores that count, or null when none do. */
export function averageScore(rows: Scored[]): number | null {
  const nums = rows.map(aggregateScore).filter((v): v is number => v !== null);
  return nums.length ? Math.round(nums.reduce((a, v) => a + v, 0) / nums.length) : null;
}

/** Highest score that counts, or null when none do. */
export function bestScore(rows: Scored[]): number | null {
  const nums = rows.map(aggregateScore).filter((v): v is number => v !== null);
  return nums.length ? Math.max(...nums) : null;
}

/** Trend points: from rows ordered newest first, the latest `n` that count, returned oldest first. */
export function trendPoints<T extends Scored>(rowsNewestFirst: T[], n = 20): (T & { score: number })[] {
  return rowsNewestFirst
    .filter((r) => aggregateScore(r) !== null)
    .slice(0, n)
    .reverse() as (T & { score: number })[];
}
