import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  hashPassword,
  signMfaChallengeToken,
  signSessionToken,
  verifyPassword,
} from "@/lib/auth";
import { rateLimit, clientIp } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { needsOnboarding } from "@/lib/session";

const LoginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(200),
  /// Legacy field. We no longer require it at login — the user's
  /// organization is inferred from their account. It is accepted here
  /// purely for backwards compatibility with clients that still send it.
  orgCode: z.string().optional(),
});

const GENERIC_AUTH_ERROR = "Invalid email or password.";
const MAX_FAILED = 8;
const LOCKOUT_MINUTES = 15;

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = rateLimit({
    key: `login:${ip}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Too many login attempts. Please try again shortly." },
      {
        status: 429,
        headers: { "Retry-After": Math.ceil(limit.retryAfterMs / 1000).toString() },
      },
    );
  }

  let body;
  try {
    body = LoginSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: "Email and password are required" },
      { status: 400 },
    );
  }

  const emailLower = body.email.toLowerCase();

  const user = await prisma.user.findUnique({
    where: { email: emailLower },
    include: { organization: true },
  });

  if (!user) {
    return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return NextResponse.json(
      { error: "Account temporarily locked. Try again later." },
      { status: 423 },
    );
  }

  const { ok, needsRehash } = await verifyPassword(body.password, user.passwordHash);

  if (!ok) {
    const failed = user.failedLoginCount + 1;
    const shouldLock = failed >= MAX_FAILED;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: shouldLock ? 0 : failed,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
          : null,
      },
    });
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: shouldLock ? "user.login_locked" : "user.login_failed",
        ip,
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
    });
    return NextResponse.json({ error: GENERIC_AUTH_ERROR }, { status: 401 });
  }

  if (needsRehash) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(body.password) },
    });
  }

  // Password + org-code have passed. If this account has MFA enabled, DO
  // NOT issue a session yet — return a short-lived challenge token instead
  // and require a valid TOTP to exchange it for a session.
  if (user.mfaEnabled && user.mfaSecret) {
    const challengeToken = signMfaChallengeToken(user.id);
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.mfa_challenge_issued",
        ip,
        userAgent: request.headers.get("user-agent") ?? undefined,
      },
    });
    return NextResponse.json({ mfaRequired: true, challengeToken });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
    },
  });

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.login_success",
      ip,
      userAgent: request.headers.get("user-agent") ?? undefined,
    },
  });

  const sessionUser = {
    id: user.id,
    email: user.email,
    firstName: user.firstName ?? undefined,
    lastName: user.lastName ?? undefined,
    role: user.role as "trainee" | "manager" | "owner",
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
    needsOnboarding: needsOnboarding(user),
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
