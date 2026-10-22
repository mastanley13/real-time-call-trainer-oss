import { NextRequest, NextResponse } from "next/server";
import { SessionUser, verifySessionToken } from "./auth";
import { DEMO_USER, getCapabilities } from "./serverConfig";

function extractToken(req: NextRequest): string | null {
  const header = req.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  return req.cookies.get("authToken")?.value || null;
}

/**
 * Returns the authenticated user, or a 401 response. With DEMO_MODE=true the
 * login requirement is skipped and a fixed demo user is returned (local UI
 * testing only; never enable on a public deployment).
 */
export function requireAuth(req: NextRequest): SessionUser | NextResponse {
  if (getCapabilities().demoMode) return { ...DEMO_USER };
  const token = extractToken(req);
  if (!token) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }
  const user = verifySessionToken(token);
  if (!user) {
    return NextResponse.json({ error: "Invalid or expired session" }, { status: 401 });
  }
  return user;
}

export function isDemoUser(user: SessionUser): boolean {
  return user.id === DEMO_USER.id;
}
