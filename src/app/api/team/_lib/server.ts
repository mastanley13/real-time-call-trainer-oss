import "server-only";
import { NextResponse } from "next/server";
import type { TrainingAssignment } from "@prisma/client";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import { getCapabilities } from "@/lib/serverConfig";
import { assignmentProgress, memberName, progressFor, teamIdsOf, toAssignmentView, withRetention, type Assignment, type AssignmentView, type TeamMember, type TeamRole } from "@/lib/team";
import { membersInScope, seesWholeOrg, teamAssignmentReaches } from "@/lib/teamScope";

/** Demo mode and database-less installs use the sample team and the browser-only assignment store. */
export function teamIsLocal(): boolean {
  const caps = getCapabilities();
  return caps.demoMode || !caps.database;
}

/** The signed-in user as stored, so role and organization never come from the client or a stale token. */
export async function loadActor(userId: string) {
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, isPlatformAdmin: true, organizationId: true, managerId: true, firstName: true, lastName: true, email: true },
  });
}
export type Actor = NonNullable<Awaited<ReturnType<typeof loadActor>>>;

export const forbidden = () =>
  NextResponse.json({ error: "forbidden", message: "Team view is for managers and owners. Ask your manager if you need access." }, { status: 403 });

export const noOrganization = () =>
  NextResponse.json({ error: "no_organization", message: "Your account is not part of an organization yet. Join one with your team's org code to see a team." }, { status: 404 });

export const serverError = (what: string) =>
  NextResponse.json({ error: "server_error", message: `Could not ${what}. Try again in a minute.` }, { status: 500 });

/** Per-user limit with the same 429 shape as ipLimitResponse. Returns null when allowed. */
export function limitFor(key: string, limit: number, windowMs: number): NextResponse | null {
  const r = rateLimit({ key, limit, windowMs });
  if (r.allowed) return null;
  const retryAfter = Math.max(1, Math.ceil(r.retryAfterMs / 1000));
  return NextResponse.json(
    { error: "rate_limited", message: `You're going a bit fast. Please wait ${retryAfter} seconds and try again.`, retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** A team member plus who they report to. Extra fields are fine wherever a TeamMember is expected. */
export type ScopedMember = TeamMember & { managerId: string | null };

export async function orgMembers(organizationId: string): Promise<ScopedMember[]> {
  const users = await prisma.user.findMany({
    where: { organizationId },
    select: { id: true, firstName: true, lastName: true, email: true, role: true, managerId: true },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  return users.map((u) => ({ id: u.id, name: memberName(u), role: u.role as TeamRole, managerId: u.managerId ?? null }));
}

/**
 * The people a manager-level actor sees: owners and platform admins get the
 * whole org (or one manager's team with `managerFilter`), managers get
 * themselves and their own reps.
 */
export async function scopedMembers(actor: Actor, managerFilter?: string | null): Promise<ScopedMember[]> {
  if (!actor.organizationId) return [];
  return membersInScope(actor, await orgMembers(actor.organizationId), managerFilter);
}

export const toAssignment = (a: TrainingAssignment): Assignment => ({
  id: a.id, assignedById: a.assignedById, assigneeId: a.assigneeId, scenarioId: a.scenarioId, scenarioTitle: a.scenarioTitle,
  note: a.note, dueAt: a.dueAt?.toISOString() ?? null, createdAt: a.createdAt.toISOString(), archivedAt: a.archivedAt?.toISOString() ?? null,
  teamOfId: a.teamOfId ?? null,
});

export interface AssignmentScope {
  /** Assignee view: that person's own and whole-team assignments that reach them. */
  forUser?: { id: string; managerId: string | null };
  /** Manager view: assignments they made, their team-wide ones and any for their reps. */
  managedBy?: { id: string; memberIds: string[] };
}

/**
 * Active assignments with derived completion. `forUserId` switches to the
 * assignee view: only that person's and whole-team assignments, with progress
 * for that person alone. The completing session is the rep's latest graded one
 * on that persona after the assignment was made.
 */
export async function loadAssignmentViews(organizationId: string, members: ScopedMember[], scope: AssignmentScope = {}): Promise<AssignmentView[]> {
  const forUserId = scope.forUser?.id;
  const [rows, org] = await Promise.all([
    prisma.trainingAssignment.findMany({
      where: {
        organizationId,
        archivedAt: null,
        ...(scope.forUser
          ? {
              OR: [
                { assigneeId: scope.forUser.id },
                { assigneeId: null, teamOfId: null },
                ...(scope.forUser.managerId ? [{ assigneeId: null, teamOfId: scope.forUser.managerId }] : []),
              ],
            }
          : {}),
        ...(scope.managedBy
          ? {
              OR: [
                { assignedById: scope.managedBy.id },
                { teamOfId: scope.managedBy.id },
                { assigneeId: { in: scope.managedBy.memberIds } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prisma.organization.findUnique({ where: { id: organizationId }, select: { sessionRetentionDays: true } }),
  ]);
  if (!rows.length) return [];
  const list = rows.map(toAssignment);
  const earliest = rows.reduce((min, r) => (r.createdAt < min ? r.createdAt : min), rows[0].createdAt);
  // One row per rep and persona: their latest graded session since the oldest active assignment.
  // If that one isn't after an assignment, no earlier one is either, so this is exact with no row cap.
  // Ungraded sessions don't count: a score is only stored when the server's grade seal verified.
  const sessions = await prisma.trainerSession.findMany({
    where: {
      organizationId,
      scenarioId: { in: [...new Set(rows.map((r) => r.scenarioId))] },
      createdAt: { gt: earliest },
      overallScore: { not: null },
      ...(forUserId ? { userId: forUserId } : {}),
    },
    distinct: ["userId", "scenarioId"],
    orderBy: { createdAt: "desc" },
    select: { id: true, userId: true, scenarioId: true, createdAt: true },
  });
  const done = sessions.map((s) => ({ ...s, createdAt: s.createdAt.toISOString() }));
  const names = new Map(members.map((m) => [m.id, m.name]));
  // A manager's team-wide assignment counts only their reps.
  const teamFor = (a: Assignment) => teamIdsOf(members.filter((m) => teamAssignmentReaches(a.teamOfId ?? null, m)));
  const now = new Date();
  return list.map((a) => {
    const progress = forUserId ? progressFor(a, forUserId, done) : assignmentProgress(a, done, teamFor(a));
    return toAssignmentView(a, names, withRetention(progress, a.createdAt, org?.sessionRetentionDays, now));
  });
}

/** Assignment scope for the team view: none for owners, the manager's own team otherwise. */
export function managerScope(actor: Actor, members: ScopedMember[]): AssignmentScope {
  return seesWholeOrg(actor) ? {} : { managedBy: { id: actor.id, memberIds: members.map((m) => m.id) } };
}
