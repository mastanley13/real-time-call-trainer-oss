import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { LIBRARY } from "@/lib/personas";
import { buildOverview, canManageTeam, gradeOf, memberName, parseWindow, type TeamSession } from "@/lib/team";
import { buildSampleOverview } from "@/lib/teamSample";
import { forbidden, limitFor, loadActor, loadAssignmentViews, noOrganization, orgMembers, serverError, teamIsLocal } from "../_lib/server";

/**
 * Team overview for managers and owners (and platform admins), scoped to the
 * actor's own organization as stored in the database. Demo mode and installs
 * without a database get a clearly labelled sample team instead.
 */

const DAY = 86_400_000;
const HISTORY_DAYS = 90;
const Query = z.object({ days: z.enum(["7", "30", "90"]).default("30") });
const titles = new Map(LIBRARY.map((s) => [s.id, s.title]));

export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const parsed = Query.safeParse({ days: req.nextUrl.searchParams.get("days") ?? undefined });
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query", message: "Pick a window of 7, 30 or 90 days." }, { status: 400 });
  }
  const days = parseWindow(parsed.data.days);
  const now = new Date();

  if (teamIsLocal()) return NextResponse.json(buildSampleOverview(days, now, { id: auth.id, name: memberName(auth) }));

  const limited = limitFor(`team:overview:${auth.id}`, 60, 60_000);
  if (limited) return limited;

  try {
    const actor = await loadActor(auth.id);
    if (!actor) return NextResponse.json({ error: "Unknown user" }, { status: 401 });
    if (!canManageTeam(actor.role, actor.isPlatformAdmin)) return forbidden();
    if (!actor.organizationId) return noOrganization();
    const orgId = actor.organizationId;
    const since = new Date(now.getTime() - days * DAY);
    const historySince = new Date(now.getTime() - Math.max(days, HISTORY_DAYS) * DAY);

    const [org, members, windowRows, historyRows, lastSeenRows] = await Promise.all([
      prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true } }),
      orgMembers(orgId),
      // Evaluations are only read for the window: they drive the matrix, weakest criterion and queue.
      prisma.trainerSession.findMany({
        where: { organizationId: orgId, createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 2000,
        select: { id: true, userId: true, scenarioId: true, scenarioTitle: true, overallScore: true, goalAchieved: true, evaluation: true, createdAt: true, supervisorNotes: true },
      }),
      // Older scores feed sparklines and the last-session column only.
      prisma.trainerSession.findMany({
        where: { organizationId: orgId, createdAt: { gte: historySince, lt: since } },
        orderBy: { createdAt: "desc" },
        take: 2000,
        select: { id: true, userId: true, scenarioId: true, scenarioTitle: true, overallScore: true, goalAchieved: true, createdAt: true },
      }),
      prisma.trainerSession.groupBy({ by: ["userId"], where: { organizationId: orgId }, _max: { createdAt: true } }),
    ]);

    const title = (id: string, t: string | null) => t ?? titles.get(id) ?? id;
    const sessions: TeamSession[] = [
      // gradeOf drops criteria along with the score for legacy keyword-grader rows, so they never reach the matrix or queue.
      ...windowRows.map((r) => ({
        id: r.id, userId: r.userId, scenarioId: r.scenarioId, scenarioTitle: title(r.scenarioId, r.scenarioTitle),
        ...gradeOf(r.overallScore, r.evaluation), goalAchieved: r.goalAchieved,
        createdAt: r.createdAt.toISOString(), hasNotes: !!r.supervisorNotes,
      })),
      // Without the evaluation we cannot spot legacy-grader rows here; they predate versioning and are rare.
      ...historyRows.map((r) => ({
        id: r.id, userId: r.userId, scenarioId: r.scenarioId, scenarioTitle: title(r.scenarioId, r.scenarioTitle),
        score: r.overallScore, goalAchieved: r.goalAchieved, criteria: [], createdAt: r.createdAt.toISOString(), hasNotes: false,
      })),
    ];
    const lastSeen = Object.fromEntries(lastSeenRows.flatMap((r) => (r._max.createdAt ? [[r.userId, r._max.createdAt.toISOString()]] : [])));
    const assignments = await loadAssignmentViews(orgId, members);

    return NextResponse.json(buildOverview({
      org: org ?? { id: orgId, name: "Your team" }, days, now, members, sessions, lastSeen,
      libraryIds: LIBRARY.map((s) => s.id), assignments,
    }));
  } catch (error) {
    console.error("[/api/team/overview] error:", error);
    return serverError("load your team");
  }
}
