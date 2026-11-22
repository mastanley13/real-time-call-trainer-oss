/** Client-safe evaluation types (mirrors src/lib/grader.ts, which is server-only). */
export interface CriterionResult {
  id: string;
  name: string;
  weight: number;
  score: number;
  rationale: string;
  /** `line` is the 1-based position of the matching turn in the transcript. */
  evidence: { speaker: "trainee" | "caller"; quote: string; line?: number }[];
}

export type GoalStatus = "achieved" | "partial" | "not_achieved";

/** Bump when grading logic/scale changes; sessions without it come from the legacy keyword grader. */
export const GRADER_VERSIONS = { llm: "llm-v2", heuristic: "heuristic-v2" } as const;

export interface Evaluation {
  method: "llm" | "heuristic";
  graderVersion?: string;
  /**
   * Legacy only: AI grades saved before model ids were removed from user-visible output may still carry one.
   * New grades never set it, the UI never shows it, and API responses strip it (withoutModelId in gradable.ts).
   */
  model?: string;
  /** ISO time the grade was produced (set by the API routes). */
  evaluatedAt?: string;
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  criteria: CriterionResult[];
  strengths: string[];
  improvements: string[];
  goalAchievement: { achieved: boolean; status?: GoalStatus; explanation: string };
  note?: string;
  /**
   * True when AI grading was configured but failed for this call, so this is a rules-based stand-in. Never set when no
   * model is configured. Optional, so older stored grades without it still read as before.
   */
  llmFailed?: boolean;
}

/** Plain-language label for a 0-100 score. */
export function scoreLabel(score: number): string {
  return score >= 90 ? "Excellent" : score >= 80 ? "Strong" : score >= 70 ? "Good" : score >= 60 ? "Getting there" : "Needs practice";
}

/** Goal status for new (status) and legacy (boolean-only) evaluations. */
export function goalStatusOf(ev: Pick<Evaluation, "goalAchievement">): GoalStatus {
  return ev.goalAchievement.status ?? (ev.goalAchievement.achieved ? "achieved" : "not_achieved");
}

/** Legacy = keyword/heuristic grader from before versioning. LLM-graded sessions (round 2) lack graderVersion but are not legacy. */
export const isLegacyGrader = (ev: Pick<Evaluation, "graderVersion" | "method"> | null | undefined) => !!ev && !ev.graderVersion && ev.method !== "llm";

/**
 * Who produced this grade, for provenance lines: "AI" for model grades and "rules-based" for the heuristic.
 * Never a model id, even when a legacy grade still carries one.
 */
export function graderLabel(ev: Pick<Evaluation, "method">): string {
  return ev.method === "llm" ? "AI" : "rules-based";
}

/**
 * A rules-based stand-in for an AI grade that failed. The debrief shows a retry panel instead of a letter grade.
 * An AI grade never counts, even if a stray flag were stored with it.
 */
export function isLlmFailedGrade(ev: { method?: string | null; llmFailed?: unknown } | null | undefined): boolean {
  return !!ev && ev.llmFailed === true && ev.method !== "llm";
}

/** The Logbook's score cell: score and letter, a neutral "Grading pending" for a failed AI grade, or "Ungraded". */
export type LogbookScore =
  | { kind: "score"; score: number; grade: string | null; label: string }
  | { kind: "pending"; label: "Grading pending" }
  | { kind: "ungraded"; label: "Ungraded" };

export function logbookScore(row: { score: number | null; grade: string | null; llmFailed: boolean }): LogbookScore {
  if (row.llmFailed) return { kind: "pending", label: "Grading pending" };
  if (row.score === null) return { kind: "ungraded", label: "Ungraded" };
  return { kind: "score", score: row.score, grade: row.grade, label: `Score ${row.score}, grade ${row.grade}` };
}

/** What the debrief's score header shows: nothing, the retry panel, or the score ring with its letter grade. */
export type DebriefHeadline =
  | { kind: "ungraded" }
  | { kind: "catching_up"; estimate: string }
  | { kind: "grade"; score: number; grade: Evaluation["grade"] };

export function debriefHeadline(ev: Pick<Evaluation, "method" | "llmFailed" | "overallScore" | "grade"> | null | undefined): DebriefHeadline {
  if (!ev) return { kind: "ungraded" };
  if (isLlmFailedGrade(ev)) return { kind: "catching_up", estimate: roughEstimateLabel(ev.overallScore) };
  return { kind: "grade", score: ev.overallScore, grade: ev.grade };
}

/** The secondary line under the retry panel. A score out of 100, never a letter. */
export function roughEstimateLabel(score: number): string {
  return `Rough estimate (rules-based): ${Math.round(Math.min(100, Math.max(0, score)))}/100`;
}

/** Removes the internal post-check note that older gradings appended to rationales. */
export function stripGraderNote(r: string): string {
  return r.replace(/\s*\(Note: the quoted evidence shows[^)]*\)/g, "").trim();
}
