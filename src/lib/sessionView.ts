import type { Prisma } from "@prisma/client";
import { withoutModelId } from "./gradable";

/**
 * What GET /api/transcripts/[id] reads and returns for one stored session. An explicit allowlist, never the
 * whole row: TrainerSession also holds server-only columns (realtimeModel, the voice model id from a mint receipt;
 * engineTier and the metering fields; organizationId), and any column added later stays out until it is listed here.
 */

/** Columns read from the database: the debrief's fields, plus organizationId for the access check only. */
export const SESSION_VIEW_SELECT = {
  id: true,
  userId: true,
  organizationId: true,
  scenarioId: true,
  scenarioTitle: true,
  scenarioCategory: true,
  scenarioDifficulty: true,
  durationSeconds: true,
  transcript: true,
  evaluation: true,
  overallScore: true,
  grade: true,
  goalAchieved: true,
  supervisorNotes: true,
  supervisorNotesBy: true,
  supervisorNotesAt: true,
  createdAt: true,
} as const satisfies Prisma.TrainerSessionSelect;

export type SessionViewRow = Prisma.TrainerSessionGetPayload<{ select: typeof SESSION_VIEW_SELECT }>;

/**
 * The debrief's "voice used" label is served separately (GET /api/transcripts/[id]/voice) so this view stays exactly
 * the allowlist above. It reads three server-only columns and returns one label, never the columns themselves.
 */
export const VOICE_USED_SELECT = { userId: true, organizationId: true, allowanceId: true, engineTier: true, realtimeModel: true } as const satisfies Prisma.TrainerSessionSelect;
export type VoiceUsedRow = Prisma.TrainerSessionGetPayload<{ select: typeof VOICE_USED_SELECT }>;

/**
 * "premium" or "standard" for a voice call, null for a text call. A model logged from a mint receipt decides (through
 * `tierOf`, which maps the id to a tier on the server); otherwise a metered call's paid engine (engineTier) does.
 */
export function voiceUsedView(r: Pick<VoiceUsedRow, "allowanceId" | "engineTier" | "realtimeModel">, tierOf: (model: string) => "premium" | "standard" | null): "premium" | "standard" | null {
  const fromModel = r.realtimeModel ? tierOf(r.realtimeModel) : null;
  if (fromModel === "premium") return "premium";
  if (r.allowanceId) return r.engineTier === "premium" ? "premium" : "standard";
  return fromModel;
}

/** The response body's `session`, built field by field so nothing else on the row can pass through. */
export function sessionView(r: SessionViewRow) {
  return {
    id: r.id,
    userId: r.userId,
    scenarioId: r.scenarioId,
    scenarioTitle: r.scenarioTitle,
    scenarioCategory: r.scenarioCategory,
    scenarioDifficulty: r.scenarioDifficulty,
    durationSeconds: r.durationSeconds,
    transcript: r.transcript,
    // Older AI grades stored the grader's model id inside the evaluation; it is dropped here too.
    evaluation: withoutModelId(r.evaluation),
    overallScore: r.overallScore,
    grade: r.grade,
    goalAchieved: r.goalAchieved,
    supervisorNotes: r.supervisorNotes,
    supervisorNotesBy: r.supervisorNotesBy,
    supervisorNotesAt: r.supervisorNotesAt,
    createdAt: r.createdAt,
  };
}
