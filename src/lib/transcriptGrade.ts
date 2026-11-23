import "server-only";
import type { Prisma } from "@prisma/client";
import { transcriptDigest } from "@/lib/gradeSeal";

/**
 * One graded row per transcript: a user holds at most one graded row for the same transcript of the same persona in
 * the same organization, whatever sessionId each copy was saved under. src/lib/callRow.ts keeps one graded row per
 * call (per sessionId); this closes the gap between calls. Without it, a transcript saved again under a new sessionId
 * (a replayed seal, an expired or tampered one, no seal at all, or a fresh seal from grading the same transcript
 * again) lands on that sessionId's own row, which a save or a re-grade could then grade, so one practice call would
 * count twice for assignment completion and team KPIs.
 *
 * Every write that turns an ungraded row into a graded one checks it: the graded save paths in POST /api/transcripts
 * (stored ungraded instead) and PATCH /api/transcripts/[id] (403 regrade_not_allowed), for everyone, platform admins
 * included. Re-grading a row that already has a score never adds a graded row, so it is not checked.
 *
 * "Same transcript" is transcriptDigest from gradeSeal.ts, the digest the seal signs: roles and text in order,
 * timestamps ignored. Only the GRADED_DUPLICATE_SCAN most recent graded rows of that user, organization and persona
 * are compared, so a copy of a call older than that many graded calls on the same persona is not caught. That keeps
 * the check one indexed read of a bounded size.
 *
 * Race: the check runs again under lockTranscript, in the transaction that writes the grade, so two writes for two
 * copies of one transcript run one after the other and the second sees the first's committed grade.
 *
 * Lock order: a transaction that takes both locks takes lockCall (callRow.ts) first and lockTranscript second, never
 * the other way round, so they can't deadlock. A transaction that needs only one takes only that one.
 */

/** How many of the most recent graded rows (same user, organization and persona) the duplicate check compares. */
export const GRADED_DUPLICATE_SCAN = 200;

/** transcriptDigest of a stored transcript, or null when it isn't a list of turns with a string role and text. */
export function storedTranscriptDigest(stored: unknown): string | null {
  if (!Array.isArray(stored)) return null;
  const turns: { role: string; text: string }[] = [];
  for (const t of stored) {
    if (!t || typeof t !== "object") return null;
    const { role, text } = t as { role?: unknown; text?: unknown };
    if (typeof role !== "string" || typeof text !== "string") return null;
    turns.push({ role, text });
  }
  return transcriptDigest(turns);
}

export interface TranscriptScope {
  /** The row's owner (the user who made the call), not whoever is acting. */
  userId: string;
  organizationId: string;
  scenarioId: string;
  /** The row being graded, never counted as its own duplicate. */
  excludeId: string;
}

type Reader = Pick<Prisma.TransactionClient, "trainerSession">;

/** True when another graded row in `scope` holds a transcript with this digest. Read it again under lockTranscript before writing. */
export async function hasGradedDuplicate(db: Reader, scope: TranscriptScope, digest: string): Promise<boolean> {
  const rows = await db.trainerSession.findMany({
    where: { userId: scope.userId, organizationId: scope.organizationId, scenarioId: scope.scenarioId, overallScore: { not: null }, id: { not: scope.excludeId } },
    orderBy: { createdAt: "desc" },
    take: GRADED_DUPLICATE_SCAN,
    select: { transcript: true },
  });
  return rows.some((r) => storedTranscriptDigest(r.transcript) === digest);
}

const LOCK_PREFIX = "ct-transcript-grade:";

/** Serializes grade writes for one user's transcript until the transaction ends. Take it after lockCall, never before. */
export async function lockTranscript(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string, digest: string): Promise<void> {
  // SELECT ... FROM the function, so the result column is an int Prisma can read, not void (as in callRow.ts).
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + JSON.stringify([userId, digest])}::text))`;
}
