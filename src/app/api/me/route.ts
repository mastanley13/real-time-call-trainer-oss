import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { signSessionToken, type SessionRole } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mfaStateFor } from "@/lib/mfaPolicy";

export async function GET(req: NextRequest) {
  // Open to enrollment-only sessions: the security page reads the org's MFA rule from here.
  const auth = requireAuth(req, { allowMfaEnrollment: true });
  if (auth instanceof NextResponse) return auth;

  const user = await prisma.user.findUnique({
    where: { id: auth.id },
    include: { organization: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
  const org = user.organization;
  const mfaState = mfaStateFor({
    requireMfa: org?.requireMfa ?? false,
    mfaGraceEndsAt: org?.mfaGraceEndsAt ?? null,
    mfaEnabled: user.mfaEnabled,
  });
  const res = NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      role: user.role,
      isPlatformAdmin: user.isPlatformAdmin,
      mfaEnabled: user.mfaEnabled,
      mfaEnrolledAt: user.mfaEnrolledAt,
    },
    organization: org
      ? {
          id: org.id,
          name: org.name,
          code: org.code,
          planTier: org.planTier,
          sessionRetentionDays: org.sessionRetentionDays,
        }
      : null,
    mfa: {
      state: mfaState,
      requiredByOrg: org?.requireMfa ?? false,
      graceEndsAt: mfaState === "grace" ? org?.mfaGraceEndsAt?.toISOString() ?? null : null,
    },
  });

  // Enforcement was switched on (or this user was reset) after this session began: drop to enrollment-only.
  if (mfaState === "enroll_required" && !auth.mfaEnrollment) {
    const limited = {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      role: user.role as SessionRole,
      mfaEnrollment: true,
    };
    res.cookies.set("authToken", signSessionToken(limited), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
  }
  return res;
}
