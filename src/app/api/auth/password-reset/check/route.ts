import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RESET_TOKEN_MAX_LENGTH } from "@/lib/passwordReset";
import { checkResetToken } from "@/lib/passwordResetCheck";
import { RESET_NO_DATABASE_MESSAGE } from "@/lib/passwordReset-types";
import { clientIp, rateLimit, readJsonLimited } from "@/lib/rateLimit";

const CheckSchema = z.object({ token: z.string().min(1).max(RESET_TOKEN_MAX_LENGTH) });

const IP_LIMIT = { limit: 10, windowMs: 15 * 60_000 };

const NO_STORE = { "Cache-Control": "no-store" };

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...NO_STORE, ...headers } });

/**
 * Read-only check of a reset link, so the page can show the invalid-link state before anyone types a password.
 * POST so the token stays out of access logs and caches. Every dead link gets the same { valid: false }: no reason,
 * no account details. Writes nothing. /confirm still verifies on submit with the same checkResetToken.
 */
export async function POST(request: NextRequest) {
  const limit = rateLimit({ key: `pwreset-check:${clientIp(request)}`, ...IP_LIMIT });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return reply(
      { error: "rate_limited", message: "Too many attempts. Please try again shortly." },
      429,
      { "Retry-After": String(retryAfter) },
    );
  }

  let raw: unknown;
  try {
    raw = await readJsonLimited(request);
  } catch {
    return reply({ valid: false });
  }
  const parsed = CheckSchema.safeParse(raw);
  if (!parsed.success) return reply({ valid: false });

  if (!process.env.DATABASE_URL?.trim()) {
    return reply({ error: "database_not_configured", message: RESET_NO_DATABASE_MESSAGE }, 503);
  }

  try {
    const user = await checkResetToken(parsed.data.token);
    return reply({ valid: user !== null });
  } catch {
    console.error("[password-reset] Could not check a reset link.");
    return reply({ error: "check_failed", message: "We could not check your link. Please try again." }, 500);
  }
}
