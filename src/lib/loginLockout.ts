import "server-only";
import { NextResponse } from "next/server";
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

/** A fully successful sign-in (or proof) clears the counters, as login always has. */
export async function clearAuthFailures(userId: string, extra: { lastLoginAt?: Date } = {}): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedLoginCount: 0, lockedUntil: null, ...extra },
  });
}
