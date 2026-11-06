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
 * the allowlist above. It reads the durable voiceTier column (written by the server at mint, or from a verified receipt
 * on an unmetered save) and returns one label. It never reads the model column and never maps a model id at read time.
 */
export const VOICE_USED_SELECT = { userId: true, organizationId: true, voiceTier: true, allowanceId: true, engineTier: true } as const satisfies Prisma.TrainerSessionSelect;
export type VoiceUsedRow = Prisma.TrainerSessionGetPayload<{ select: typeof VOICE_USED_SELECT }>;

/**
 * "premium" or "standard" for a voice call, null for a text call. The stored voiceTier decides. A metered row from
 * before that column existed falls back to its billing engine (durable too, but it reads a comped call as standard).
 */
export function voiceUsedView(r: Pick<VoiceUsedRow, "voiceTier" | "allowanceId" | "engineTier">): "premium" | "standard" | null {
  if (r.voiceTier === "premium" || r.voiceTier === "standard") return r.voiceTier;
  if (r.allowanceId) return r.engineTier === "premium" ? "premium" : "standard";
  return null;
}

/**
 * One entry of GET /api/transcripts (the Logbook and history), built field by field so nothing else on the row can pass
 * through. `voiceUsed` is the neutral tier label ("premium" | "standard") from the durable voiceTier column only: never
 * the model, never a guess. A row without a stored tier (a text call, or one older than the column) is null, and the
 * Logbook shows no label for it (Prism finding 4).
 */
export interface SessionListRow {
  id: string; scenarioId: string; scenarioTitle: string | null; scenarioCategory: string | null; durationSeconds: number;
  overallScore: number | null; grade: string | null; goalAchieved: boolean | null; createdAt: Date; evaluation: unknown; voiceTier: string | null;
}
export function sessionListItem(r: SessionListRow) {
  const ev = r.evaluation as { graderVersion?: unknown; method?: unknown } | null;
  // Every key is always present (null when unset), so the shape is the same for every entry.
  return {
    id: r.id,
    scenarioId: r.scenarioId,
    scenarioTitle: r.scenarioTitle ?? null,
    scenarioCategory: r.scenarioCategory ?? null,
    durationSeconds: r.durationSeconds ?? 0,
    overallScore: r.overallScore ?? null,
    grade: r.grade ?? null,
    goalAchieved: r.goalAchieved ?? null,
    createdAt: r.createdAt,
    // Only the grader version and method, not the whole evaluation blob.
    graderVersion: typeof ev?.graderVersion === "string" ? ev.graderVersion : null,
    graderMethod: typeof ev?.method === "string" ? ev.method : null,
    voiceUsed: r.voiceTier === "premium" || r.voiceTier === "standard" ? r.voiceTier : null,
  };
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
