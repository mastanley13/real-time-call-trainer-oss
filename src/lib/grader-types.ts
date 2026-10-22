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
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  criteria: CriterionResult[];
  strengths: string[];
  improvements: string[];
  goalAchievement: { achieved: boolean; status?: GoalStatus; explanation: string };
  note?: string;
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

/** Removes the internal post-check note that older gradings appended to rationales. */
export function stripGraderNote(r: string): string {
  return r.replace(/\s*\(Note: the quoted evidence shows[^)]*\)/g, "").trim();
}
