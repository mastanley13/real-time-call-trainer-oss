import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  signSessionToken,
  verifyMfaChallengeToken,
  type SessionRole,
} from "@/lib/auth";
import { prisma } from "@/lib/db";
import { verifyTotp } from "@/lib/mfa";
import { clientIp, rateLimit } from "@/lib/rateLimit";

const BodySchema = z.object({
  challengeToken: z.string().min(10),
  code: z.string().regex(/^[0-9]{6}$/),
});

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

  const userId = verifyMfaChallengeToken(body.challengeToken);
  if (!userId) {
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

  if (!verifyTotp(user.mfaSecret, body.code)) {
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_challenge_failed",
        ip,
      },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
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
