import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { signSessionToken, type SessionRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { verifyTotp } from "@/lib/mfa";
import { rateLimit, clientIp } from "@/lib/rateLimit";

const BodySchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

/**
 * Confirm MFA enrollment by verifying the user's first TOTP code. On success
 * `mfaEnabled` flips to true and subsequent logins will require TOTP.
 */
export async function POST(req: NextRequest) {
  // Open to enrollment-only sessions; success swaps them for a full one below.
  const auth = requireAuth(req, { allowMfaEnrollment: true });
  if (auth instanceof NextResponse) return auth;
  const user = auth;

  const limit = rateLimit({
    key: `mfa-activate:${user.id}`,
    limit: 8,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  let body;
  try {
    body = BodySchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid code" }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser || !dbUser.mfaSecret) {
    return NextResponse.json(
      { error: "No enrollment in progress. Start MFA enrollment first." },
      { status: 400 },
    );
  }

  if (!verifyTotp(dbUser.mfaSecret, body.code)) {
    await prisma.auditEvent.create({
      data: {
        userId: dbUser.id,
        action: "user.mfa_activation_failed",
        ip: clientIp(req),
      },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
  });
  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.mfa_enabled",
      ip: clientIp(req),
    },
  });

  // Enrollment done: replace a limited session with a full one.
  const sessionUser = {
    id: dbUser.id,
    email: dbUser.email,
    firstName: dbUser.firstName ?? undefined,
    lastName: dbUser.lastName ?? undefined,
    role: dbUser.role as SessionRole,
  };
  const token = signSessionToken(sessionUser);
  const res = NextResponse.json({
    mfaEnabled: true,
    user: { ...sessionUser, isPlatformAdmin: dbUser.isPlatformAdmin },
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
