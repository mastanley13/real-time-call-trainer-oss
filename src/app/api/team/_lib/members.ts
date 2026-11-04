import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import type { Prisma, TeamInvite } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { DEMO_USER } from "@/lib/serverConfig";
import { ipLimitResponse, userLimitResponse } from "@/lib/rateLimit";
import { inviteStatus, membersAccess, payloadSeats, seatsFullMessage, sortInvites, type InviteRole, type InviteView, type MembersAccess, type MembersPayload, type SeatUsage } from "@/lib/invites";
import { buildSampleMembers, sampleVariant } from "@/lib/membersSample";
import { memberName, type TeamRole } from "@/lib/team";

type Tx = Prisma.TransactionClient;

/** A member or invite id from the URL. */
export const RowIdSchema = z.string().trim().min(1).max(64);

/** The actor and their organization as stored, so role and org never come from the client or a stale token. */
export async function loadMembersActor(userId: string) {
  const actor = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, role: true, organizationId: true },
  });
  if (!actor) return null;
  const org = actor.organizationId
    ? await prisma.organization.findUnique({ where: { id: actor.organizationId }, select: { id: true, name: true, planTier: true, seatCount: true } })
    : null;
  return { actor, org, access: membersAccess(actor, org) };
}

/** Both limits, IP and account. Null when allowed. */
export function invitesLimit(req: NextRequest, userId: string): Response | null {
  return ipLimitResponse(req, "invites") ?? userLimitResponse(userId, "invites");
}

export function accessDenied(access: Exclude<MembersAccess, "manage">): NextResponse {
  switch (access) {
    case "no_organization":
      return NextResponse.json({ error: "no_organization", message: "Your account is not part of an organization yet." }, { status: 404 });
    case "not_team_plan":
      return NextResponse.json({ error: "team_plan_required", message: "Inviting people needs the Team plan. An owner can choose it from Billing." }, { status: 403 });
    default:
      return NextResponse.json({ error: "forbidden", message: "Only an owner of this team can invite or remove people." }, { status: 403 });
  }
}

export const seatsFull = (seatCount: number) =>
  NextResponse.json({ error: "seats_full", message: seatsFullMessage(seatCount), seats: seatCount }, { status: 409 });

export const badRequest = (message: string) => NextResponse.json({ error: "invalid_request", message }, { status: 400 });

export const notFound = (message: string) => NextResponse.json({ error: "not_found", message }, { status: 404 });

export const serverError = (what: string) =>
  NextResponse.json({ error: "server_error", message: `Could not ${what}. Try again in a minute.` }, { status: 500 });

/**
 * Locks the organization row for the rest of the transaction, so two invites or accepts that race each other
 * count seats one after the other and cannot both take the last one.
 */
export async function lockOrg(tx: Tx, organizationId: string) {
  await tx.$queryRaw`SELECT "id" FROM "Organization" WHERE "id" = ${organizationId} FOR UPDATE`;
}

/**
 * Locks several organizations, each once, in id order. Every path that takes more than one organization lock goes
 * through here, so two transactions never wait on each other's locks in opposite orders.
 */
export async function lockOrgs(tx: Tx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  for (const id of unique) await lockOrg(tx, id);
}

/** Locks one user row. Taken after any organization locks, the same order the member routes use. */
export async function lockUser(tx: Tx, userId: string) {
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
}

/**
 * Takes the organization lock, then re-reads the actor's membership, role and the plan under it. The check before
 * the transaction can be stale by then: another owner may have removed or demoted this one while they waited.
 * Every member and invite change goes through this before it writes.
 */
export async function lockAndRecheck(tx: Tx, actorId: string, organizationId: string): Promise<MembersAccess> {
  await lockOrg(tx, organizationId);
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, organizationId: true } });
  if (!actor || actor.organizationId !== organizationId) return "forbidden";
  const org = await tx.organization.findUnique({ where: { id: organizationId }, select: { planTier: true } });
  return membersAccess(actor, org);
}

/** The 403 or 404 for an actor who is not (or no longer) allowed to manage. */
export const notManager = (access: MembersAccess) => accessDenied(access === "manage" ? "forbidden" : access);

/** Pending means not accepted, not revoked and not expired. */
export const pendingWhere = (organizationId: string, now: Date) => ({ organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: now } });

export async function seatUsage(tx: Tx, organizationId: string, seatCount: number, now: Date): Promise<SeatUsage> {
  const [members, pending] = await Promise.all([
    tx.user.count({ where: { organizationId } }),
    tx.teamInvite.count({ where: pendingWhere(organizationId, now) }),
  ]);
  return { members, pending, seatCount };
}

export function toInviteView(i: TeamInvite, now: Date): InviteView {
  const status = inviteStatus(i, now);
  return {
    id: i.id, email: i.email, role: i.role as InviteRole, status: status === "pending" ? "pending" : "expired",
    expiresAt: i.expiresAt.toISOString(), sentAt: i.sentAt.toISOString(),
  };
}

/** Members and open invites (pending or expired; accepted and revoked ones drop off) for the Members page. */
export async function loadMembersPayload(viewerId: string, org: { id: string; name: string; planTier: string; seatCount: number }, access: MembersAccess, now: Date): Promise<MembersPayload> {
  const [users, invites] = await Promise.all([
    prisma.user.findMany({
      where: { organizationId: org.id },
      select: { id: true, firstName: true, lastName: true, email: true, role: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: 1000,
    }),
    prisma.teamInvite.findMany({
      where: { organizationId: org.id, acceptedAt: null, revokedAt: null },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  ]);
  const members = users.map((u) => ({ id: u.id, name: memberName(u), email: u.email, role: u.role as TeamRole, joinedAt: u.createdAt.toISOString() }));
  const views = sortInvites(invites.map((i) => toInviteView(i, now)));
  const o = { name: org.name, seatCount: org.seatCount, planTier: org.planTier };
  return { org: o, access, viewerId, members, invites: views, seats: payloadSeats({ members, invites: views, org: o }) };
}

/** The answer for a link that cannot be used: unknown or revoked (404), already used or expired (410). */
export function inviteLinkProblem(status: "missing" | "accepted" | "revoked" | "expired"): NextResponse {
  switch (status) {
    case "accepted":
      return NextResponse.json({ error: "invite_used", message: "This invite was already accepted. Ask the team owner for a new link if you still need to join." }, { status: 410 });
    case "expired":
      return NextResponse.json({ error: "invite_expired", message: "This invite has expired. Ask the team owner to resend it." }, { status: 410 });
    default:
      return NextResponse.json({ error: "invite_not_found", message: "This invite link is not valid. It may have been revoked or replaced by a newer one. Ask the team owner for a new link." }, { status: 404 });
  }
}

/** Demo mode and database-less installs: the sample page. `?demo=full` shows every seat taken. */
export function samplePayload(req: NextRequest, now = new Date()): MembersPayload {
  const name = `${DEMO_USER.firstName ?? "Demo"} ${DEMO_USER.lastName ?? "User"}`.trim();
  return buildSampleMembers(sampleVariant(req.nextUrl.searchParams.get("demo")), now, { id: DEMO_USER.id, name, email: DEMO_USER.email });
}
