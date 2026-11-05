import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth, isDemoUser } from "@/lib/apiAuth";
import { rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { verifySeal } from "@/lib/gradeSeal";
import { isReceiptReplay, receiptRowId, verifyMintReceipt } from "@/lib/mintReceipt";
import { HAS_TRANSCRIPT } from "@/lib/usage";

const Body = z.object({
  sessionId: z.string().min(1).max(128),
  /** Id from /api/realtime/session or /api/elevenlabs/token. Fills that call's row instead of adding a second one. */
  callId: z.string().max(64).optional(),
  transcript: z.array(z.object({ role: z.enum(["user", "assistant", "system"]), text: z.string().max(8000), timestamp: z.string().max(40).optional() })).min(1).max(2000),
  durationSeconds: z.number().int().nonnegative().max(10 * 60 * 60).optional(),
  scenario: z.object({
    id: z.string().max(80),
    title: z.string().max(120).optional(),
    industry: z.string().max(80).optional(),
    difficulty: z.string().max(20).optional(),
  }),
  /** The grade from /api/evaluate-call, kept only when `seal` proves the server produced it for this call. */
  evaluation: z.record(z.unknown()).optional(),
  seal: z.string().max(128).optional(),
  /**
   * Encrypted receipt from /api/realtime/session. The logged model comes from inside a receipt that opens for
   * this user AND for `sessionId` (the call id the receipt was minted for), once per call. A model id sent by
   * the client is never read (unknown keys such as `realtimeModel` are stripped).
   */
  realtimeReceipt: z.string().max(512).optional(),
});

const GradeFields = z.object({
  overallScore: z.number().finite().min(0).max(100),
  grade: z.enum(["A", "B", "C", "D", "F"]),
  goalAchievement: z.object({ achieved: z.boolean() }).passthrough(),
}).passthrough();

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
    body = Body.parse(await readJsonLimited(req));
  } catch (e) {
    if (e instanceof Error && e.message === "too_large") {
      return NextResponse.json({ error: "payload_too_large", message: "This call is too long to save to the server. It was kept in this browser instead." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid request body", details: e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) : undefined }, { status: 400 });
  }

  const dbUser = await prisma.user.findUnique({ where: { id: auth.id } });
  if (!dbUser || !dbUser.organizationId) {
    return NextResponse.json({ error: "User or organization not found" }, { status: 404 });
  }

  // Scores feed team KPIs and assignment completion, so only a sealed server grade for exactly this
  // user, persona and transcript is stored. Anything else is saved ungraded; it can be re-graded later.
  const sealed = !!body.evaluation && verifySeal({ userId: dbUser.id, scenarioId: body.scenario.id, transcript: body.transcript, evaluation: body.evaluation }, body.seal);
  const grade = sealed ? GradeFields.safeParse(body.evaluation) : null;
  const ev = grade?.success ? grade.data : undefined;
  // Cost log only (not billing; engineTier is). A receipt counts only for the call it was minted for: it must name
  // exactly this sessionId, so a receipt from another call, or on a text save, logs nothing.
  const receiptModel = verifyMintReceipt(body.realtimeReceipt, dbUser.id, body.sessionId);
  let receiptLogged = false;
  try {
    // A metered voice call already has its row (created when the call started, empty transcript). Fill it so the
    // call has one row. durationSeconds is display only: billing never reads it, so a client cannot change what it is charged.
    const metered = body.callId ? await prisma.trainerSession.findUnique({ where: { id: body.callId }, select: { userId: true, transcript: true } }) : null;
    const fillExisting = !!body.callId && !!metered && metered.userId === dbUser.id && Array.isArray(metered.transcript) && metered.transcript.length === 0;
    const fields = {
      realtimeSessionId: body.sessionId,
      scenarioId: body.scenario.id,
      scenarioCategory: body.scenario.industry,
      scenarioDifficulty: body.scenario.difficulty,
      scenarioTitle: body.scenario.title,
      durationSeconds: body.durationSeconds ?? 0,
      transcript: body.transcript as unknown as Prisma.InputJsonValue,
      evaluation: ev ? (body.evaluation as Prisma.InputJsonValue) : Prisma.JsonNull,
      overallScore: ev ? Math.round(ev.overallScore) : null,
      grade: ev?.grade ?? null,
      goalAchieved: ev?.goalAchievement.achieved ?? null,
    };
    const owner = { userId: dbUser.id, organizationId: dbUser.organizationId };
    // Where a verified receipt may log its model. A metered call's receipt is bound to its metering call id, so the
    // model belongs on that call's own row (the one beginCall created) and nowhere else. An unmetered call has no
    // row yet, so it logs on the row whose primary key is receiptRowId(sessionId).
    const meteredReceiptRow = !receiptModel ? null
      : body.callId === body.sessionId ? metered
      : await prisma.trainerSession.findUnique({ where: { id: body.sessionId }, select: { userId: true } });
    let created: { id: string };
    if (fillExisting) {
      // The model is not part of the fill; it is set once, below, so a fill can never overwrite or repeat it.
      created = await prisma.trainerSession.update({ where: { id: body.callId }, data: fields });
    } else if (receiptModel && !meteredReceiptRow) {
      // Single use: the row's primary key comes from the receipt's call id, so a second save of the same
      // receipt is a unique violation. That save is kept, without a model.
      try {
        created = await prisma.trainerSession.create({ data: { id: receiptRowId(body.sessionId), ...owner, ...fields, realtimeModel: receiptModel } });
        receiptLogged = true;
      } catch (e) {
        if (!isReceiptReplay(e)) throw e;
        created = await prisma.trainerSession.create({ data: { ...owner, ...fields } });
      }
    } else {
      created = await prisma.trainerSession.create({ data: { ...owner, ...fields } });
    }
    if (receiptModel && meteredReceiptRow && meteredReceiptRow.userId === dbUser.id) {
      // Single use on the metered row: the model is written only while it is still unset, in one conditional
      // update, so a replayed or concurrent save of the same receipt changes nothing.
      const logged = await prisma.trainerSession.updateMany({ where: { id: body.sessionId, userId: dbUser.id, realtimeModel: null }, data: { realtimeModel: receiptModel } });
      receiptLogged = logged.count === 1;
    }
    await prisma.auditEvent.create({
      data: {
        userId: dbUser.id, action: "session.saved", resource: created.id,
        metadata: {
          scenarioId: body.scenario.id, overallScore: ev?.overallScore ?? null,
          ...(body.evaluation && !ev ? { gradeRejected: true } : {}),
          ...(body.realtimeReceipt && !receiptLogged ? { receiptRejected: true } : {}),
        },
      },
    });
    return NextResponse.json({ id: created.id, graded: !!ev });
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
    where: { userId: auth.id, ...HAS_TRANSCRIPT },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, scenarioId: true, scenarioTitle: true, scenarioCategory: true, durationSeconds: true, overallScore: true, grade: true, goalAchieved: true, createdAt: true, evaluation: true },
  });
  // Only expose the grader version, not the whole evaluation blob.
  const sessions = rows.map(({ evaluation, ...r }) => ({ ...r, graderVersion: (evaluation as { graderVersion?: string } | null)?.graderVersion ?? null, graderMethod: (evaluation as { method?: string } | null)?.method ?? null }));
  return NextResponse.json({ sessions });
}
