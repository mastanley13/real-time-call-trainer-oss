import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { buildProvisioningUri, generateMfaSecret } from "@/lib/mfa";
import { rateLimit } from "@/lib/rateLimit";

/**
 * Start MFA enrollment. Generates a fresh TOTP secret and returns the
 * provisioning URI. The secret is stored against the user but `mfaEnabled`
 * stays false until the user proves possession via /api/auth/mfa/activate.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const user = auth;

  const limit = rateLimit({
    key: `mfa-enroll:${user.id}`,
    limit: 10,
    windowMs: 60_000,
  });
  if (!limit.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
  if (!dbUser) {
    return NextResponse.json({ error: "Unknown user" }, { status: 404 });
  }
  if (dbUser.mfaEnabled) {
    return NextResponse.json(
      { error: "MFA is already enabled. Disable it first to re-enroll." },
      { status: 400 },
    );
  }

  const secret = generateMfaSecret();
  const label = `${user.email}`;
  const uri = buildProvisioningUri({ label, secret });

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaSecret: secret, mfaEnabled: false, mfaEnrolledAt: null },
  });

  return NextResponse.json({
    secret,
    provisioningUri: uri,
    label,
    issuer: "Real-Time Call Trainer",
  });
}
