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

export interface Evaluation {
  method: "llm" | "heuristic";
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  summary: string;
  criteria: CriterionResult[];
  strengths: string[];
  improvements: string[];
  goalAchievement: { achieved: boolean; explanation: string };
  note?: string;
}

/** Plain-language label for a 0-100 score. */
export function scoreLabel(score: number): string {
  return score >= 90 ? "Excellent" : score >= 80 ? "Strong" : score >= 70 ? "Good" : score >= 60 ? "Getting there" : "Needs practice";
}
