import "server-only";
import type { NextResponse } from "next/server";
import { signSessionToken, type SessionRole, type SessionUser } from "./auth";

/** Same cookie the password, MFA and register routes set. */
export const SESSION_COOKIE = "authToken";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 12;

export function toSessionUser(u: { id: string; email: string; firstName: string | null; lastName: string | null; role: string }): SessionUser {
  return {
    id: u.id,
    email: u.email,
    firstName: u.firstName ?? undefined,
    lastName: u.lastName ?? undefined,
    role: u.role as SessionRole,
  };
}

/** Signs a session for `user`, sets the cookie on `res` and returns the token. */
export function startSession(res: NextResponse, user: SessionUser): string {
  const token = signSessionToken(user);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SEC,
  });
  return token;
}

/** The organization as the client sees it. A personal workspace has no code to show or share. */
export function orgView<T extends { id: string; name: string; code: string; isPersonal: boolean }>(org: T) {
  return { ...org, code: org.isPersonal ? null : org.code };
}

/** New users finish onboarding before practising; anyone without an org has to pick one first. */
export function needsOnboarding(u: { onboardedAt: Date | null; organizationId: string | null; isPlatformAdmin: boolean }): boolean {
  if (u.isPlatformAdmin) return false;
  return !u.organizationId || !u.onboardedAt;
}
