import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  signSessionToken,
  verifyMfaChallenge,
  type SessionRole,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { CHALLENGE_EXPIRED, CODE_USED_ERROR, CODE_USED_MESSAGE } from "@/lib/authCopy";
import { claimTotpStep, verifyTotp } from "@/lib/mfa";
import { linkGoogleAtomically } from "@/lib/googleAuth";
import { clientIp, rateLimit } from "@/lib/rateLimit";

const BodySchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().regex(/^[0-9]{6}$/),
});

class MfaReplayError extends Error {
  constructor() {
    super("mfa_replay");
    this.name = "MfaReplayError";
  }
}

const expiredChallenge = () =>
  NextResponse.json({ error: CHALLENGE_EXPIRED }, { status: 401 });

const codeUsed = () =>
  NextResponse.json({ error: CODE_USED_ERROR, message: CODE_USED_MESSAGE }, { status: 401 });

/**
 * Exchange an MFA challenge token (issued by /api/auth/login when MFA is
 * enabled on an account) plus a valid TOTP code for a full session.
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
    return expiredChallenge();
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

  const consumed = await prisma.consumedMfaChallenge.findUnique({ where: { id: challenge.jti } });
  if (consumed) {
    return expiredChallenge();
  }

  const step = verifyTotp(user.mfaSecret, body.code);
  if (step === null) {
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_challenge_failed",
        ip,
      },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.consumedMfaChallenge.create({
        data: { id: challenge.jti, expiresAt: new Date(challenge.exp * 1000) },
      });
      if (!(await claimTotpStep(tx, user.id, step, { mfaEnabled: true }))) {
        throw new MfaReplayError();
      }
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      await prisma.auditEvent.create({
        data: { userId: user.id, action: "user.mfa_challenge_failed", ip },
      });
      return expiredChallenge();
    }
    if (e instanceof Error && e.name === "MfaReplayError") {
      await prisma.auditEvent.create({
        data: { userId: user.id, action: "user.mfa_challenge_failed", ip },
      });
      return codeUsed();
    }
    throw e;
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
  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.mfa_challenge_success",
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      ...(challenge.linkGoogleSub ? { metadata: { via: "google", linked } } : {}),
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
