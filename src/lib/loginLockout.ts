import "server-only";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Account lockout, shared by every step that checks a sign-in secret: the password at /api/auth/login, the TOTP or
 * recovery code at /api/auth/mfa/challenge, and the password or TOTP proof for regenerating recovery codes. All of
 * them count toward the same `failedLoginCount`, so guesses spread across steps or across IP addresses are still
 * bounded per account.
 */

export const MAX_FAILED_LOGINS = 8;
export const LOCKOUT_MINUTES = 15;
export const LOCKED_MESSAGE = "Account temporarily locked. Try again later.";

export function isLocked(user: { lockedUntil: Date | null }, now: Date = new Date()): boolean {
  return Boolean(user.lockedUntil && user.lockedUntil > now);
}

/** The login route's lockout answer: 423 with its own error text. */
export function lockedResponse(): NextResponse {
  return NextResponse.json({ error: LOCKED_MESSAGE }, { status: 423 });
}

/**
 * Count one failed secret, and arm the lock when this failure reaches MAX_FAILED_LOGINS, as one atomic transition.
 *
 * The increment is the transaction's first statement, so it takes the user row lock and holds it until commit; the
 * arming update (count back to 0, the end state the login route has always written, plus lockedUntil) runs under
 * that same lock. The success transition (clearAuthFailures) is an UPDATE of the same row, so it needs the same lock:
 * - If it runs first, this increment waits for it and counts from 0.
 * - If this runs first, it waits for the commit and then re-checks its where clause against the locked row, matches
 *   nothing, and the success is refused.
 * Nobody ever sees a count at the threshold without its lock. Concurrent failures from different IPs serialize on
 * the row and are all counted. Returns whether this failure locked the account.
 */
export async function recordAuthFailure(userId: string): Promise<{ locked: boolean }> {
  return prisma.$transaction(async (tx) => {
    const { failedLoginCount } = await tx.user.update({
      where: { id: userId },
      data: { failedLoginCount: { increment: 1 } },
      select: { failedLoginCount: true },
    });
    if (failedLoginCount < MAX_FAILED_LOGINS) return { locked: false };
    await tx.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
    });
    return { locked: true };
  });
}

/**
 * The success transition: clear the counters (and set `extra`, such as lastLoginAt) only if the account is not locked
 * at this moment. Routes check `lockedUntil` before verifying a secret, but failures from other requests can arm the
 * lock while the secret is being checked; an unconditional reset would then erase that lock. This is one conditional
 * UPDATE, so it either runs before the lock is armed (and the later failures count again from zero) or sees the lock
 * and changes nothing.
 *
 * Returns false when a lock was armed meanwhile: the caller must answer with lockedResponse() and must not issue a
 * session or write anything else. Pass a transaction client to make the transition part of a larger atomic write.
 */
export async function clearAuthFailures(
  userId: string,
  extra: { lastLoginAt?: Date } = {},
  db: Prisma.TransactionClient = prisma,
): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { id: userId, ...notLocked() },
    data: { failedLoginCount: 0, lockedUntil: null, ...extra },
  });
  return count === 1;
}

/**
 * The same lock-aware gate as clearAuthFailures, but it leaves failedLoginCount and lockedUntil alone. It is a
 * conditional UPDATE that changes nothing (count + 0), so it takes the user row lock and serializes with
 * recordAuthFailure in exactly the same way. Returns false when the account is locked; the caller answers with
 * lockedResponse() and writes nothing.
 *
 * Use it for successes whose proof must not reset the shared counter. A password alone must not clear failures that
 * MFA guesses built up: otherwise someone holding a session and the password could alternate wrong MFA codes with
 * password-proved actions and never reach the lockout.
 */
export async function holdIfUnlocked(userId: string, db: Prisma.TransactionClient = prisma): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { id: userId, ...notLocked() },
    data: { failedLoginCount: { increment: 0 } },
  });
  return count === 1;
}

/** Matches the user row only while it is not locked (no lock, or one that has run out). */
function notLocked() {
  return { OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] };
}
