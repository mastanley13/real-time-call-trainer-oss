import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { COMPETITION_TRACK_SLUGS, competitionTrackBySlug } from "@/lib/competition";
import { LIBRARY } from "@/lib/personas";
import { evaluateCall, gradingFailureCode } from "@/lib/grader";
import { sealEvaluation } from "@/lib/gradeSeal";
import { gradable, gradedNote } from "@/lib/gradable";

/** Allow up to 60 s for reasoning-model grading on long 20-60 minute calls (matches llm.ts timeout). */
export const maxDuration = 60;

const TurnSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string().min(1).max(8000),
  timestamp: z.string().optional(),
});

const Body = z.object({
  scenario: ScenarioSchema,
  competitionTrack: z.enum(COMPETITION_TRACK_SLUGS).optional(),
  transcript: z.array(TurnSchema).min(1).max(2000),
  /**
   * The id the client will save this call under (POST /api/transcripts `sessionId`). The seal is bound to it, so the
   * grade can be stored only with that call. Without it the grade is still returned, unsealed, and saves ungraded
   * (the debrief's browser-only re-grade sends none: it never saves to the server). The save keys a graded row on this
   * id, so it is limited to the characters server-made and client-made call ids use.
   */
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),
  /** A metered voice call's metering id (the save's `callId`), sealed with the sessionId. Same characters, save's length cap. */
  callId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
});

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(request, "grading");
  if (ipLimited) return ipLimited;
  const limit = rateLimit({ key: `evaluate:${auth.id}`, limit: 10, windowMs: 60_000 });
  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(limit.retryAfterMs / 1000));
    return NextResponse.json(
      { error: "Rate limit exceeded", message: `You've graded 10 calls in the last minute. Wait ${retryAfter} seconds and try again.`, retryAfter },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(request));
  } catch (e) {
    if (e instanceof Error && e.message === "too_large") {
      return NextResponse.json({ error: "payload_too_large", message: "This call is too long to grade in one request. Grade a shorter call." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid request body", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined }, { status: 400 });
  }

  // Library personas are graded on the server's own copy, so a client can't loosen the rubric (same rule as the PATCH re-grade).
  const canonicalId = body.competitionTrack ? competitionTrackBySlug(body.competitionTrack)?.scenarioId : body.scenario.id;
  const canonical = LIBRARY.find((s) => s.id === canonicalId);
  if (body.competitionTrack && !canonical) return NextResponse.json({ error: "invalid_scenario", message: "That competition track is unavailable." }, { status: 400 });
  const scenario = canonical ?? body.scenario;
  // Long calls are graded on their opening turns and the note says so (same caps as the PATCH re-grade).
  const turns = gradable(body.transcript);

  try {
    const evaluation = await evaluateCall(scenario, turns);
    // The failure code is on the "[grader]" line and the provider status, type and code on "[llm] provider error".
    if (evaluation.llmFailed) console.warn("[/api/evaluate-call] AI grading failed; returned the rules-based estimate");
    const note = gradedNote(evaluation.note, turns.length, body.transcript.length);
    const out = { evaluatedAt: new Date().toISOString(), ...evaluation, ...(note ? { note } : {}) };
    // The seal lets POST /api/transcripts store this score once, for this call (sessionId and callId), within
    // GRADE_SEAL_MAX_AGE_MS of evaluatedAt; a grade the client edits or invents won't verify. Nothing is stored here, so
    // the CRM activation event (first graded call) is sent by that save, not by this route.
    const seal = body.sessionId
      ? sealEvaluation({ userId: auth.id, sessionId: body.sessionId, callId: body.callId, scenarioId: scenario.id, transcript: body.transcript, evaluation: out })
      : undefined;
    return NextResponse.json({ ...out, ...(seal ? { seal } : {}) });
  } catch (error) {
    console.error("[/api/evaluate-call] error:", gradingFailureCode(error));
    return NextResponse.json({ error: "Failed to evaluate call", message: "Grading failed on the server. Try again in a minute." }, { status: 500 });
  }
}
