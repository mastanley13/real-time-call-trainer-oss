import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { AssignmentInputSchema, assignmentInputMessage, assignmentProgress, canManageTeam, parseDueAt, teamIdsOf, toAssignmentView } from "@/lib/team";
import { forbidden, limitFor, loadActor, loadAssignmentViews, noOrganization, orgMembers, serverError, teamIsLocal, toAssignment } from "../_lib/server";

/**
 * Training assignments: a manager asks one rep, or the whole team, to practise
 * a persona. Everything is scoped to the actor's organization as stored in the
 * database. Completion is derived from sessions, so there is nothing to mark done.
 *
 * GET    managers: the org's active assignments; trainees (or ?scope=mine): theirs plus team-wide
 * POST   manager/owner/platform admin only
 * DELETE ?id=  archives one assignment in the actor's org
 */

const Scope = z.enum(["team", "mine"]).optional();
const IdParam = z.string().trim().min(1).max(64);
const localOnly = () =>
  NextResponse.json({ error: "local_only", message: "Demo mode keeps assignments in this browser. Connect a database to share them with your team." }, { status: 400 });
const writeLimit = (userId: string) => limitFor(`team:assign:${userId}`, 20, 60_000);

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return NextResponse.json({ assignments: [], local: true });

  const scope = Scope.safeParse(req.nextUrl.searchParams.get("scope") ?? undefined);
  if (!scope.success) return NextResponse.json({ error: "invalid_query", message: "scope must be team or mine." }, { status: 400 });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!actor.organizationId) return NextResponse.json({ assignments: [] });
    // Trainees only ever see their own list, whatever they ask for.
    const mine = scope.data === "mine" || !canManageTeam(actor.role, actor.isPlatformAdmin);
    const members = await orgMembers(actor.organizationId);
    const assignments = await loadAssignmentViews(actor.organizationId, members, mine ? actor.id : undefined);
    return NextResponse.json({ assignments, scope: mine ? "mine" : "team" });
  } catch (error) {
    console.error("[/api/team/assignments] GET error:", error);
    return serverError("load assignments");
  }
}

export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = writeLimit(auth.id);
  if (limited) return limited;

  let body: z.infer<typeof AssignmentInputSchema>;
  try {
    const parsed = AssignmentInputSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_request", message: assignmentInputMessage(parsed.error.issues[0]?.path[0]) }, { status: 400 });
    }
    body = parsed.data;
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "The request body was not valid JSON." }, { status: 400 });
  }

  const now = new Date();
  const due = parseDueAt(body.dueAt, now);
  if (!due.ok) return NextResponse.json({ error: "invalid_due_date", message: due.message }, { status: 400 });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) {
      return NextResponse.json({ error: "forbidden", message: "Only managers and owners can assign personas." }, { status: 403 });
    }
    if (!actor.organizationId) return noOrganization();
    const orgId = actor.organizationId;

    if (body.assigneeId) {
      const assignee = await prisma.user.findFirst({ where: { id: body.assigneeId, organizationId: orgId }, select: { id: true } });
      if (!assignee) {
        return NextResponse.json({ error: "invalid_assignee", message: "That person is not in your organization. Refresh the page and pick someone from the list." }, { status: 400 });
      }
    }

    const created = await prisma.trainingAssignment.create({
      data: {
        organizationId: orgId,
        assignedById: actor.id,
        assigneeId: body.assigneeId ?? null,
        scenarioId: body.scenarioId,
        scenarioTitle: body.scenarioTitle,
        note: body.note ? body.note : null,
        dueAt: due.value,
      },
    });
    await prisma.auditEvent.create({
      data: {
        userId: actor.id,
        action: "team.assignment_created",
        resource: created.id,
        metadata: { scenarioId: created.scenarioId, assigneeId: created.assigneeId, dueAt: created.dueAt?.toISOString() ?? null } satisfies Prisma.InputJsonValue,
      },
    });

    const members = await orgMembers(orgId);
    const assignment = toAssignment(created);
    // Brand new, so nobody has completed it yet.
    const view = toAssignmentView(assignment, new Map(members.map((m) => [m.id, m.name])), assignmentProgress(assignment, [], teamIdsOf(members)));
    return NextResponse.json({ assignment: view }, { status: 201 });
  } catch (error) {
    console.error("[/api/team/assignments] POST error:", error);
    return serverError("save the assignment");
  }
}

export async function DELETE(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (teamIsLocal()) return localOnly();
  const limited = writeLimit(auth.id);
  if (limited) return limited;

  const id = IdParam.safeParse(req.nextUrl.searchParams.get("id") ?? "");
  if (!id.success) return NextResponse.json({ error: "invalid_query", message: "Say which assignment to archive with ?id=." }, { status: 400 });

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();

    // Same-org check is part of the lookup, so another org's id reads as not found.
    const existing = await prisma.trainingAssignment.findFirst({ where: { id: id.data, organizationId: actor.organizationId, archivedAt: null }, select: { id: true } });
    if (!existing) return NextResponse.json({ error: "Not found", message: "That assignment is already archived or does not exist." }, { status: 404 });

    await prisma.trainingAssignment.update({ where: { id: existing.id }, data: { archivedAt: new Date() } });
    await prisma.auditEvent.create({ data: { userId: actor.id, action: "team.assignment_archived", resource: existing.id } });
    return NextResponse.json({ ok: true, id: existing.id });
  } catch (error) {
    console.error("[/api/team/assignments] DELETE error:", error);
    return serverError("archive the assignment");
  }
}
