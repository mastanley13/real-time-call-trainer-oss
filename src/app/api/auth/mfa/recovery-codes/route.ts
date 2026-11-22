import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { verifyPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { mfaUnavailableResponse, verifyTotp } from "@/lib/mfa";
import { recoveryCodeCounts, replaceRecoveryCodes } from "@/lib/mfaRecovery";
import { clearAuthFailures, holdIfUnlocked, isLocked, lockedResponse, recordAuthFailure } from "@/lib/loginLockout";
import { clientIp, ipLimitResponse, rateLimit, readJsonLimited } from "@/lib/rateLimit";

/** Exactly one proof: the current password, or a current authenticator code. */
const BodySchema = z
  .object({
    password: z.string().min(1).max(200).optional(),
    code: z.string().regex(/^[0-9]{6}$/).optional(),
  })
  .refine((b) => (b.password === undefined) !== (b.code === undefined));

/** Thrown inside the regeneration transaction to roll it back when the account changed after the proof. */
class Changed extends Error {}

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

  const ipLimited = ipLimitResponse(req, "mfaRecovery");
  if (ipLimited) return ipLimited;
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
    select: { id: true, mfaEnabled: true, mfaSecret: true, passwordHash: true, lockedUntil: true },
  });
  if (!dbUser?.mfaEnabled || !dbUser.mfaSecret) return notEnabled();
  // A locked account proves nothing here until the lock runs out, the same as at sign-in.
  if (isLocked(dbUser)) return lockedResponse();

  const method = body.password !== undefined ? "password" : "totp";
  const proven =
    body.password !== undefined
      ? (await verifyPassword(body.password, dbUser.passwordHash)).ok
      : verifyTotp(dbUser.mfaSecret, body.code ?? "");
  if (!proven) {
    // Wrong proofs count toward the same failedLoginCount as sign-in (loginLockout.ts), so a stolen session cannot
    // be used to guess the password or TOTP beyond the account's lockout threshold.
    const { locked } = await recordAuthFailure(dbUser.id);
    await prisma.auditEvent.create({
      data: {
        userId: dbUser.id,
        action: "user.mfa_recovery_codes_regenerate_failed",
        ip,
        metadata: { method, ...(locked ? { locked: true } : {}) },
      },
    });
    if (locked) {
      await prisma.auditEvent.create({
        data: { userId: dbUser.id, action: "user.login_locked", ip, metadata: { via: "mfa_recovery_codes", method } },
      });
    }
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

  // One transaction. First the lock-aware gate: it takes the user row lock and refuses if failures from other requests
  // armed a lock while the proof was being checked. Only a TOTP proof resets the shared failure counter. A password
  // proof leaves it alone, because the password is the factor an MFA guesser already has: if it reset the count,
  // someone with a session and the password could alternate wrong MFA codes with regenerations and never lock.
  // Then, under that lock, the secret (and for a password proof, the password hash) must still be the ones just
  // checked. Either refusal rolls back, so nothing is written.
  const provenSecret = dbUser.mfaSecret;
  const result = await prisma
    .$transaction(async (tx): Promise<string[] | "locked"> => {
      const unlocked = method === "totp" ? await clearAuthFailures(dbUser.id, {}, tx) : await holdIfUnlocked(dbUser.id, tx);
      if (!unlocked) return "locked";
      const codes = await replaceRecoveryCodes(tx, dbUser.id, {
        mfaSecret: provenSecret,
        ...(method === "password" ? { passwordHash: dbUser.passwordHash } : {}),
      });
      if (!codes) throw new Changed(); // undo the counter reset too
      return codes;
    })
    .catch((e: unknown) => {
      if (e instanceof Changed) return "changed" as const;
      throw e;
    });
  if (result === "locked") return lockedResponse();
  if (result === "changed") {
    // MFA was turned off, re-enrolled or the password changed after the proof was checked. Nothing was written.
    return NextResponse.json(
      { error: "conflict", message: "Your security settings changed while this was running. Reload the page and try again." },
      { status: 409 },
    );
  }
  const recoveryCodes = result;

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
