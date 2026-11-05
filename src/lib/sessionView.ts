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
