import { NextRequest, NextResponse } from "next/server";
import { SessionUser, verifySessionToken } from "./auth";
import { prisma } from "./db";
import { mfaStateFor } from "./mfaPolicy";
import { DEMO_USER, getCapabilities } from "./serverConfig";

function extractToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return req.cookies.get("authToken")?.value || null;
}

/**
 * Returns the authenticated user, or an error response: 401 for a missing,
 * invalid or orphaned session, 403 `mfa_enrollment_required` when the user's
 * organization requires MFA and they have not enrolled (unless the route
 * passes allowMfaEnrollment), 503 if the policy can't be read. The MFA rule is
 * read from the database on every call, so turning enforcement on or off, a
 * grace period ending or a support reset applies to sessions already issued.
 * With DEMO_MODE=true the login requirement is skipped and a fixed demo user
 * is returned (local UI testing only; never enable on a public deployment).
 */
export async function requireAuth(req: NextRequest, opts: { allowMfaEnrollment?: boolean } = {}): Promise<SessionUser | NextResponse> {
  if (getCapabilities().demoMode) return { ...DEMO_USER };
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const user = verifySessionToken(token);
  if (!user) {
    return NextResponse.json({ error: "Invalid or expired session" }, { status: 401 });
  }
  // Without a database there are no stored accounts, and so no org policy.
  if (!getCapabilities().database || opts.allowMfaEnrollment) return user;

  try {
    const row = await prisma.user.findUnique({
      where: { id: user.id },
      select: { mfaEnabled: true, organization: { select: { requireMfa: true, mfaGraceEndsAt: true } } },
    });
    if (!row) return NextResponse.json({ error: "Invalid or expired session" }, { status: 401 });
    const state = mfaStateFor({
      requireMfa: row.organization?.requireMfa ?? false,
      mfaGraceEndsAt: row.organization?.mfaGraceEndsAt ?? null,
      mfaEnabled: row.mfaEnabled,
    });
    if (state === "enroll_required") {
      return NextResponse.json(
        { error: "mfa_enrollment_required", message: "Your organization requires multi-factor authentication. Set it up in Settings, Security to continue." },
        { status: 403 },
      );
    }
  } catch (error) {
    console.error("[requireAuth] policy lookup failed:", error);
    return NextResponse.json({ error: "auth_unavailable", message: "Could not check your account. Try again in a minute." }, { status: 503 });
  }
  return user;
}

export function isDemoUser(user: SessionUser): boolean {
  return user.id === DEMO_USER.id;
}
