import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth, isDemoUser } from "@/lib/apiAuth";
import { rateLimit } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";

const Body = z.object({
  sessionId: z.string().min(1).max(128),
  transcript: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), text: z.string().max(8000), timestamp: z.string().optional() })).min(1).max(2000),
  durationSeconds: z.number().int().nonnegative().max(10 * 60 * 60).optional(),
  scenario: z.object({
    id: z.string().max(80),
    title: z.string().max(120).optional(),
    industry: z.string().max(80).optional(),
    difficulty: z.string().max(20).optional(),
  }),
  evaluation: z.any().optional(),
});

/** Save a completed practice session for the signed-in user. */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (isDemoUser(auth)) {
    return NextResponse.json({ error: "Demo mode keeps sessions in the browser only." }, { status: 400 });
  }
  const limit = rateLimit({ key: `transcripts:${auth.id}`, limit: 30, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (e) {
    return NextResponse.json({ error: "Invalid request body", details: (e as Error).message }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: auth.id } });
  if (!dbUser || !dbUser.organizationId) {
    return NextResponse.json({ error: "User or organization not found" }, { status: 404 });
  }

  const ev = body.evaluation as { overallScore?: number; grade?: string; goalAchievement?: { achieved?: boolean } } | undefined;
  try {
    const created = await prisma.trainerSession.create({
      data: {
        userId: dbUser.id,
        organizationId: dbUser.organizationId,
        realtimeSessionId: body.sessionId,
        scenarioId: body.scenario.id,
        scenarioCategory: body.scenario.industry,
        scenarioDifficulty: body.scenario.difficulty,
        scenarioTitle: body.scenario.title,
        durationSeconds: body.durationSeconds ?? 0,
        transcript: body.transcript as unknown as Prisma.InputJsonValue,
        evaluation: (body.evaluation ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        overallScore: typeof ev?.overallScore === "number" ? Math.round(ev.overallScore) : null,
        grade: ev?.grade ?? null,
        goalAchieved: ev?.goalAchievement?.achieved ?? null,
      },
    });
    await prisma.auditEvent.create({
      data: { userId: dbUser.id, action: "session.saved", resource: created.id, metadata: { scenarioId: body.scenario.id, overallScore: ev?.overallScore ?? null } },
    });
    return NextResponse.json({ id: created.id });
  } catch (error) {
    console.error("[/api/transcripts] error:", error);
    return NextResponse.json({ error: "Failed to save session" }, { status: 500 });
  }
}

/** List the signed-in user's sessions (newest first). */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const rows = await prisma.trainerSession.findMany({
    where: { userId: auth.id },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, scenarioId: true, scenarioTitle: true, scenarioCategory: true, durationSeconds: true, overallScore: true, grade: true, goalAchieved: true, createdAt: true, evaluation: true },
  });
  // Only expose the grader version, not the whole evaluation blob.
  const sessions = rows.map(({ evaluation, ...r }) => ({ ...r, graderVersion: (evaluation as { graderVersion?: string } | null)?.graderVersion ?? null }));
  return NextResponse.json({ sessions });
}
