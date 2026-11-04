import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { teamIsLocal } from "../../_lib/server";
import { accessDenied, badRequest, invitesLimit, loadMembersActor, lockAndRecheck, notFound, notManager, RowIdSchema, serverError } from "../../_lib/members";

type Params = { params: Promise<{ id: string }> };

/** DELETE: revokes a pending or expired invite in the owner's organization. Its link stops working at once. */
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  const id = RowIdSchema.safeParse((await params).id);
  if (!id.success) return badRequest("Say which invite to revoke.");
  if (teamIsLocal()) return NextResponse.json({ ok: true, id: id.data, sample: true });

  try {
    const ctx = await loadMembersActor(auth.id);
    if (!ctx) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (ctx.access !== "manage" || !ctx.org) return accessDenied(ctx.access === "manage" ? "forbidden" : ctx.access);

    const orgId = ctx.org.id;
    const result = await prisma.$transaction(async (tx) => {
      const access = await lockAndRecheck(tx, ctx.actor.id, orgId);
      if (access !== "manage") return { kind: "denied" as const, access };
      // The organization is part of the match, so another team's invite reads as not found.
      const done = await tx.teamInvite.updateMany({
        where: { id: id.data, organizationId: orgId, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (done.count !== 1) return { kind: "not_found" as const };
      await tx.auditEvent.create({ data: { userId: ctx.actor.id, action: "team.invite_revoked", resource: id.data } });
      return { kind: "ok" as const };
    });
    if (result.kind === "denied") return notManager(result.access);
    if (result.kind === "not_found") return notFound("That invite was already accepted or revoked. Reload the page to see the current list.");
    return NextResponse.json({ ok: true, id: id.data });
  } catch (error) {
    console.error("[/api/team/invites/[id]] DELETE error:", error instanceof Error ? error.name : "unknown");
    return serverError("revoke the invite");
  }
}
