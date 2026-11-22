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
 * limiter below, so recovery codes add no extra guesses.
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

  const viaRecovery = body.recoveryCode !== undefined;
  if (body.recoveryCode !== undefined) {
    // Spent atomically: a code used here can never be accepted again, even by a request racing this one. If the
    // Google link below is then refused, the code stays spent; failing closed is the safer side for a single-use secret.
    const spent = await consumeRecoveryCode(user.id, body.recoveryCode);
    if (!spent.ok) {
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          action: "user.mfa_challenge_failed",
          ip,
          metadata: { method: "recovery_code" },
        },
      });
      return NextResponse.json(
        { error: "That recovery code is not valid or was already used. Check it and try again." },
        { status: 401 },
      );
    }
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_recovery_code_used",
        ip,
        userAgent: req.headers.get("user-agent") ?? undefined,
        metadata: { remaining: spent.remaining },
      },
    });
  } else if (!verifyTotp(user.mfaSecret, body.code ?? "")) {
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_challenge_failed",
        ip,
      },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  // A Google link waiting on this challenge is written only now, after the code was accepted. The write is atomic
  // (no Google id yet, not locked). If it cannot be made, the challenge is refused: no session, no cookie.
  const linked = Boolean(challenge.linkGoogleSub);
  if (challenge.linkGoogleSub && !(await linkGoogleAtomically(prisma, user.id, challenge.linkGoogleSub))) {
    await prisma.auditEvent.create({ data: { userId: user.id, action: "user.mfa_challenge_failed", ip, metadata: { via: "google", reason: "link_refused" } } });
    return NextResponse.json({ error: "Google sign-in could not be completed. Sign in again." }, { status: 409 });
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });
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
