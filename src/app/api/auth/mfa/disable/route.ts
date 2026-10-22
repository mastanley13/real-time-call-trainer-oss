import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { verifyTotp } from "@/lib/mfa";
import { clientIp, rateLimit } from "@/lib/rateLimit";

const BodySchema = z.object({ code: z.string().regex(/^[0-9]{6}$/) });

/**
 * Disable MFA. Requires the caller to provide a valid TOTP to prove
 * possession of the device.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const user = auth;

  const limit = rateLimit({
    key: `mfa-disable:${user.id}`,
    limit: 6,
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
  if (!dbUser?.mfaEnabled || !dbUser.mfaSecret) {
    return NextResponse.json(
      { error: "MFA is not enabled on this account." },
      { status: 400 },
    );
  }
  if (!verifyTotp(dbUser.mfaSecret, body.code)) {
    await prisma.auditEvent.create({
      data: {
        userId: dbUser.id,
        action: "user.mfa_disable_failed",
        ip: clientIp(req),
      },
    });
    return NextResponse.json({ error: "Invalid code" }, { status: 401 });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null },
  });
  await prisma.auditEvent.create({
    data: {
      userId: user.id,
      action: "user.mfa_disabled",
      ip: clientIp(req),
    },
  });
  return NextResponse.json({ mfaEnabled: false });
}
