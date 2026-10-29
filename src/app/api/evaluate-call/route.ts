import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { evaluateCall } from "@/lib/grader";
import { sealEvaluation } from "@/lib/gradeSeal";
import { gradable, gradedNote } from "@/lib/gradable";

const TurnSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string().min(1).max(8000),
  timestamp: z.string().optional(),
});

const Body = z.object({
  scenario: ScenarioSchema,
  transcript: z.array(TurnSchema).min(1).max(2000),
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
  const scenario = LIBRARY.find((s) => s.id === body.scenario.id) ?? body.scenario;
  // Long calls are graded on their opening turns and the note says so (same caps as the PATCH re-grade).
  const turns = gradable(body.transcript);

  try {
    const evaluation = await evaluateCall(scenario, turns);
    const note = gradedNote(evaluation.note, turns.length, body.transcript.length);
    const out = { evaluatedAt: new Date().toISOString(), ...evaluation, ...(note ? { note } : {}) };
    // The seal lets POST /api/transcripts store this score; a grade the client edits or invents won't verify.
    const seal = sealEvaluation({ userId: auth.id, scenarioId: scenario.id, transcript: body.transcript, evaluation: out });
    return NextResponse.json({ ...out, ...(seal ? { seal } : {}) });
  } catch (error) {
    console.error("[/api/evaluate-call] error:", error);
    return NextResponse.json({ error: "Failed to evaluate call", message: "Grading failed on the server. Try again in a minute." }, { status: 500 });
  }
}
