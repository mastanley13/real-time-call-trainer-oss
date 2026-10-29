import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { rateLimit, ipLimitResponse, readJsonLimited, MAX_TURNS, MAX_TRANSCRIPT_CHARS } from "@/lib/rateLimit";
import { ScenarioSchema } from "@/lib/scenarios";
import { CoachTurnSchema } from "@/lib/coach-types";
import { coachTurn, trailingWindow } from "@/lib/coach";

const Body = z.object({
  scenario: ScenarioSchema,
  // The client sends a trailing window of long calls; the body cap (readJsonLimited) bounds the rest.
  transcript: z.array(CoachTurnSchema).max(2000),
  /** Turns of the call before the first one sent, so line numbers in the result stay absolute. */
  lineOffset: z.number().int().min(0).max(100_000).default(0),
  allowCue: z.boolean(),
  recentCueKeys: z.array(z.string().max(80)).max(20).default([]),
});

/**
 * Live coach: called after each finished turn of a practice call. Returns a
 * CoachResult (running rubric estimate, talk-track steps, at most one cue and
 * its cueKey). Cues are for the rep only and are never sent to the persona.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "coach");
  if (ipLimited) return ipLimited;
  const limit = rateLimit({ key: `coach:${auth.id}`, limit: 60, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch (e) {
    return NextResponse.json(
      { error: "Invalid request body", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined },
      { status: 400 },
    );
  }

  // Over the limits, coach on the most recent turns instead of rejecting the call: a 400 here froze the rail for the rest of a long call.
  const win = trailingWindow(body.transcript, MAX_TURNS, MAX_TRANSCRIPT_CHARS);
  try {
    const result = await coachTurn(body.scenario, win.turns, { allowCue: body.allowCue, recentCueKeys: body.recentCueKeys, lineOffset: body.lineOffset + win.dropped });
    return NextResponse.json(result);
  } catch (error) {
    console.error("[/api/coach/turn] error:", error);
    return NextResponse.json({ error: "Failed to coach this turn" }, { status: 500 });
  }
}
