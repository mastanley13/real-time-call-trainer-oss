import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { clientIp, readJsonLimited } from "@/lib/rateLimit";
import { canManageTeam } from "@/lib/team";
import { forbidden, limitFor, loadActor, noOrganization, serverError, teamIsLocal } from "../../_lib/server";

/**
 * Support reset: clears one member's MFA so they can enrol a new device.
 * Org-scoped. Managers reset trainees; owners and platform admins reset anyone
 * else in the org. If the org requires MFA, the member's next request drops to
 * enrollment-only until they activate again.
 */

const Body = z.object({ userId: z.string().trim().min(1).max(64) });

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) {
    return NextResponse.json({ error: "local_only", message: "Demo mode has no stored accounts to reset." }, { status: 400 });
  }
  const limited = limitFor(`team:mfa-reset:${auth.id}`, 10, 60_000);
  if (limited) return limited;

  let body: z.infer<typeof Body>;
  try {
    const parsed = Body.safeParse(await readJsonLimited(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid_body", message: "Send the userId to reset." }, { status: 400 });
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Send a small JSON body." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();
    if (body.userId === actor.id) {
      return NextResponse.json({ error: "cannot_reset_self", message: "Reset your own MFA from Settings, Security." }, { status: 400 });
    }

    const target = await prisma.user.findFirst({
      where: { id: body.userId, organizationId: actor.organizationId },
      select: { id: true, role: true, mfaEnabled: true, mfaSecret: true },
    });
    if (!target) return NextResponse.json({ error: "not_found", message: "That person isn't in your organization." }, { status: 404 });
    if (target.role !== "trainee" && actor.role === "manager" && !actor.isPlatformAdmin) {
      return NextResponse.json({ error: "forbidden", message: "Only an owner can reset a manager or owner." }, { status: 403 });
    }

    await prisma.$transaction([
      prisma.user.update({ where: { id: target.id }, data: { mfaEnabled: false, mfaSecret: null, mfaEnrolledAt: null } }),
      prisma.auditEvent.create({
        data: {
          userId: actor.id,
          action: "user.mfa_reset",
          resource: target.id,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent") ?? undefined,
          metadata: {
            organizationId: actor.organizationId,
            targetUserId: target.id,
            hadMfa: target.mfaEnabled,
          } satisfies Prisma.InputJsonValue,
        },
      }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[/api/team/mfa/reset] error:", error);
    return serverError("reset MFA");
  }
}
