import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  signSessionToken,
  verifyMfaChallenge,
  type SessionRole,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { verifyTotp } from "@/lib/mfa";
import { consumeRecoveryCode } from "@/lib/mfaRecovery";
import { linkGoogleAtomically } from "@/lib/googleAuth";
import { clearAuthFailures, isLocked, lockedResponse, recordAuthFailure } from "@/lib/loginLockout";
import { clientIp, rateLimit } from "@/lib/rateLimit";

const BodySchema = z
  .object({
    challengeToken: z.string().min(10),
    code: z.string().regex(/^[0-9]{6}$/).optional(),
    /** A recovery code as typed. Case, spaces and dashes are normalized server-side (mfaRecovery.ts). */
    recoveryCode: z.string().min(1).max(64).optional(),
  })
  .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), {
    message: "Send either code or recoveryCode",
  });

/**
 * Exchange an MFA challenge token (issued by /api/auth/login when MFA is
 * enabled on an account) plus a valid TOTP code, or one unused recovery code,
 * for a full session. Both kinds of attempt go through the same per-IP
 * limiter below and the same per-account lockout as password login, so
 * recovery codes add no extra guesses.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const limit = rateLimit({
    key: `mfa-challenge:${ip}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json(
      { error: "Invalid challenge payload" },
      { status: 400 },
    );
  }

  const challenge = verifyMfaChallenge(body.challengeToken);
  const userId = challenge?.id;
  if (!challenge || !userId) {
    return NextResponse.json(
      { error: "Expired or invalid challenge. Sign in again." },
      { status: 401 },
    );
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { organization: true },
  });
  if (!user || !user.mfaEnabled || !user.mfaSecret) {
    return NextResponse.json(
      { error: "MFA is not enabled on this account." },
      { status: 400 },
    );
  }

  // Same lockout as password login (loginLockout.ts): a locked account is refused before any code is checked or a
  // recovery code is spent, whichever IP the attempt comes from.
  if (isLocked(user)) return lockedResponse();

  const viaRecovery = body.recoveryCode !== undefined;
  const method = viaRecovery ? "recovery_code" : "totp";
  // A recovery code is spent atomically: once used here it can never be accepted again, even by a request racing this
  // one. If the Google link below is then refused, the code stays spent; failing closed is the safer side for a
  // single-use secret.
  const spent = body.recoveryCode !== undefined ? await consumeRecoveryCode(user.id, body.recoveryCode) : null;
  const accepted = spent ? spent.ok : verifyTotp(user.mfaSecret, body.code ?? "");

  if (!accepted) {
    // Both methods feed the account's failedLoginCount, shared with the password step, so guesses spread across
    // IPs are still bounded per account.
    const { locked } = await recordAuthFailure(user.id);
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_challenge_failed",
        ip,
        metadata: { method, ...(locked ? { locked: true } : {}) },
      },
    });
    if (locked) {
      await prisma.auditEvent.create({
        data: { userId: user.id, action: "user.login_locked", ip, metadata: { via: "mfa_challenge", method } },
      });
    }
    return NextResponse.json(
      {
        error: viaRecovery
          ? "That recovery code is not valid or was already used. Check it and try again."
          : "Invalid code",
      },
      { status: 401 },
    );
  }

  if (spent?.ok) {
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_recovery_code_used",
        ip,
        userAgent: req.headers.get("user-agent") ?? undefined,
        metadata: { remaining: spent.remaining },
      },
    });
  }

  // A Google link waiting on this challenge is written only now, after the code was accepted. The write is atomic
  // (no Google id yet, not locked). If it cannot be made, the challenge is refused: no session, no cookie.
  const linked = Boolean(challenge.linkGoogleSub);
  if (challenge.linkGoogleSub && !(await linkGoogleAtomically(prisma, user.id, challenge.linkGoogleSub))) {
    await prisma.auditEvent.create({ data: { userId: user.id, action: "user.mfa_challenge_failed", ip, metadata: { via: "google", reason: "link_refused" } } });
    return NextResponse.json({ error: "Google sign-in could not be completed. Sign in again." }, { status: 409 });
  }
  // A completed sign-in clears the counters, exactly as password login does without MFA.
  await clearAuthFailures(user.id, { lastLoginAt: new Date() });
  const successMeta = {
    ...(challenge.linkGoogleSub ? { via: "google", linked } : {}),
    ...(viaRecovery ? { method: "recovery_code" } : {}),
  };
  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.mfa_challenge_success",
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      ...(Object.keys(successMeta).length ? { metadata: successMeta } : {}),
    },
  });

  const sessionUser = {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    role: user.role as SessionRole,
  };
  const token = signSessionToken(sessionUser);
  const res = NextResponse.json({
    user: { ...sessionUser, isPlatformAdmin: user.isPlatformAdmin },
    organization: user.organization
      ? {
          id: user.organization.id,
          name: user.organization.name,
          code: user.organization.code,
        }
      : null,
    token,
  });
  res.cookies.set("authToken", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
  return res;
}
