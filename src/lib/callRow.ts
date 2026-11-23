import "server-only";
import type { Prisma } from "@prisma/client";
import { receiptRowId } from "@/lib/mintReceipt";

/**
 * The call's own row: one graded row per call (per user and sessionId), for saves and re-grades alike.
 *
 * Every call has exactly one row that may hold its grade, found from the sessionId alone:
 * - a metered voice call: the row beginCall made at mint, whose id is the sessionId (filled by the first save);
 * - anything else: the row whose primary key is receiptRowId(sessionId), claimed by the first save of the call,
 *   graded or not (POST /api/transcripts).
 * Any other row that names the sessionId is a copy: a replay, a fill that lost a race, a save that left out its
 * callId. Saves never store a grade on a copy, and PATCH /api/transcripts/[id] refuses to re-grade one while the call
 * has its own row, for everyone (a platform admin re-grades the call's own row instead). That rule needs no lock: a
 * copy can never become graded, and only the call's own row can.
 *
 * Calls saved before the call's own row existed (legacy text saves, under a random row id) have only copies. They stay
 * re-gradable under the old rules while no other row of the call has a score. That check runs under lockCall in the
 * re-grade's transaction, so two re-grades of two such copies can't both add a grade. A save can't add one either:
 * POST /api/transcripts never claims the call's own row once a copy of the call exists without it (isLegacyCall).
 */

/** The ids the call's own row can have. */
export const callRowIds = (sessionId: string) => [sessionId, receiptRowId(sessionId)];

/** True when `id` is the own row of the call `sessionId`. */
export const isCallRow = (id: string, sessionId: string) => callRowIds(sessionId).includes(id);

type Reader = Pick<Prisma.TransactionClient, "trainerSession">;

/** True when this user's call has its own row. */
export async function hasCallRow(db: Reader, userId: string, sessionId: string): Promise<boolean> {
  return !!(await db.trainerSession.findFirst({ where: { userId, id: { in: callRowIds(sessionId) } }, select: { id: true } }));
}

/**
 * True when the call was saved before call rows existed: no row has the receiptRowId key, and a copy of this user's
 * names the sessionId. Callers have already found no row whose id is the sessionId. Read it under lockCall.
 */
export async function isLegacyCall(db: Reader, userId: string, sessionId: string): Promise<boolean> {
  const rowId = receiptRowId(sessionId);
  if (await db.trainerSession.findUnique({ where: { id: rowId }, select: { id: true } })) return false;
  return !!(await db.trainerSession.findFirst({ where: { userId, realtimeSessionId: sessionId, id: { not: rowId } }, select: { id: true } }));
}

/** True when a row of this user's call other than `rowId` has a score. */
export async function hasGradedSibling(db: Reader, userId: string, sessionId: string, rowId: string): Promise<boolean> {
  return !!(await db.trainerSession.findFirst({ where: { userId, realtimeSessionId: sessionId, overallScore: { not: null }, id: { not: rowId } }, select: { id: true } }));
}

const LOCK_PREFIX = "ct-call-grade:";

/**
 * Serializes re-grades of one legacy call until the transaction ends. JSON keeps the two ids apart. A transaction that
 * also takes lockTranscript (transcriptGrade.ts) takes this one first.
 */
export async function lockCall(tx: Pick<Prisma.TransactionClient, "$queryRaw">, userId: string, sessionId: string): Promise<void> {
  // SELECT ... FROM the function, so the result column is an int Prisma can read, not void (as in ghlWebhook.ts).
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${LOCK_PREFIX + JSON.stringify([userId, sessionId])}::text))`;
}
