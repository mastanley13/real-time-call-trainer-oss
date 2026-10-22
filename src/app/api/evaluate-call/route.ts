import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited, MAX_TURNS, MAX_TRANSCRIPT_CHARS } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { evaluateCall } from "@/lib/grader";

const TurnSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text: z.string().min(1).max(8000),
  timestamp: z.string().optional(),
});

const Body = z.object({
  scenario: ScenarioSchema,
  transcript: z.array(TurnSchema).min(1).max(MAX_TURNS),
}).refine((b) => b.transcript.reduce((n, t) => n + t.text.length, 0) <= MAX_TRANSCRIPT_CHARS, { message: "transcript too long" });

export async function POST(request: NextRequest) {
  const auth = requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(request, "grading");
  if (ipLimited) return ipLimited;
  const limit = rateLimit({ key: `evaluate:${auth.id}`, limit: 10, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(request));
  } catch (e) {
    return NextResponse.json({ error: "Invalid request body", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined }, { status: 400 });
  }

  try {
    const evaluation = await evaluateCall(body.scenario, body.transcript);
    return NextResponse.json({ evaluatedAt: new Date().toISOString(), ...evaluation });
  } catch (error) {
    console.error("[/api/evaluate-call] error:", error);
    return NextResponse.json({ error: "Failed to evaluate call" }, { status: 500 });
  }
}
