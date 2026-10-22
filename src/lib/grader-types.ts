/** Client-safe evaluation types (mirrors src/lib/grader.ts, which is server-only). */
export interface CriterionResult {
  id: string;
  name: string;
  weight: number;
  score: number;
  rationale: string;
  evidence: { speaker: "trainee" | "caller"; quote: string }[];
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
