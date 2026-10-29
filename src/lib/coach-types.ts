/**
 * Live-coach contract shared by the client (copilot rail) and the server
 * (/api/coach/turn). The coach is a separate channel from the persona: cues
 * are shown only to the rep and are never sent to the caller.
 */
import { z } from "zod";

export const CUE_TYPES = ["objection", "next_question", "whisper", "guardrail"] as const;
export type CueType = (typeof CUE_TYPES)[number];

export const CUE_LABELS: Record<CueType, string> = {
  objection: "Objection",
  next_question: "Next question",
  whisper: "Whisper",
  guardrail: "Guardrail",
};

export const CueSchema = z.object({
  type: z.enum(CUE_TYPES),
  /** Short headline, e.g. "Explain the fee before the slot". */
  title: z.string().min(1).max(80),
  /** One-sentence coaching note. */
  message: z.string().max(240),
  /** A line the rep could say next. Never auto-sent. */
  suggestedLine: z.string().max(300).optional(),
  /** 1-based transcript position of the turn that triggered the cue. */
  triggerTurn: z.number().int().min(1),
  /** Rubric criterion id this cue serves, when there is one. */
  criterionId: z.string().max(60).optional(),
});
export type Cue = z.infer<typeof CueSchema>;

export interface CriterionEstimate {
  id: string;
  name: string;
  /** Normalised weight (all criteria sum to 100). */
  weight: number;
  /** 0-100 partial-credit estimate so far. */
  score: number;
  /** True once a verbatim trainee quote backs the score (drawn solid, not hatched). */
  confirmed: boolean;
  /** 1-based transcript line of the best supporting quote. */
  evidenceLine?: number;
}

export interface CoachResult {
  estimate: { overall: number; criteria: CriterionEstimate[] };
  /** One flag per talk-track step (see talkTrackSteps in scenarios.ts). */
  steps: boolean[];
  /** At most one new cue per call, or null when nothing is worth saying. */
  cue: Cue | null;
  /** Stable key for the cue (e.g. "objection:price"), so the client can avoid repeats via recentCueKeys. */
  cueKey?: string;
  /** Share of words spoken by the rep, 0-1. */
  talkRatio: number;
  source: "llm" | "heuristic";
  /** Model id when source is "llm". */
  model?: string;
  latencyMs: number;
}

/** Blind = no live help; Guided = live estimate and talk track only; Coached = everything including cues. */
export const COACH_MODES = ["blind", "guided", "coached"] as const;
export type CoachMode = (typeof COACH_MODES)[number];
export const COACH_MODE_LABELS: Record<CoachMode, string> = { blind: "Blind", guided: "Guided", coached: "Coached" };

export const CoachTurnSchema = z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(4000) });
