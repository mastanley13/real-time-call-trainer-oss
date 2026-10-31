import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { canEnforceMfa, graceEndFor, MAX_GRACE_DAYS, mfaStateFor } from "@/lib/mfaPolicy";
import { clientIp, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { canManageTeam, memberName } from "@/lib/team";
import { forbidden, limitFor, loadActor, noOrganization, serverError, teamIsLocal } from "../_lib/server";

/**
 * Organization MFA policy for managers and owners, scoped to the actor's own
 * organization as stored in the database.
 *
 * GET  the policy, whether the plan allows it, and every member's MFA status
 * PUT  { requireMfa, graceDays? } turns enforcement on or off; Team plan only to turn it on
 */

const Body = z.object({
  requireMfa: z.boolean(),
  /** Optional days before enforcement starts. Omit for none. */
  graceDays: z.number().int().min(1).max(MAX_GRACE_DAYS).optional(),
});

const localOnly = () =>
  NextResponse.json({ error: "local_only", message: "Demo mode has no stored accounts, so there is no MFA to require. Connect a database to use this." }, { status: 400 });

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = limitFor(`team:mfa:${auth.id}`, 60, 60_000);
  if (limited) return limited;

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();

    const [org, users] = await Promise.all([
      prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { planTier: true, requireMfa: true, mfaGraceEndsAt: true } }),
      prisma.user.findMany({
        where: { organizationId: actor.organizationId },
        select: { id: true, firstName: true, lastName: true, email: true, role: true, mfaEnabled: true, mfaEnrolledAt: true },
        orderBy: { createdAt: "asc" },
        take: 1000,
      }),
    ]);
    if (!org) return noOrganization();
    const now = new Date();
    return NextResponse.json({
      requireMfa: org.requireMfa,
      graceEndsAt: org.requireMfa && org.mfaGraceEndsAt && org.mfaGraceEndsAt > now ? org.mfaGraceEndsAt.toISOString() : null,
      canEnforce: canEnforceMfa(org.planTier),
      members: users.map((u) => ({
        id: u.id,
        name: memberName(u),
        role: u.role,
        mfaEnabled: u.mfaEnabled,
        mfaEnrolledAt: u.mfaEnrolledAt?.toISOString() ?? null,
        state: mfaStateFor({ requireMfa: org.requireMfa, mfaGraceEndsAt: org.mfaGraceEndsAt, mfaEnabled: u.mfaEnabled }, now),
      })),
    });
  } catch (error) {
    console.error("[/api/team/mfa] GET error:", error);
    return serverError("load MFA status");
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const ipLimited = ipLimitResponse(req, "teamMfaPolicy");
  if (ipLimited) return ipLimited;
  const limited = limitFor(`team:mfa-policy:${auth.id}`, 10, 60_000);
  if (limited) return limited;

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await readJsonLimited(req));
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_body", message: `Send requireMfa as true or false, and an optional graceDays from 1 to ${MAX_GRACE_DAYS}.` }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Send a small JSON body." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();
    const orgId = actor.organizationId;

    const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { planTier: true, requireMfa: true } });
    if (!org) return noOrganization();
    // Turning it off is always allowed, so an org that leaves the Team plan can't get stuck.
    if (body.requireMfa && !canEnforceMfa(org.planTier)) {
      return NextResponse.json({ error: "plan_required", message: "Requiring MFA is part of the Team plan. Upgrade to turn it on." }, { status: 403 });
    }

    const now = new Date();
    const graceEndsAt = body.requireMfa ? graceEndFor(body.graceDays, now) : null;
    if (org.requireMfa === body.requireMfa && !body.requireMfa) {
      return NextResponse.json({ requireMfa: false, graceEndsAt: null, changed: false });
    }

    await prisma.$transaction([
      prisma.organization.update({ where: { id: orgId }, data: { requireMfa: body.requireMfa, mfaGraceEndsAt: graceEndsAt } }),
      prisma.auditEvent.create({
        data: {
          userId: actor.id,
          action: body.requireMfa ? "org.mfa_enforcement_enabled" : "org.mfa_enforcement_disabled",
          resource: orgId,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent") ?? undefined,
          metadata: {
            organizationId: orgId,
            graceDays: body.requireMfa ? body.graceDays ?? null : null,
            graceEndsAt: graceEndsAt?.toISOString() ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      }),
    ]);
    return NextResponse.json({ requireMfa: body.requireMfa, graceEndsAt: graceEndsAt?.toISOString() ?? null, changed: true });
  } catch (error) {
    console.error("[/api/team/mfa] PUT error:", error);
    return serverError("update the MFA rule");
  }
}
