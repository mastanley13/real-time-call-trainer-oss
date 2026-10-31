import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { isDemoUser, requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { clientIp, ipLimitResponse, rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { evaluateCall } from "@/lib/grader";
import type { Evaluation } from "@/lib/grader-types";
import { canRegrade, gradable, gradedNote, isAiGrade } from "@/lib/gradable";
import { getCapabilities, llmKey } from "@/lib/serverConfig";
import { paidFeaturesGuard } from "@/lib/spendGuard";

type Params = { params: Promise<{ id: string }> };

/** Managers/owners of the session's org, or a platform admin. */
async function managesOrgOf(userId: string, session: { organizationId: string }): Promise<boolean> {
  const actor = await prisma.user.findUnique({ where: { id: userId } });
  return (
    !!actor &&
    (actor.isPlatformAdmin || ((actor.role === "manager" || actor.role === "owner") && actor.organizationId === session.organizationId))
  );
}

/** Owners can act on their own session; managers/owners on their org's sessions; platform admins on any. */
async function canAccess(userId: string, session: { userId: string; organizationId: string }): Promise<boolean> {
  return session.userId === userId || managesOrgOf(userId, session);
}

/** Fetch one session. Owners can read their own; managers/owners can read their org's. */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const session = await prisma.trainerSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await canAccess(auth.id, session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return NextResponse.json({ session });
}

/**
 * Only a scenario may come from the client, and it is used only for custom
 * scenarios the server doesn't know. Anything else in the body (an
 * evaluation, a transcript) is ignored: the server grades what it stored.
 */
const RegradeBody = z.object({ scenario: ScenarioSchema.optional() });
const StoredTranscript = z.array(z.object({ role: z.enum(["user", "assistant", "system"]), text: z.string() }).passthrough());

const REGRADE_LIMIT = 5;
const REGRADE_WINDOW_MS = 10 * 60_000;

const fail = (status: number, error: string, message: string, extra?: Record<string, unknown>) =>
  NextResponse.json({ error, message, ...extra }, { status });
const notAllowed = () => fail(403, "regrade_not_allowed", "This call already has an AI grade. Ask your manager if you think it is wrong.");

/**
 * Re-grade a stored session with the configured AI model and save the new grade. Managers/owners of the
 * session's org and platform admins can re-grade any library-persona call (custom personas need the
 * scenario from the client); the trainee only while it has no AI grade.
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const paused = paidFeaturesGuard();
  if (paused) return paused;
  if (isDemoUser(auth) || !getCapabilities().database) {
    return fail(400, "server_sessions_unavailable", "This server keeps sessions in the browser, so it has no stored session to re-grade.");
  }
  if (!llmKey()) {
    return fail(503, "llm_not_configured", "AI grading isn't set up on this server. Add LLM_API_KEY to the server environment, then try again.");
  }

  const ipLimited = ipLimitResponse(req, "grading");
  if (ipLimited) return ipLimited;
  const limit = rateLimit({ key: `regrade:${auth.id}`, limit: REGRADE_LIMIT, windowMs: REGRADE_WINDOW_MS });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    const mins = Math.ceil(retryAfter / 60);
    return NextResponse.json(
      { error: "rate_limited", message: `You've re-graded ${REGRADE_LIMIT} calls in 10 minutes. Wait ${mins} minute${mins === 1 ? "" : "s"} and try again.`, retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: z.infer<typeof RegradeBody>;
  try {
    body = RegradeBody.parse(await readJsonLimited(req));
  } catch (e) {
    if (e instanceof Error && e.message === "too_large") return fail(413, "payload_too_large", "The request is too large. Send only the scenario.");
    return fail(400, "Invalid request body", "Send a JSON object, optionally with the session's scenario.", {
      details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined,
    });
  }

  const { id } = await params;
  const session = await prisma.trainerSession.findUnique({ where: { id } });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ownsSession = session.userId === auth.id;
  const managesOrg = await managesOrgOf(auth.id, session);
  if (!ownsSession && !managesOrg) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // Team views and assignment completion read this score, so a trainee can't re-roll an AI grade; their manager can.
  if (!canRegrade({ managesOrg, ownsSession }, session.evaluation)) return notAllowed();

  // Library personas come from the server's own copy, so a client can't loosen the rubric it is graded on.
  const libraryScenario = LIBRARY.find((s) => s.id === session.scenarioId);
  const scenario = libraryScenario ?? (body.scenario?.id === session.scenarioId ? body.scenario : undefined);
  if (!scenario) {
    return fail(400, "scenario_required", body.scenario
      ? "The scenario you sent doesn't match this session. Open the debrief in the browser where you created this scenario and try again."
      : "This session used a custom scenario that isn't saved on the server. Open the debrief in the browser where you created it and try again.");
  }

  const parsed = StoredTranscript.safeParse(session.transcript);
  if (!parsed.success) return fail(422, "invalid_transcript", "This session's saved transcript can't be read, so it can't be re-graded.");
  // Keep every turn, blanks included, so evidence line numbers match the transcript the debrief shows.
  const turns = parsed.data.map(({ role, text }) => ({ role, text }));
  if (!turns.some((t) => t.role === "user" && t.text.trim())) {
    return fail(400, "nothing_to_grade", "The rep didn't say anything on this call, so there's nothing to grade.");
  }
  // Long calls are graded on their opening turns and the note says so, the same way /api/evaluate-call grades them.
  const graded = gradable(turns);

  let evaluation: Evaluation;
  try {
    evaluation = await evaluateCall(scenario, graded);
  } catch (error) {
    console.error("[/api/transcripts/[id]] regrade error:", error);
    return fail(500, "Failed to evaluate call", "Grading failed on the server. Try again in a minute.");
  }
  // evaluateCall falls back to the rules-based grader when the model call fails; never replace a stored grade with that.
  if (evaluation.method !== "llm") {
    return fail(502, "llm_failed", "AI grading didn't work this time, so the grade wasn't changed. Try again in a minute, or run Check connection in Settings, Models.");
  }

  const note = gradedNote(evaluation.note, graded.length, turns.length);
  const stored: Evaluation = { ...evaluation, ...(note ? { note } : {}), evaluatedAt: new Date().toISOString() };
  const previous = session.evaluation as { method?: string; model?: string } | null;
  try {
    await prisma.$transaction([
      prisma.trainerSession.update({
        // The trainee passed canRegrade on the row as read before the model call. Their write lands only if the row is
        // unchanged since (Prisma throws P2025 otherwise), so re-grades sent at once can't all pass and replace each other's AI grade.
        where: managesOrg ? { id } : { id, updatedAt: session.updatedAt },
        data: {
          evaluation: stored as unknown as Prisma.InputJsonValue,
          overallScore: stored.overallScore,
          grade: stored.grade,
          goalAchieved: stored.goalAchievement.achieved,
        },
      }),
      prisma.auditEvent.create({
        data: {
          userId: auth.id,
          action: "session.regraded",
          resource: id,
          ip: clientIp(req),
          userAgent: req.headers.get("user-agent")?.slice(0, 300) ?? null,
          metadata: {
            trainee: session.userId,
            scenarioId: scenario.id,
            scenarioSource: libraryScenario ? "library" : "client",
            previousScore: session.overallScore,
            previousMethod: previous?.method ?? null,
            previousModel: previous?.model ?? null,
            overallScore: stored.overallScore,
            model: stored.model ?? null,
            graderVersion: stored.graderVersion ?? null,
          } satisfies Prisma.InputJsonValue,
        },
      }),
    ]);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // Usually the trainee's own re-grade from another tab saved first; then this one gets the answer a later request would.
      const current = await prisma.trainerSession.findUnique({ where: { id }, select: { evaluation: true } });
      if (isAiGrade(current?.evaluation)) return notAllowed();
      return fail(409, "conflict", "This call changed while it was being re-graded, so the new grade wasn't saved. Reload the page and try again.");
    }
    console.error("[/api/transcripts/[id]] regrade save error:", error);
    return fail(500, "Failed to save session", "The new grade couldn't be saved. Try again in a minute.");
  }
  return NextResponse.json({ id, evaluation: stored });
}
