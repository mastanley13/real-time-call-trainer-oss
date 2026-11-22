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
 * Count one failed secret. The increment is atomic, so concurrent failures from different IPs are all counted. The
 * request that reaches MAX_FAILED_LOGINS arms the lock and resets the count to 0, the same end state the login route
 * has always written. Returns whether this failure locked the account.
 */
export async function recordAuthFailure(userId: string): Promise<{ locked: boolean }> {
  const { failedLoginCount } = await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: { increment: 1 } },
    select: { failedLoginCount: true },
  });
  if (failedLoginCount < MAX_FAILED_LOGINS) return { locked: false };
  const armed = await prisma.user.updateMany({
    where: { id: userId, failedLoginCount: { gte: MAX_FAILED_LOGINS } },
    data: { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) },
  });
  return { locked: armed.count > 0 };
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
    where: { id: userId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
    data: { failedLoginCount: 0, lockedUntil: null, ...extra },
  });
  return count === 1;
}
