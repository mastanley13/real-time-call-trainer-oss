import "server-only";
import type { Prisma } from "@prisma/client";
import { emailsMatch, fitsSeats, inviteStatus, joinBlock, maskEmail, type InviteStatus } from "@/lib/invites";
import { lockOrgs, lockUser, seatUsage } from "./members";

type Tx = Prisma.TransactionClient;

/**
 * The account `userId` joins the organization of the invite with this token hash, with the invite's role. Runs
 * inside the caller's transaction: POST /api/invites/accept for a signed-in account, and the Google callback for a
 * brand-new account it has just created (it rolls the account back when this is not "ok"). The account's email
 * must match the invite (case-insensitive). Single use: the claim only lands while the invite is still open, so two
 * tabs cannot both accept it. Seat-checked under the organization lock.
 */
export async function acceptInviteTx(tx: Tx, userId: string, tokenHash: string) {
  // A first look without locks, only to answer a bad link cheaply and to learn which organizations to lock.
  const seen = await tx.teamInvite.findUnique({ where: { tokenHash }, select: { organizationId: true } });
  if (!seen) return { kind: "link" as const, status: "missing" as const };
  const before = await tx.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
  if (!before) return { kind: "unknown_user" as const };

  // The team being joined and the team being left, in id order, then the user row. Two owners of one team who
  // accept invites elsewhere at once queue on the team they are leaving, so the second sees the first gone.
  await lockOrgs(tx, [seen.organizationId, before.organizationId]);
  await lockUser(tx, userId);
  // Everything below is read under the locks, against the clock as it is now, not before the wait.
  const now = new Date();

  const invite = await tx.teamInvite.findUnique({ where: { tokenHash } });
  if (!invite) return { kind: "link" as const, status: "missing" as const };
  const status = inviteStatus(invite, now);
  if (status !== "pending") return { kind: "link" as const, status };

  const user = await tx.user.findUnique({ where: { id: userId }, select: { id: true, email: true, firstName: true, lastName: true, role: true, organizationId: true } });
  if (!user) return { kind: "unknown_user" as const };
  // The account changed teams between the first look and the locks, so the team it is leaving is not locked.
  if (user.organizationId !== before.organizationId) return { kind: "changed" as const };
  if (!emailsMatch(user.email, invite.email)) return { kind: "email_mismatch" as const, invited: maskEmail(invite.email) };

  const org = await tx.organization.findUnique({ where: { id: invite.organizationId }, select: { id: true, name: true, planTier: true, seatCount: true } });
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
}

export type AcceptInviteResult = Awaited<ReturnType<typeof acceptInviteTx>>;
