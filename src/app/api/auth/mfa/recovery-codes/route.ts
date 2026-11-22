import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mfaUnavailableResponse, verifyTotp } from "@/lib/mfa";
import { recoveryCodeCounts, replaceRecoveryCodes } from "@/lib/mfaRecovery";
import { clientIp, rateLimit, readJsonLimited } from "@/lib/rateLimit";

/** Exactly one proof: the current password, or a current authenticator code. */
const BodySchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    code: z.string().regex(/^[0-9]{6}$/).optional(),
  })
  .refine((b) => (b.password === undefined) !== (b.code === undefined));

const notEnabled = () =>
  NextResponse.json(
    { error: "mfa_not_enabled", message: "MFA is not enabled on this account. Turn it on first." },
    { status: 400 },
  );

/** How many unused recovery codes the signed-in user has left. Never returns the codes themselves. */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const unavailable = mfaUnavailableResponse();
  if (unavailable) return unavailable;

  const dbUser = await prisma.user.findUnique({ where: { id: auth.id }, select: { mfaEnabled: true } });
  if (!dbUser?.mfaEnabled) return notEnabled();
  return NextResponse.json(await recoveryCodeCounts(auth.id));
}

/**
 * Regenerate recovery codes. Requires a signed-in session and a fresh proof (password or current TOTP), so a
 * borrowed or stolen session alone cannot mint codes that would outlive it. Every earlier code stops working, and
 * the new plaintext codes are returned once in this response.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const unavailable = mfaUnavailableResponse();
  if (unavailable) return unavailable;

  const limit = rateLimit({ key: `mfa-recovery-codes:${auth.id}`, limit: 6, windowMs: 60_000 });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return NextResponse.json(
      { error: "rate_limited", message: `Too many attempts. Wait ${retryAfter} seconds and try again.`, retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    body = BodySchema.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Enter your password or a 6-digit authenticator code." },
      { status: 400 },
    );
  }

  const ip = clientIp(req);
  const dbUser = await prisma.user.findUnique({
    where: { id: auth.id },
    select: { id: true, mfaEnabled: true, mfaSecret: true, passwordHash: true },
  });
  if (!dbUser?.mfaEnabled || !dbUser.mfaSecret) return notEnabled();

  const method = body.password !== undefined ? "password" : "totp";
  const proven =
    body.password !== undefined
      ? (await verifyPassword(body.password, dbUser.passwordHash)).ok
      : verifyTotp(dbUser.mfaSecret, body.code ?? "");
  if (!proven) {
    await prisma.auditEvent.create({
      data: { userId: dbUser.id, action: "user.mfa_recovery_codes_regenerate_failed", ip, metadata: { method } },
    });
    return NextResponse.json(
      {
        error: "invalid_credentials",
        message:
          method === "password"
            ? "That password is not right. Try again, or use an authenticator code instead."
            : "That authenticator code is not right. Enter the current code from your app.",
      },
      { status: 401 },
    );
  }

  const recoveryCodes = await prisma.$transaction((tx) => replaceRecoveryCodes(tx, dbUser.id));
  // MFA was turned off between the check above and the locked read inside the transaction.
  if (!recoveryCodes) return notEnabled();

  await prisma.auditEvent.create({
    data: {
      userId: dbUser.id,
      action: "user.mfa_recovery_codes_regenerated",
      ip,
      userAgent: req.headers.get("user-agent") ?? undefined,
      metadata: { method, issued: recoveryCodes.length },
    },
  });
  return NextResponse.json({ recoveryCodes });
}
