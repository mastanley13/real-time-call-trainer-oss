import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { fitsSeats, inviteExpiry, inviteStatus } from "@/lib/invites";
import { hashInviteToken, inviteLink, newInviteToken } from "@/lib/inviteToken";
import { teamIsLocal } from "../../../_lib/server";
import { accessDenied, badRequest, invitesLimit, loadMembersActor, lockAndRecheck, notFound, notManager, RowIdSchema, samplePayload, seatsFull, seatUsage, serverError, toInviteView } from "../../../_lib/members";

type Params = { params: Promise<{ id: string }> };

/**
 * POST: a new link for a pending or expired invite. The token is replaced (the old link stops working) and the
 * invite gets a fresh 7 days. Reviving an expired invite takes a seat again, so it is seat-checked.
 */
export async function POST(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  const id = RowIdSchema.safeParse((await params).id);
  if (!id.success) return badRequest("Say which invite to resend.");
  const now = new Date();

  if (teamIsLocal()) {
    const sample = samplePayload(req, now).invites.find((i) => i.id === id.data);
    const email = sample?.email ?? "new.rep@harborpoint.example";
    return NextResponse.json({
      invite: { id: id.data, email, role: sample?.role ?? "trainee", status: "pending", sentAt: now.toISOString(), expiresAt: inviteExpiry(now).toISOString() },
      link: inviteLink(newInviteToken(), req.nextUrl.origin),
      sample: true,
    });
  }

  try {
    const ctx = await loadMembersActor(auth.id);
    if (!ctx) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (ctx.access !== "manage" || !ctx.org) return accessDenied(ctx.access === "manage" ? "forbidden" : ctx.access);
    const orgId = ctx.org.id;

    const result = await prisma.$transaction(async (tx) => {
      const access = await lockAndRecheck(tx, ctx.actor.id, orgId);
      if (access !== "manage") return { kind: "denied" as const, access };
      const now = new Date();
      const invite =await tx.teamInvite.findFirst({ where: { id: id.data, organizationId: orgId, acceptedAt: null, revokedAt: null } });
      if (!invite) return { kind: "not_found" as const };
      if (inviteStatus(invite, now) === "expired") {
        const org = await tx.organization.findUnique({ where: { id: orgId }, select: { seatCount: true } });
        const seatCount = org?.seatCount ?? 0;
        if (!fitsSeats(await seatUsage(tx, orgId, seatCount, now), 1)) return { kind: "seats_full" as const, seatCount };
      }
      const token = newInviteToken();
      const row = await tx.teamInvite.update({ where: { id: invite.id }, data: { tokenHash: hashInviteToken(token), expiresAt: inviteExpiry(now), sentAt: now } });
      await tx.auditEvent.create({ data: { userId: ctx.actor.id, action: "team.invite_resent", resource: row.id, metadata: { organizationId: orgId } satisfies Prisma.InputJsonValue } });
      return { kind: "ok" as const, row, token, now };
    });

    if (result.kind === "denied") return notManager(result.access);
    if (result.kind === "not_found") return notFound("That invite was already accepted or revoked. Reload the page to see the current list.");
    if (result.kind === "seats_full") return seatsFull(result.seatCount);
    return NextResponse.json({ invite: toInviteView(result.row, result.now), link: inviteLink(result.token, req.nextUrl.origin) });
  } catch (error) {
    console.error("[/api/team/invites/[id]/resend] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("resend the invite");
  }
}
