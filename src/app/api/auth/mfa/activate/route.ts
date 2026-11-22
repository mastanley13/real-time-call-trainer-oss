import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { mfaUnavailableResponse, verifyTotp } from "@/lib/mfa";
import { replaceRecoveryCodes } from "@/lib/mfaRecovery";
import { rateLimit, clientIp } from "@/lib/rateLimit";

const BodySchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

/**
 * Confirm MFA enrollment by verifying the user's first TOTP code. On success
 * `mfaEnabled` flips to true, subsequent logins will require TOTP, and the
 * response carries the account's 10 recovery codes. This is the only time
 * those codes are sent; the server keeps hashes only.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const user = auth;
  const unavailable = mfaUnavailableResponse();
  if (unavailable) return unavailable;

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
  if (dbUser.mfaEnabled) {
    // Activation would otherwise hand out a fresh set of recovery codes, bypassing the regenerate route.
    return NextResponse.json(
      { error: "MFA is already enabled. Use Regenerate codes in settings for new recovery codes." },
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

  const enrolledSecret = dbUser.mfaSecret;
  const recoveryCodes = await prisma.$transaction(async (tx) => {
    // Conditional on MFA still being off and on the secret that was just verified, so a second activation or a
    // re-enrollment in another tab cannot slip in between the check above and this write.
    const flipped = await tx.user.updateMany({
      where: { id: user.id, mfaEnabled: false, mfaSecret: enrolledSecret },
      data: { mfaEnabled: true, mfaEnrolledAt: new Date() },
    });
    if (flipped.count !== 1) return null;
    return replaceRecoveryCodes(tx, user.id, { mfaSecret: enrolledSecret });
  });
  if (!recoveryCodes) {
    return NextResponse.json(
      { error: "conflict", message: "MFA changed in another tab or window. Reload this page and try again." },
      { status: 409 },
    );
  }

  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.mfa_enabled",
      ip: clientIp(req),
      metadata: { recoveryCodesIssued: recoveryCodes.length },
    },
  });

  return NextResponse.json({ mfaEnabled: true, recoveryCodes });
}
