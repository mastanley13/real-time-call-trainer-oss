import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { orgView } from "@/lib/session";

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const user = await prisma.user.findUnique({
    where: { id: auth.id },
    include: { organization: true },
  });
  if (!user) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }
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
    organization: user.organization
      ? {
          id: user.organization.id,
          name: user.organization.name,
          code: orgView(user.organization).code,
          isPersonal: user.organization.isPersonal,
          planTier: user.organization.planTier,
          sessionRetentionDays: user.organization.sessionRetentionDays,
        }
      : null,
  });
}
