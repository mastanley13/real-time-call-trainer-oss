import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { hashPassword } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { clearAuthFailures } from "@/lib/loginLockout";
import { RESET_TOKEN_MAX_LENGTH } from "@/lib/passwordReset";
import { checkResetToken } from "@/lib/passwordResetCheck";
import { RESET_INVALID_MESSAGE, RESET_NO_DATABASE_MESSAGE } from "@/lib/passwordReset-types";
import { passwordSchema } from "@/lib/passwordRules";
import { clientIp, rateLimit, readJsonLimited } from "@/lib/rateLimit";

const ConfirmSchema = z.object({
  token: z.string().min(1).max(RESET_TOKEN_MAX_LENGTH),
  password: passwordSchema,
});

const IP_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

const invalid = () => NextResponse.json({ error: "invalid_token", message: RESET_INVALID_MESSAGE }, { status: 400 });

/** Sets a new password from a reset link. Does not sign the user in: they sign in next, so MFA still applies. */
export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = rateLimit({ key: `pwreset-confirm:${ip}`, ...IP_LIMIT });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return NextResponse.json(
      { error: "rate_limited", message: "Too many attempts. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let raw: unknown;
  try {
    raw = await readJsonLimited(request);
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Send a token and a new password." }, { status: 400 });
  }
  const parsed = ConfirmSchema.safeParse(raw);
  if (!parsed.success) {
    const passwordIssue = parsed.error.issues.find((i) => i.path[0] === "password");
    if (passwordIssue) {
      return NextResponse.json({ error: "invalid_password", message: passwordIssue.message }, { status: 400 });
    }
    return invalid();
  }
  const { token, password } = parsed.data;

  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json({ error: "database_not_configured", message: RESET_NO_DATABASE_MESSAGE }, { status: 503 });
  }

  try {
    // Shared with /check, so the page-load check is never weaker than this one.
    const user = await checkResetToken(token);
    if (!user) return invalid();

    const passwordHash = await hashPassword(password);
    // Conditional on the hash the token was issued for, so two requests racing with one link cannot both succeed.
    // The failure counters are not part of this write; see below.
    const updated = await prisma.user.updateMany({
      where: { id: user.id, passwordHash: user.passwordHash },
      data: { passwordHash },
    });
    if (updated.count !== 1) return invalid();

    // Lift the lockout only where a new password is all the account needs, and never a lock armed meanwhile:
    // - MFA on: leave the counters alone. A reset proves control of the email, not the second factor, so it must
    //   not lift a lock built up by wrong MFA codes, or reset the count so the guessing can go on.
    // - MFA off: the lock-aware clear from loginLockout.ts, checked in one statement. It matches only while the
    //   account has MFA off and is not locked at this moment, so a lock armed by concurrent failures is kept. The
    //   password change above stands either way.
    // Best effort, like the audit row: if this write fails the password has still changed, and leaving the counters
    // as they were is the safe side.
    let countersCleared = false;
    try {
      countersCleared = await clearAuthFailures(user.id, {}, prisma, { mfaEnabled: false });
    } catch {
      console.error("[password-reset] Password changed, but the lockout counters could not be updated.");
    }

    // The password has changed and the link is spent, so success stands even if the audit row cannot be written.
    try {
      await prisma.auditEvent.create({
        data: {
          userId: user.id,
          action: "user.password_reset_completed",
          ip,
          metadata: { countersCleared },
          userAgent: request.headers.get("user-agent")?.slice(0, 500) ?? undefined,
        },
      });
    } catch {
      console.error("[password-reset] Password changed, but the audit event could not be written.");
    }
    return NextResponse.json({ ok: true });
  } catch {
    console.error("[password-reset] Could not complete the reset.");
    return NextResponse.json(
      { error: "reset_failed", message: "We could not reset your password. Please try again." },
      { status: 500 },
    );
  }
}
