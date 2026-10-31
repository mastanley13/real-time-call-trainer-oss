import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { mfaStateFor } from "@/lib/mfaPolicy";

export async function GET(req: NextRequest) {
  // Open to members who must still enrol: the security page and MfaGate read the org's MFA rule from here.
  const auth = await requireAuth(req, { allowMfaEnrollment: true });
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
  return NextResponse.json({
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
    // Display only: requireAuth reads the same rule from the database on every protected request.
    mfa: {
      state: mfaState,
      requiredByOrg: org?.requireMfa ?? false,
      graceEndsAt: mfaState === "grace" ? org?.mfaGraceEndsAt?.toISOString() ?? null : null,
    },
  });
}
