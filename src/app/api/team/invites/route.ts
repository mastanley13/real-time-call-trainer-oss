import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { readJsonLimited } from "@/lib/rateLimit";
import { fitsSeats, inviteExpiry, InviteCreateSchema, MAX_INVITES_PER_REQUEST, type InviteCreateInput } from "@/lib/invites";
import { hashInviteToken, inviteLink, newInviteToken } from "@/lib/inviteToken";
import { teamIsLocal } from "../_lib/server";
import { accessDenied, badRequest, invitesLimit, loadMembersActor, lockAndRecheck, notManager, pendingWhere, samplePayload, seatsFull, seatUsage, serverError, toInviteView } from "../_lib/members";

/**
 * POST { emails: string[], role?: "trainee" | "manager" }: invites people to the owner's Team-plan organization.
 * Each invite gets its own link, returned once; only the token's sha256 is stored. Nothing is emailed.
 * 409 seats_full when members plus pending invites plus these would pass the organization's seat count.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  let body: InviteCreateInput;
  try {
    const parsed = InviteCreateSchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) return badRequest(`Enter up to ${MAX_INVITES_PER_REQUEST} valid email addresses, separated by commas or new lines.`);
    body = parsed.data;
  } catch {
    return badRequest("The request body was not valid JSON.");
  }
  const emails = [...new Set(body.emails)];
  const now = new Date();

  // Demo mode: checked against the sample seats, and nothing is saved.
  if (teamIsLocal()) {
    const sample = samplePayload(req, now);
    const usage = { members: sample.members.length, pending: sample.seats.used - sample.members.length, seatCount: sample.org.seatCount };
    if (!fitsSeats(usage, emails.length)) return seatsFull(usage.seatCount);
    const invites = emails.map((email, i) => {
      const token = newInviteToken();
      return { id: `sample-invite-new-${now.getTime()}-${i}`, email, role: body.role, status: "pending" as const, sentAt: now.toISOString(), expiresAt: inviteExpiry(now).toISOString(), link: inviteLink(token, req.nextUrl.origin) };
    });
    return NextResponse.json({ invites, sample: true }, { status: 201 });
  }

  try {
    const ctx = await loadMembersActor(auth.id);
    if (!ctx) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (ctx.access !== "manage" || !ctx.org) return accessDenied(ctx.access === "manage" ? "forbidden" : ctx.access);
    const orgId = ctx.org.id;

    const result = await prisma.$transaction(async (tx) => {
      const access = await lockAndRecheck(tx, ctx.actor.id, orgId);
      if (access !== "manage") return { kind: "denied" as const, access };
      // Seat count re-read under the lock, so a change from billing in the meantime counts. The clock is read
      // again too, since the lock may have taken a while.
      const now = new Date();
      const org = await tx.organization.findUnique({ where: { id: orgId }, select: { seatCount: true } });
      if (!org) return { kind: "denied" as const, access: "no_organization" as const };

      const members = await tx.user.findMany({ where: { organizationId: orgId, email: { in: emails } }, select: { email: true } });
      if (members.length) return { kind: "already_member" as const, emails: members.map((m) => m.email) };
      const pending = await tx.teamInvite.findMany({ where: { ...pendingWhere(orgId, now), email: { in: emails } }, select: { email: true } });
      if (pending.length) return { kind: "already_invited" as const, emails: pending.map((p) => p.email) };

      const usage = await seatUsage(tx, orgId, org.seatCount, now);
      if (!fitsSeats(usage, emails.length)) return { kind: "seats_full" as const, seatCount: org.seatCount };

      // An expired invite to the same address is replaced by the new one, so the list shows each person once.
      await tx.teamInvite.updateMany({ where: { organizationId: orgId, email: { in: emails }, acceptedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const created = [];
      for (const email of emails) {
        const token = newInviteToken();
        const row = await tx.teamInvite.create({
          data: { organizationId: orgId, email, role: body.role, tokenHash: hashInviteToken(token), invitedById: ctx.actor.id, expiresAt: inviteExpiry(now), sentAt: now },
        });
        await tx.auditEvent.create({
          data: { userId: ctx.actor.id, action: "team.invite_created", resource: row.id, metadata: { organizationId: orgId, role: body.role } satisfies Prisma.InputJsonValue },
        });
        created.push({ row, token });
      }
      return { kind: "ok" as const, created, now };
    });

    switch (result.kind) {
      case "denied":
        return notManager(result.access);
      case "already_member":
        return NextResponse.json({ error: "already_member", message: `${result.emails.join(", ")} ${result.emails.length === 1 ? "is" : "are"} already on this team.`, emails: result.emails }, { status: 409 });
      case "already_invited":
        return NextResponse.json({ error: "already_invited", message: `${result.emails.join(", ")} already ${result.emails.length === 1 ? "has a pending invite" : "have pending invites"}. Use Resend to get a new link.`, emails: result.emails }, { status: 409 });
      case "seats_full":
        return seatsFull(result.seatCount);
    }
    const invites = result.created.map(({ row, token }) => ({ ...toInviteView(row, result.now), link: inviteLink(token, req.nextUrl.origin) }));
    return NextResponse.json({ invites }, { status: 201 });
  } catch (error) {
    console.error("[/api/team/invites] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("create the invite");
  }
}
