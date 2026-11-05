import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { rateLimit } from "@/lib/rateLimit";
import { VOICE_USED_SELECT, voiceUsedView } from "@/lib/sessionView";
import { tierOfModel } from "@/lib/voiceTierServer";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/transcripts/[id]/voice -> { voiceUsed: "premium" | "standard" | null }
 *
 * The debrief's "voice used" label. Same access rule as GET /api/transcripts/[id]: the trainee who owns the session,
 * a manager or owner of its organization, or a platform admin. Read-only and cheap, so a per-user limit only.
 * It reads the server-only columns it needs (engineTier, realtimeModel, allowanceId) and answers with one tier label:
 * never a model id, never the columns. Text calls answer null.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  const limit = rateLimit({ key: `transcript-voice:${auth.id}`, limit: 60, windowMs: 60_000 });
  if (!limit.allowed) return NextResponse.json({ error: "rate_limited", message: "Too many requests. Wait a minute, then try again." }, { status: 429, headers: { "Retry-After": "60" } });

  const { id } = await params;
  if (typeof id !== "string" || id.length > 128) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const row = await prisma.trainerSession.findUnique({ where: { id }, select: VOICE_USED_SELECT });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (row.userId !== auth.id) {
    const actor = await prisma.user.findUnique({ where: { id: auth.id } });
    const manages = !!actor && (actor.isPlatformAdmin || ((actor.role === "manager" || actor.role === "owner") && actor.organizationId === row.organizationId));
    if (!manages) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ voiceUsed: voiceUsedView(row, tierOfModel) }, { headers: { "Cache-Control": "no-store" } });
}
