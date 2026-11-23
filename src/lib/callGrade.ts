import "server-only";
import type { Prisma } from "@prisma/client";

/**
 * One graded row per call. A call is identified by its owner and the `realtimeSessionId` its save named (the client's
 * sessionId). A save that is not allowed to claim the call's graded row (a seal replay, a fill that lost a race) is
 * still kept, as a separate ungraded row with the same realtimeSessionId. Without this check that copy could then be
 * graded through PATCH /api/transcripts/[id] (the owner may re-grade while a row has no AI grade), so one call would
 * count twice in team metrics.
 *
 * Every write that stores a grade, in POST /api/transcripts and in the PATCH re-grade, runs in one interactive
 * transaction that first takes lockCallGrade and then checks hasGradedSibling, and stores the grade only when no other
 * row of the call has a score. The lock is a transaction-scoped advisory lock (released at commit or rollback, the same
 * pattern as the first-graded-call claim in ghlWebhook.ts), so two grade writes for one call run one after the other and
 * the second sees the first's committed row (Postgres READ COMMITTED reads each statement's snapshot after the lock is
 * granted). A hash collision between two calls only makes them wait for each other; it never skips the check.
 *
 * Out of scope (SAL-1050): a rep can still post an arbitrary transcript under a NEW sessionId and re-grade that row,
 * because the server does not record the turns of a call itself. This guard only stops two graded rows for one sessionId.
 */
export const CALL_GRADE_LOCK_PREFIX = "ct-call-grade:";

/** Serializes grade writes for one call until the transaction ends. */
export async function lockCallGrade(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string, realtimeSessionId: string): Promise<void> {
  // SELECT ... FROM the function, so the result column is an int Prisma can read, not void. JSON keeps the two ids apart.
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${CALL_GRADE_LOCK_PREFIX + JSON.stringify([userId, realtimeSessionId])}::text))`;
}

/** True when another row (not `rowId`) of this user's call already has a score. Read it under lockCallGrade. */
export async function hasGradedSibling(
  tx: Pick<Prisma.TransactionClient, "trainerSession">,
  userId: string,
  realtimeSessionId: string,
  rowId: string,
): Promise<boolean> {
  const other = await tx.trainerSession.findFirst({
    where: { userId, realtimeSessionId, overallScore: { not: null }, id: { not: rowId } },
    select: { id: true },
  });
  return !!other;
}
