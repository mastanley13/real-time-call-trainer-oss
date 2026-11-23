import { NextRequest, NextResponse, after } from "next/server";
import { z } from "zod";
import { getJwtSecret } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { passwordResetEmail, sendMail } from "@/lib/ghlMail";
import { resetLink, resetLinkOrigin, signResetToken } from "@/lib/passwordReset";
import { RESET_NO_DATABASE_MESSAGE, RESET_REQUEST_MESSAGE } from "@/lib/passwordReset-types";
import { clientIp, rateLimit, readJsonLimited } from "@/lib/rateLimit";

const RequestSchema = z.object({ email: z.string().trim().email().max(254) });

/** Per IP: answered with 429 like the login route. Per email: silently skipped, so it reveals nothing and stops mail floods. */
const IP_LIMIT = { limit: 5, windowMs: 15 * 60_000 };
const EMAIL_LIMIT = { limit: 3, windowMs: 60 * 60_000 };

/** The one body every accepted request gets, whether or not the account exists. */
const accepted = () => NextResponse.json({ ok: true, message: RESET_REQUEST_MESSAGE });

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = rateLimit({ key: `pwreset-request:${ip}`, ...IP_LIMIT });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return NextResponse.json(
      { error: "rate_limited", message: "Too many reset requests. Please try again shortly." },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let email: string;
  try {
    email = RequestSchema.parse(await readJsonLimited(request)).email.toLowerCase();
  } catch {
    return NextResponse.json({ error: "invalid_email", message: "Enter a valid email address." }, { status: 400 });
  }

  if (!process.env.DATABASE_URL?.trim()) {
    return NextResponse.json({ error: "database_not_configured", message: RESET_NO_DATABASE_MESSAGE }, { status: 503 });
  }

  if (!rateLimit({ key: `pwreset-email:${email}`, ...EMAIL_LIMIT }).allowed) return accepted();

  try {
    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, email: true, passwordHash: true },
    });
    if (user) {
      // Token, email and audit row all run after the response, so an existing account answers as fast as a missing one.
      const userAgent = request.headers.get("user-agent")?.slice(0, 500) ?? undefined;
      after(() => sendResetEmail(user, ip, userAgent));
    }
  } catch {
    console.error("[password-reset] Account lookup failed.");
  }
  return accepted();
}

async function sendResetEmail(user: { id: string; email: string; passwordHash: string | null }, ip: string, userAgent?: string) {
  try {
    const origin = resetLinkOrigin();
    if (!origin) {
      console.warn("[password-reset] APP_URL is not set, so no reset email was sent.");
      return;
    }
    const token = signResetToken({ userId: user.id, passwordHash: user.passwordHash, secret: getJwtSecret(), now: Date.now() });
    const link = resetLink(origin, token);
    const result = await sendMail(passwordResetEmail(user.email, link));
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.password_reset_requested",
        ip,
        userAgent,
        metadata: { delivered: result.ok },
      },
    });
  } catch {
    console.error("[password-reset] Could not send the reset email.");
  }
}
