import { NextRequest, NextResponse } from "next/server";
import { cronAuthorized } from "@/lib/serverConfig";
import { enforceVoiceDeadlines } from "@/lib/voiceDeadlines";

/**
 * Every-minute sweep that hangs up OpenAI Realtime calls the server must end: past their deadline, ended with a
 * server reason, or silent. It settles the calls that are still open. The work is in `enforceVoiceDeadlines`.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET} only, the same as purge-expired (constant-time compare, the
 * x-vercel-cron header is not trusted, and without CRON_SECRET the route always 401s).
 *
 * Wire this up in vercel.json under "crons".
 */

const authorize = (req: NextRequest) => cronAuthorized(req.headers.get("authorization"), process.env.CRON_SECRET);

export async function GET(req: NextRequest) {
  if (!authorize(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  // No database (demo or no-database mode) means no metered calls and nothing to sweep.
  if (!process.env.DATABASE_URL) return NextResponse.json({ ok: true, skipped: true });
  try {
    return NextResponse.json({ ok: true, ...(await enforceVoiceDeadlines()) });
  } catch (error) {
    console.error("[cron/enforce-voice-deadlines] error:", error instanceof Error ? error.name : "unknown");
    return NextResponse.json({ ok: false, error: "Sweep failed" }, { status: 500 });
  }
}

// Allow POST too so it's easy to test from curl.
export const POST = GET;
