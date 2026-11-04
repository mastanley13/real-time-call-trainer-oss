import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { signMfaChallengeToken, signSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { accessCode, hasValidAccessCookie, safeEqual } from "@/lib/access";
import { generateOrgCode } from "@/lib/orgCodes";
import { googleLandingPath } from "@/lib/signupIntent";
import { clientIp, ipLimitResponse } from "@/lib/rateLimit";
import { linkGoogleAtomically, checkIdTokenClaims, decodeIdToken, exchangeCode, flowCookieOptions, GOOGLE_FLOW_COOKIE, googleConfig, verifyFlowState, type GoogleProfile } from "@/lib/googleAuth";

/**
 * Google redirects here with ?code&state. We check state against the signed flow cookie, swap the code (with the
 * PKCE verifier) for an ID token, check its claims, then find, link or create the account.
 *
 * - Known Google account: sign in.
 * - Same verified email as an existing account: link Google to it and sign in.
 * - Otherwise: create a solo account the way email signup does (new org, owner, Free plan, no password). When
 *   TRAINER_ACCESS_CODE is set this needs the access cookie, like POST /api/auth/register.
 *
 * Existing accounts do not need the access cookie: password login does not either (/login and /api/auth/* are
 * public paths). Accounts with MFA get a challenge token, never a session, exactly as password login does.
 */

function back(req: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.nextUrl.origin));
  res.cookies.set(GOOGLE_FLOW_COOKIE, "", { ...flowCookieOptions(), maxAge: 0 });
  return res;
}
const fail = (req: NextRequest, reason: string) => back(req, `/login?error=${encodeURIComponent(reason)}`);

export async function GET(req: NextRequest) {
  const cfg = googleConfig();
  if (!cfg) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const limited = ipLimitResponse(req, "google");
  if (limited) return limited;

  const sp = req.nextUrl.searchParams;
  if (sp.get("error")) return fail(req, "google_cancelled");
  const code = sp.get("code");
  const state = sp.get("state");
  const flow = verifyFlowState(req.cookies.get(GOOGLE_FLOW_COOKIE)?.value);
  if (!code || code.length > 2000 || !state || !flow || !safeEqual(state, flow.state)) {
    return fail(req, "google_expired");
  }

  let profile: GoogleProfile;
  try {
    const tokens = await exchangeCode(cfg, code, flow.verifier);
    if (!tokens) return fail(req, "google_failed");
    const check = checkIdTokenClaims(decodeIdToken(tokens.idToken), {
      clientId: cfg.clientId,
      nonce: flow.nonce,
      nowSec: Math.floor(Date.now() / 1000),
    });
    if (!check.ok) {
      console.error(`[google] id token rejected: ${check.reason}`);
      return fail(req, check.reason === "email_unverified" ? "google_unverified" : "google_failed");
    }
    profile = check.profile;
  } catch (error) {
    console.error("[google] callback error:", error instanceof Error ? error.name : "unknown");
    return fail(req, "google_failed");
  }

  try {
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent") ?? undefined;

    let user = await prisma.user.findUnique({ where: { googleSub: profile.sub }, include: { organization: true } });
    let created = false;
    let linked = false;
    let pendingLink = false;

    if (!user) {
      const byEmail = await prisma.user.findUnique({ where: { email: profile.email }, include: { organization: true } });
      if (byEmail) {
        // Google verified this address, so it is the same person. Never overwrite a different Google id.
        if (byEmail.googleSub) return fail(req, "google_failed");
        // Nothing is written yet: the link waits for the lockout check and, with MFA, for the accepted code.
        user = byEmail;
        pendingLink = true;
      } else {
        const gate = accessCode();
        if (gate && !(await hasValidAccessCookie(req, gate))) {
          return back(req, "/access?next=%2Fregister&reason=google_invite");
        }
        user = await createSoloUser(profile, ip, userAgent);
        created = true;
      }
    }

    if (user.lockedUntil && user.lockedUntil > new Date()) return fail(req, "locked");

    if (user.mfaEnabled && user.mfaSecret) {
      await prisma.auditEvent.create({ data: { userId: user.id, action: "user.mfa_challenge_issued", ip, userAgent, metadata: { via: "google" } } });
      // The fragment never reaches a server or its logs; the login page picks it up. A pending link rides in the
      // signed challenge and is written by /api/auth/mfa/challenge once the code is accepted.
      return back(req, `/login#mfa=${encodeURIComponent(signMfaChallengeToken(user.id, pendingLink ? profile.sub : undefined))}`);
    }

    if (pendingLink) {
      if (!(await linkGoogleAtomically(prisma, user.id, profile.sub))) return fail(req, "google_failed");
      linked = true;
    }

    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.login_success",
        ip,
        userAgent,
        metadata: { via: "google", linked, created } satisfies Prisma.InputJsonValue,
      },
    });

    const token = signSessionToken({
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? undefined,
      lastName: user.lastName ?? undefined,
      role: user.role as "trainee" | "manager" | "owner",
    });
    const res = back(req, `/auth/complete?next=${encodeURIComponent(googleLandingPath(flow, created))}`);
    res.cookies.set("authToken", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 12,
    });
    return res;
  } catch (error) {
    console.error("[google] account error:", error instanceof Error ? error.name : "unknown");
    return fail(req, "google_failed");
  }
}

/** Same shape as POST /api/auth/register with a new team: a new org, the user as its owner, the default Free plan. */
async function createSoloUser(profile: GoogleProfile, ip: string, userAgent: string | undefined) {
  const orgCode = await generateOrgCode();
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: profile.firstName ? `${profile.firstName}'s team` : "My team", code: orgCode },
    });
    const user = await tx.user.create({
      data: {
        email: profile.email,
        googleSub: profile.sub,
        passwordHash: null,
        firstName: profile.firstName,
        lastName: profile.lastName,
        organizationId: org.id,
        role: "owner",
        lastLoginAt: new Date(),
      },
      include: { organization: true },
    });
    await tx.auditEvent.create({
      data: {
        userId: user.id,
        action: "user.registered",
        resource: user.id,
        ip,
        userAgent,
        metadata: { role: "owner", organizationCode: org.code, joinOrCreate: "create", via: "google" } satisfies Prisma.InputJsonValue,
      },
    });
    return user;
  });
}
