import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { signMfaChallengeToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { safeEqual } from "@/lib/access";
import { clientIp, ipLimitResponse } from "@/lib/rateLimit";
import { checkIdTokenClaims, decodeIdToken, exchangeCode, flowCookieOptions, GOOGLE_FLOW_COOKIE, googleConfig, verifyFlowState, type FlowState, type GoogleProfile } from "@/lib/googleAuth";
import { generateOrgCode, personalOrgName } from "@/lib/orgCodes";
import { needsOnboarding, startSession, toSessionUser } from "@/lib/session";

/**
 * Google redirects here with ?code&state. We check state against the signed
 * flow cookie, swap the code (with the PKCE verifier) for an ID token, check
 * its claims, then find, link or create the account.
 *
 * - Known Google account: sign in.
 * - Same verified email as a password account: link Google to it.
 * - Otherwise: create an account with no password. It gets a personal org
 *   (solo) unless the sign-up asked to start a team; onboarding then
 *   creates the org. An invite (join code + manager) joins it now.
 * Accounts with MFA still need their authenticator code.
 */

function back(req: NextRequest, path: string): NextResponse {
  const res = NextResponse.redirect(new URL(path, req.nextUrl.origin));
  res.cookies.set(GOOGLE_FLOW_COOKIE, "", { ...flowCookieOptions, maxAge: 0 });
  return res;
}
const fail = (req: NextRequest, reason: string) => back(req, `/login?error=${encodeURIComponent(reason)}`);

export async function GET(req: NextRequest) {
  const limited = ipLimitResponse(req, "google");
  if (limited) return limited;

  const cfg = googleConfig(req.nextUrl.origin);
  if (!cfg) return fail(req, "google_not_configured");

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
    const { user, created, linked, solo } = await findOrCreateUser(profile, flow);

    if (user.lockedUntil && user.lockedUntil > new Date()) return fail(req, "locked");

    if (user.mfaEnabled && user.mfaSecret) {
      await prisma.auditEvent.create({ data: { userId: user.id, action: "user.mfa_challenge_issued", ip, userAgent, metadata: { via: "google" } } });
      // The fragment never reaches a server or its logs; the login page picks it up.
      return back(req, `/login#mfa=${encodeURIComponent(signMfaChallengeToken(user.id))}`);
    }

    await prisma.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() } });
    await prisma.auditEvent.create({
      data: {
        userId: user.id,
        action: created ? "user.registered" : "user.login_success",
        ip,
        userAgent,
        metadata: { via: "google", linked, joinedOrg: Boolean(created && user.organizationId && !solo), ...(solo ? { joinOrCreate: "solo" } : {}) } satisfies Prisma.InputJsonValue,
      },
    });

    const next = needsOnboarding(user) ? "/onboarding" : flow.next;
    const res = back(req, `/auth/complete?next=${encodeURIComponent(next)}`);
    startSession(res, toSessionUser(user));
    return res;
  } catch (error) {
    console.error("[google] account error:", error instanceof Error ? error.name : "unknown");
    return fail(req, "google_failed");
  }
}

async function findOrCreateUser(profile: GoogleProfile, flow: FlowState) {
  const bySub = await prisma.user.findUnique({ where: { googleSub: profile.sub } });
  if (bySub) return { user: bySub, created: false, linked: false, solo: false };

  const byEmail = await prisma.user.findUnique({ where: { email: profile.email } });
  if (byEmail) {
    // Google verified this address, so it's the same person. Link only if the account has no Google id yet.
    if (byEmail.googleSub) throw new Error("GOOGLE_ACCOUNT_MISMATCH");
    const user = await prisma.user.update({ where: { id: byEmail.id }, data: { googleSub: profile.sub } });
    return { user, created: false, linked: true, solo: false };
  }

  let organizationId: string | null = null;
  let managerId: string | null = null;
  if (flow.joinCode) {
    const org = await prisma.organization.findUnique({ where: { code: flow.joinCode }, select: { id: true, isPersonal: true } });
    if (org && !org.isPersonal) {
      organizationId = org.id;
      if (flow.managerId) {
        const lead = await prisma.user.findFirst({
          where: { id: flow.managerId, organizationId: org.id, role: { in: ["manager", "owner"] } },
          select: { id: true },
        });
        managerId = lead?.id ?? null;
      }
    }
  }

  // No team chosen: solo is the default. Only an explicit "start a team" leaves the org for onboarding.
  const solo = !organizationId && flow.intent !== "team";
  const user = await prisma.$transaction(async (tx) => {
    if (solo) {
      const org = await tx.organization.create({
        data: {
          name: personalOrgName({ firstName: profile.firstName, lastName: profile.lastName, email: profile.email }),
          code: await generateOrgCode(),
          planTier: "free",
          isPersonal: true,
        },
      });
      organizationId = org.id;
    }
    return tx.user.create({
      data: {
        email: profile.email,
        googleSub: profile.sub,
        passwordHash: null,
        firstName: profile.firstName,
        lastName: profile.lastName,
        role: "trainee",
        organizationId,
        managerId,
        ...(solo ? { onboardedAt: new Date() } : {}),
      },
    });
  });
  return { user, created: true, linked: false, solo };
}
