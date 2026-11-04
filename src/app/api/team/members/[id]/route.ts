import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { removeBlock } from "@/lib/invites";
import { teamIsLocal } from "../../_lib/server";
import { accessDenied, badRequest, invitesLimit, loadMembersActor, lockAndRecheck, notFound, notManager, RowIdSchema, serverError } from "../../_lib/members";

type Params = { params: Promise<{ id: string }> };

/**
 * DELETE: removes a member from the owner's organization. They keep their account and their past calls stay with
 * the team; they lose access to the team and its minute pool. An owner cannot remove themselves or the last owner.
 */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  const id = RowIdSchema.safeParse((await params).id);
  if (!id.success) return badRequest("Say which member to remove.");
  if (teamIsLocal()) {
    if (id.data === "demo-user") return NextResponse.json({ error: "cannot_remove_self", message: "You can't remove yourself from the team." }, { status: 400 });
    return NextResponse.json({ ok: true, id: id.data, sample: true });
  }

  try {
    const ctx = await loadMembersActor(auth.id);
    if (!ctx) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (ctx.access !== "manage" || !ctx.org) return accessDenied(ctx.access === "manage" ? "forbidden" : ctx.access);
    const orgId = ctx.org.id;

    const outcome = await prisma.$transaction(async (tx) => {
      // Re-checked under the lock: two owners removing each other at once must not both succeed.
      const access = await lockAndRecheck(tx, ctx.actor.id, orgId);
      if (access !== "manage") return { result: "denied" as const, access };
      const target = await tx.user.findFirst({ where: { id: id.data, organizationId: orgId }, select: { id: true, role: true } });
      if (!target) return { result: "not_found" as const };
      const owners = await tx.user.count({ where: { organizationId: orgId, role: "owner" } });
      const block = removeBlock(ctx.actor.id, target, owners);
      if (block) return { result: block };
      await tx.user.update({ where: { id: target.id }, data: { organizationId: null, role: "trainee" } });
      await tx.auditEvent.create({ data: { userId: ctx.actor.id, action: "team.member_removed", resource: target.id, metadata: { organizationId: orgId, role: target.role } satisfies Prisma.InputJsonValue } });
      return { result: "ok" as const };
    });

    switch (outcome.result) {
      case "denied":
        return notManager(outcome.access);
      case "not_found":
        return notFound("That person is no longer on this team. Reload the page to see the current list.");
      case "self":
        return NextResponse.json({ error: "cannot_remove_self", message: "You can't remove yourself from the team." }, { status: 400 });
      case "last_owner":
        return NextResponse.json({ error: "last_owner", message: "A team needs at least one owner. Make someone else an owner first." }, { status: 409 });
    }
    return NextResponse.json({ ok: true, id: id.data });
  } catch (error) {
    console.error("[/api/team/members/[id]] DELETE error:", error instanceof Error ? error.name : "unknown");
    return serverError("remove the member");
  }
}
