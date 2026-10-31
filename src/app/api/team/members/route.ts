import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { readJsonLimited, userLimitResponse } from "@/lib/rateLimit";
import { canManageTeam, memberName } from "@/lib/team";
import { checkMemberChange, MemberChangeSchema, seesWholeOrg } from "@/lib/teamScope";
import { forbidden, loadActor, noOrganization, serverError, teamIsLocal } from "../_lib/server";

/**
 * The org roster with who reports to whom.
 *
 * GET    owners: everyone; managers: themselves, their reps and reps with no manager (so they can claim them)
 * PATCH  ?id=  { role?, managerId? }  rules in checkMemberChange (teamScope.ts)
 */

const IdParam = z.string().trim().min(1).max(64);
const MEMBER_SELECT = { id: true, firstName: true, lastName: true, email: true, role: true, managerId: true, organizationId: true, createdAt: true, lastLoginAt: true } as const;

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return NextResponse.json({ members: [], local: true });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();
    const whole = seesWholeOrg(actor);
    const [rows, org] = await Promise.all([
      prisma.user.findMany({
        where: {
          organizationId: actor.organizationId,
          ...(whole ? {} : { OR: [{ id: actor.id }, { managerId: actor.id }, { role: "trainee", managerId: null }] }),
        },
        select: MEMBER_SELECT,
        orderBy: { createdAt: "asc" },
        take: 1000,
      }),
      prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { name: true, code: true, isPersonal: true } }),
    ]);
    return NextResponse.json({
      organization: org && { name: org.name, code: org.isPersonal ? null : org.code },
      canEditRoles: whole,
      members: rows.map((u) => ({
        id: u.id,
        name: memberName(u),
        role: u.role,
        managerId: u.managerId,
        joinedAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    console.error("[/api/team/members] GET error:", error);
    return serverError("load your team members");
  }
}

export async function PATCH(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) {
    return NextResponse.json({ error: "local_only", message: "Demo mode uses a sample team. Connect a database to manage real members." }, { status: 400 });
  }
  const limited = userLimitResponse(auth.id, "roster");
  if (limited) return limited;

  const id = IdParam.safeParse(req.nextUrl.searchParams.get("id") ?? "");
  if (!id.success) return NextResponse.json({ error: "invalid_query", message: "Say who to change with ?id=." }, { status: 400 });

  let change: z.infer<typeof MemberChangeSchema>;
  try {
    const parsed = MemberChangeSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) return NextResponse.json({ error: "invalid_request", message: "Send a role (rep or manager) or a manager to change." }, { status: 400 });
    change = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();

    const [target, newManager] = await Promise.all([
      prisma.user.findFirst({ where: { id: id.data, organizationId: actor.organizationId }, select: MEMBER_SELECT }),
      change.managerId ? prisma.user.findFirst({ where: { id: change.managerId, organizationId: actor.organizationId }, select: MEMBER_SELECT }) : null,
    ]);
    if (!target) return NextResponse.json({ error: "Not found", message: "That person is not in your organization." }, { status: 404 });

    const check = checkMemberChange(actor, target, change, newManager);
    if (!check.ok) return NextResponse.json({ error: check.error, message: check.message }, { status: check.status });

    const demoted = change.role === "trainee" && target.role === "manager";
    const updated = await prisma.$transaction(async (tx) => {
      // A manager who becomes a rep stops leading anyone; their reps wait for an owner to place them.
      if (demoted) await tx.user.updateMany({ where: { managerId: target.id }, data: { managerId: null } });
      const row = await tx.user.update({
        where: { id: target.id },
        data: {
          ...(change.role !== undefined ? { role: change.role } : {}),
          ...(change.managerId !== undefined ? { managerId: change.managerId } : {}),
        },
        select: MEMBER_SELECT,
      });
      await tx.auditEvent.create({
        data: {
          userId: actor.id,
          action: "team.member_changed",
          resource: target.id,
          metadata: {
            from: { role: target.role, managerId: target.managerId },
            to: { role: row.role, managerId: row.managerId },
          } satisfies Prisma.InputJsonValue,
        },
      });
      return row;
    });
    return NextResponse.json({
      member: { id: updated.id, name: memberName(updated), role: updated.role, managerId: updated.managerId },
      releasedReports: demoted,
    });
  } catch (error) {
    console.error("[/api/team/members] PATCH error:", error);
    return serverError("save that change");
  }
}
