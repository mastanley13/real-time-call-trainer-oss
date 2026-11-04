import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { signSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readJsonLimited } from "@/lib/rateLimit";
import { emailsMatch, fitsSeats, inviteStatus, joinBlock, maskEmail, TokenBodySchema, type InviteStatus } from "@/lib/invites";
import { hashInviteToken } from "@/lib/inviteToken";
import { SAMPLE_ORG } from "@/lib/teamSample";
import { teamIsLocal } from "../../team/_lib/server";
import { badRequest, invitesLimit, inviteLinkProblem, lockOrgs, lockUser, seatsFull, seatUsage, serverError } from "../../team/_lib/members";

/**
 * POST { token }: the signed-in person joins the invite's organization with the invite's role. The account's
 * email must match the invite (case-insensitive). Single use: the claim only lands while the invite is still open,
 * so two tabs cannot both accept it. Seat-checked under the organization lock. Answers with a fresh session
 * (cookie and token) that carries the new role.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limited = invitesLimit(req, auth.id);
  if (limited) return limited;

  let token: string;
  try {
    const parsed = TokenBodySchema.safeParse(await readJsonLimited(req));
    if (!parsed.success) return inviteLinkProblem("missing");
    token = parsed.data.token;
  } catch {
    return badRequest("The request body was not valid JSON.");
  }

  if (teamIsLocal()) return NextResponse.json({ ok: true, team: { name: SAMPLE_ORG.name }, sample: true });

  try {
    const tokenHash = hashInviteToken(token);
    const result = await prisma.$transaction(async (tx) => {
      // A first look without locks, only to answer a bad link cheaply and to learn which organizations to lock.
      const seen = await tx.teamInvite.findUnique({ where: { tokenHash }, select: { organizationId: true } });
      if (!seen) return { kind: "link" as const, status: "missing" as const };
      const before = await tx.user.findUnique({ where: { id: auth.id }, select: { organizationId: true } });
      if (!before) return { kind: "unknown_user" as const };

      // The team being joined and the team being left, in id order, then the user row. Two owners of one team who
      // accept invites elsewhere at once queue on the team they are leaving, so the second sees the first gone.
      await lockOrgs(tx, [seen.organizationId, before.organizationId]);
      await lockUser(tx, auth.id);
      // Everything below is read under the locks, against the clock as it is now, not before the wait.
      const now = new Date();

      const invite = await tx.teamInvite.findUnique({ where: { tokenHash } });
      if (!invite) return { kind: "link" as const, status: "missing" as const };
      const status = inviteStatus(invite, now);
      if (status !== "pending") return { kind: "link" as const, status };

      const user = await tx.user.findUnique({ where: { id: auth.id }, select: { id: true, email: true, firstName: true, lastName: true, role: true, organizationId: true } });
      if (!user) return { kind: "unknown_user" as const };
      // The account changed teams between the first look and the locks, so the team it is leaving is not locked.
      if (user.organizationId !== before.organizationId) return { kind: "changed" as const };
      if (!emailsMatch(user.email, invite.email)) return { kind: "email_mismatch" as const, invited: maskEmail(invite.email) };

      const org =await tx.organization.findUnique({ where: { id: invite.organizationId }, select: { id: true, name: true, planTier: true, seatCount: true } });
      if (!org) return { kind: "link" as const, status: "missing" as const };
      if (org.planTier !== "team") return { kind: "not_team_plan" as const };

      let current: { otherMembers: number; otherOwners: number } | null = null;
      if (user.organizationId && user.organizationId !== org.id && user.role === "owner") {
        const [members, owners] = await Promise.all([
          tx.user.count({ where: { organizationId: user.organizationId } }),
          tx.user.count({ where: { organizationId: user.organizationId, role: "owner" } }),
        ]);
        current = { otherMembers: members - 1, otherOwners: owners - 1 };
      }
      const block = joinBlock(user, org.id, current);
      if (block) return { kind: block };

      // This invite already holds one of the pending seats, so it is counted once, as the new member.
      const usage = await seatUsage(tx, org.id, org.seatCount, now);
      if (!fitsSeats({ ...usage, pending: Math.max(0, usage.pending - 1) }, 1)) return { kind: "seats_full" as const, seatCount: org.seatCount };

      const claimed = await tx.teamInvite.updateMany({
        where: { id: invite.id, tokenHash, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } },
        data: { acceptedAt: now, acceptedById: user.id },
      });
      if (claimed.count !== 1) {
        // Say why: used, revoked, expired, or replaced by a resend.
        const fresh = await tx.teamInvite.findUnique({ where: { id: invite.id } });
        const lost: InviteStatus | "missing" = fresh && fresh.tokenHash === tokenHash ? inviteStatus(fresh, new Date()) : "missing";
        return { kind: "link" as const, status: lost === "pending" ? ("accepted" as const) : lost };
      }

      const updated = await tx.user.update({ where: { id: user.id }, data: { organizationId: org.id, role: invite.role } });
      await tx.auditEvent.create({
        data: { userId: user.id, action: "team.invite_accepted", resource: invite.id, metadata: { organizationId: org.id, role: invite.role, previousOrganizationId: user.organizationId } satisfies Prisma.InputJsonValue },
      });
      return { kind: "ok" as const, org, user: updated };
    });

    switch (result.kind) {
      case "link":
        return inviteLinkProblem(result.status);
      case "unknown_user":
        return NextResponse.json({ error: "Unknown user" }, { status: 401 });
      case "changed":
        return NextResponse.json({ error: "conflict", message: "Your team changed while this invite was being accepted. Reload the page and try again." }, { status: 409 });
      case "email_mismatch":
        return NextResponse.json({ error: "email_mismatch", message: `This invite is for ${result.invited}. Sign in with that email address to accept it.` }, { status: 403 });
      case "not_team_plan":
        return NextResponse.json({ error: "team_plan_required", message: "This team's plan no longer includes invites. Ask the team owner to check Billing." }, { status: 409 });
      case "already_member":
        return NextResponse.json({ error: "already_member", message: "You're already on this team." }, { status: 409 });
      case "sole_owner":
        return NextResponse.json({ error: "sole_owner", message: "You're the only owner of your current team, and it has other members. Make someone else an owner there first, then accept this invite." }, { status: 409 });
      case "seats_full":
        return seatsFull(result.seatCount);
    }

    const sessionUser = {
      id: result.user.id,
      email: result.user.email,
      firstName: result.user.firstName ?? undefined,
      lastName: result.user.lastName ?? undefined,
      role: result.user.role as "trainee" | "manager" | "owner",
    };
    const session = signSessionToken(sessionUser);
    const res = NextResponse.json({ ok: true, team: { name: result.org.name }, user: { ...sessionUser, isPlatformAdmin: result.user.isPlatformAdmin }, token: session });
    res.cookies.set("authToken", session, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 12 });
    return res;
  } catch (error) {
    console.error("[/api/invites/accept] POST error:", error instanceof Error ? error.name : "unknown");
    return serverError("accept the invite");
  }
}
