import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { isDemoUser, requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { clientIp, ipLimitResponse, rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { evaluateCall, gradingFailureCode } from "@/lib/grader";
import type { Evaluation } from "@/lib/grader-types";
import { canRegrade, gradable, gradedNote, isAiGrade, withoutModelId } from "@/lib/gradable";
import { getCapabilities, llmGradingModel, llmKey } from "@/lib/serverConfig";
import { getCompetitionEntryForSession } from "@/lib/competitionServer";
import { SESSION_VIEW_SELECT, sessionView } from "@/lib/sessionView";
import { notifyFirstGradedCall } from "@/lib/ghlWebhook";
import { hasCallRow, hasGradedSibling, isCallRow, lockCall } from "@/lib/callRow";
import { transcriptDigest } from "@/lib/gradeSeal";
import { hasGradedDuplicate, lockTranscript } from "@/lib/transcriptGrade";

/** Allow up to 60 s for reasoning-model re-grading on long 20-60 minute calls (matches llm.ts timeout). */
export const maxDuration = 60;

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

  // Allowlisted columns only, and an allowlisted response: realtimeModel, metering fields and future columns never leave.
  const session = await prisma.trainerSession.findUnique({ where: { id }, select: SESSION_VIEW_SELECT });
  if (!session) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!(await canAccess(auth.id, session))) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const competition = await getCompetitionEntryForSession(id, session.userId);
  return NextResponse.json({ session: { ...sessionView(session), ...(competition ? { competition } : {}) }, ...(competition ? { competition } : {}) });
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
 * The grade would give a call a second graded row (a legacy copy, src/lib/callRow.ts) or a transcript a second graded
 * row (src/lib/transcriptGrade.ts); answered like notAllowed.
 */
class SecondGrade extends Error {}

/**
 * Re-grade a stored session with the configured AI model and save the new grade. Managers/owners of the
 * session's org and platform admins can re-grade other members' library-persona calls (custom personas need
 * the scenario from the client). Whoever made the call, whatever their role, can re-grade it only while it
 * has no AI grade (canRegrade).
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
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
  // Team views and assignment completion read this score, so nobody re-rolls an AI grade on their own call (a manager,
  // owner or platform admin included); a manager or owner of the org, or a platform admin, can re-grade anyone else's.
  if (!canRegrade({ managesOrg, ownsSession }, session.evaluation)) return notAllowed();
  // One graded row per call (src/lib/callRow.ts), for everyone, platform admins included. Only the call's own row is
  // re-graded: a copy of the call (a replay, a fill that lost a race) gets the same refusal while the call has its own
  // row. A copy can never gain a grade, so this needs no lock. A legacy call (saved before call rows existed, so it has
  // only copies) keeps the old rules only while no other row of the call has a score, whatever this row's own score:
  // checked now, so no model call is spent, and again under the call's lock when the grade is written. The call's own
  // row is refused only when it has no score and a (pre-existing) copy does, since that would add a graded row.
  const callKey = session.realtimeSessionId;
  const legacyCopy = !!callKey && !isCallRow(id, callKey);
  if (legacyCopy && (await hasCallRow(prisma, session.userId, callKey))) return notAllowed();
  if (callKey && (legacyCopy || session.overallScore === null) && (await hasGradedSibling(prisma, session.userId, callKey, id))) return notAllowed();

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
  // One graded row per transcript (src/lib/transcriptGrade.ts), for everyone, platform admins included: a row with no
  // score is not graded while the trainee already has another graded row of the same transcript (same organization and
  // persona), such as the original of a copy saved under a new sessionId. Checked now, so no model call is spent, and
  // again under the transcript's lock when the grade is written. A row that already has a score keeps its re-grade
  // rules, since re-grading it adds no graded row.
  const addsGrade = session.overallScore === null;
  const digest = transcriptDigest(turns);
  const transcriptScope = { userId: session.userId, organizationId: session.organizationId, scenarioId: session.scenarioId, excludeId: id };
  if (addsGrade && (await hasGradedDuplicate(prisma, transcriptScope, digest))) return notAllowed();
  // Long calls are graded on their opening turns and the note says so, the same way /api/evaluate-call grades them.
  const graded = gradable(turns);

  let evaluation: Evaluation;
  try {
    evaluation = await evaluateCall(scenario, graded);
  } catch (error) {
    console.error("[/api/transcripts/[id]] regrade error:", gradingFailureCode(error));
    return fail(500, "Failed to evaluate call", "Grading failed on the server. Try again in a minute.");
  }
  // evaluateCall falls back to the rules-based grader when the model call fails; never replace a stored grade with that.
  if (evaluation.method !== "llm") {
    // The failure code is on the "[grader]" line and the provider status, type and code on "[llm] provider error".
    console.warn("[/api/transcripts/[id]] regrade: AI grading failed; stored grade unchanged");
    return fail(502, "llm_failed", "AI grading didn't work this time, so the grade wasn't changed. Try again in a minute, or run Check connection in Settings, Models.");
  }

  const note = gradedNote(evaluation.note, graded.length, turns.length);
  const stored: Evaluation = { ...withoutModelId(evaluation), ...(note ? { note } : {}), evaluatedAt: new Date().toISOString() };
  const previous = session.evaluation as { method?: string; model?: string } | null;
  const update = {
    // The grade is of the transcript as read before the model call, so it lands only if the row is unchanged since
    // (Prisma throws P2025 otherwise), for everyone. On your own call that also keeps re-grades sent at once from all
    // passing canRegrade and replacing each other's AI grade; for a manager or admin it keeps a save that replaced the
    // row's transcript and grade meanwhile (the receipt-row claim in POST /api/transcripts) from being overwritten by a
    // grade of the old transcript.
    where: { id, updatedAt: session.updatedAt },
    data: {
      evaluation: stored as unknown as Prisma.InputJsonValue,
      overallScore: stored.overallScore,
      grade: stored.grade,
      goalAchieved: stored.goalAchievement.achieved,
    },
  } satisfies Prisma.TrainerSessionUpdateArgs;
  const audit = {
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
        // Server-side audit only: the operator can still see which model graded, the browser never does.
        model: llmGradingModel(),
        graderVersion: stored.graderVersion ?? null,
      } satisfies Prisma.InputJsonValue,
    },
  } satisfies Prisma.AuditEventCreateArgs;
  /**
   * The grade write. When it adds a grade, it runs under the transcript's lock and only while the trainee still has no
   * other graded row of this transcript, so re-grades (or a re-grade and a save) of two copies run one after the other
   * and the second is refused. Lock order: the call's lock, when taken, comes first (transcriptGrade.ts).
   */
  const write = async (tx: Prisma.TransactionClient) => {
    if (addsGrade) {
      await lockTranscript(tx, session.userId, digest);
      if (await hasGradedDuplicate(tx, transcriptScope, digest)) throw new SecondGrade();
    }
    await tx.trainerSession.update(update);
    await tx.auditEvent.create(audit);
  };
  try {
    if (legacyCopy && callKey) {
      // A legacy copy: under the call's lock, the call still has no own row (a save never adds one to a legacy call) and
      // no other row of the call has a score. Re-grades of two copies, or a re-grade and a save, run one after the
      // other, so the second sees the first's committed grade and nothing in it commits.
      await prisma.$transaction(async (tx) => {
        await lockCall(tx, session.userId, callKey);
        if (await hasCallRow(tx, session.userId, callKey)) throw new SecondGrade();
        if (await hasGradedSibling(tx, session.userId, callKey, id)) throw new SecondGrade();
        await write(tx);
      });
    } else if (addsGrade) {
      await prisma.$transaction(write);
    } else {
      await prisma.$transaction([prisma.trainerSession.update(update), prisma.auditEvent.create(audit)]);
    }
  } catch (error) {
    if (error instanceof SecondGrade) return notAllowed();
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      // On your own call, usually your re-grade from another tab saved first; then this one gets the answer a later
      // request would. A manager or admin re-grading someone else's call is told to reload (canRegrade allows them).
      const current = await prisma.trainerSession.findUnique({ where: { id }, select: { evaluation: true } });
      if (ownsSession && isAiGrade(current?.evaluation)) return notAllowed();
      return fail(409, "conflict", "This call changed while it was being re-graded, so the new grade wasn't saved. Reload the page and try again.");
    }
    console.error("[/api/transcripts/[id]] regrade save error:", error);
    return fail(500, "Failed to save session", "The new grade couldn't be saved. Try again in a minute.");
  }
  // Activation for the CRM: a call that had no score and now has one may be the trainee's first graded call. Scheduled
  // first thing after the grade transaction committed (the catch above runs only when nothing committed), with nothing
  // after it that could throw. notifyFirstGradedCall decides in the background, under its own lock and marker; it never
  // delays this response.
  if (session.overallScore === null) notifyFirstGradedCall(session.userId);
  return NextResponse.json({ id, evaluation: stored });
}
