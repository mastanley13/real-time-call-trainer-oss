import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { requireAuth, isDemoUser } from "@/lib/apiAuth";
import { rateLimit, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { verifySeal } from "@/lib/gradeSeal";
import { hasGradedSibling, lockCallGrade } from "@/lib/callGrade";
import { isReceiptReplay, receiptRowId, verifyMintReceipt } from "@/lib/mintReceipt";
import { HAS_TRANSCRIPT } from "@/lib/usage";
import { tierOfModel } from "@/lib/voiceTierServer";
import { sessionListItem } from "@/lib/sessionView";
import { notifyFirstGradedCall } from "@/lib/ghlWebhook";

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

  // Scores feed team KPIs and assignment completion, so only a sealed server grade for exactly this user, this call
  // (sessionId), persona and transcript, graded within GRADE_SEAL_MAX_AGE_MS, may be stored, and only once (see
  // "Single use" below). Anything else is saved ungraded; it can be re-graded later.
  const sealed = !!body.evaluation && verifySeal({ userId: dbUser.id, sessionId: body.sessionId, scenarioId: body.scenario.id, transcript: body.transcript, evaluation: body.evaluation }, body.seal);
  const grade = sealed ? GradeFields.safeParse(body.evaluation) : null;
  /** A verified grade this save may store. Whether it is stored is `graded`, decided by the single-use write below. */
  const ev = grade?.success ? grade.data : undefined;
  let graded = false;
  // Cost log only (not billing; engineTier is). A receipt counts only for the call it was minted for: it must name
  // exactly this sessionId, so a receipt from another call, or on a text save, logs nothing.
  const receiptModel = verifyMintReceipt(body.realtimeReceipt, dbUser.id, body.sessionId);
  let receiptLogged = false;
  try {
    // A metered voice call already has its row (created when the call started, empty transcript). Fill it so the
    // call has one row. durationSeconds is display only: billing never reads it, so a client cannot change what it is charged.
    // realtimeModel is read only to tell whether the mint already logged this call (src/lib/voiceMintLog.ts); it is
    // never returned.
    const metered = body.callId ? await prisma.trainerSession.findUnique({ where: { id: body.callId }, select: { userId: true, transcript: true, realtimeModel: true } }) : null;
    const fillExisting = !!body.callId && !!metered && metered.userId === dbUser.id && Array.isArray(metered.transcript) && metered.transcript.length === 0;
    /** The row's fields, with the verified grade only on the one write that claims it. */
    const fieldsFor = (withGrade: boolean) => {
      const g = withGrade ? ev : undefined;
      return {
        realtimeSessionId: body.sessionId,
        scenarioId: body.scenario.id,
        scenarioCategory: body.scenario.industry,
        scenarioDifficulty: body.scenario.difficulty,
        scenarioTitle: body.scenario.title,
        durationSeconds: body.durationSeconds ?? 0,
        transcript: body.transcript as unknown as Prisma.InputJsonValue,
        evaluation: g ? (body.evaluation as Prisma.InputJsonValue) : Prisma.JsonNull,
        overallScore: g ? Math.round(g.overallScore) : null,
        grade: g?.grade ?? null,
        goalAchieved: g?.goalAchievement.achieved ?? null,
      };
    };
    const owner = { userId: dbUser.id, organizationId: dbUser.organizationId };
    // A row created here is an unmetered save (text, or a voice call with no metering row): it is over the moment it
    // is saved, so endedAt is set and it can never look like an open call to the metering code (settleStale). No
    // voice metering field (allowanceId, connectedAt, heartbeats, billing) is ever written on it.
    const unmetered = { ...owner, endedAt: new Date() };
    // The row whose primary key is this save's sessionId, if any. A metered voice call's sessionId is its metering call
    // id, so for a metered call this is the row beginCall created at mint, before any grade or receipt for it existed.
    // Read only when a verified receipt or grade needs to know where it may land.
    const sessionRow = !receiptModel && !ev ? null
      : body.callId === body.sessionId ? metered
      : await prisma.trainerSession.findUnique({ where: { id: body.sessionId }, select: { userId: true } });
    // Where a verified receipt may log its model. A metered call's receipt is bound to its metering call id, so the
    // model belongs on that call's own row (the one beginCall created) and nowhere else. An unmetered call has no
    // row yet, so it logs on the row whose primary key is receiptRowId(sessionId).
    const meteredReceiptRow = receiptModel ? sessionRow : null;
    // Single use of a grade seal: at most one graded row per seal, also under concurrent saves. The seal is bound to
    // sessionId (gradeSeal.ts), so every graded write below is keyed on sessionId, which makes it one graded row per
    // call and so one per seal, without a schema change. Every claim is one conditional write that the database
    // applies atomically, so of two saves racing for the same claim exactly one wins:
    // - Metered call (a row with id = sessionId exists): the grade may land only on that row, by the fill. A seal for
    //   this sessionId is only ever accepted on the row whose id is sessionId, so it can never land on another row.
    // - Unmetered call (no such row): the grade lands on the row whose primary key is receiptRowId(sessionId), the same
    //   deterministic key the mint receipt claims, so a receipt and a grade for one call share one row. A key made from
    //   the seal string could not share that row with the receipt, and a replay without the receipt would then land a
    //   second graded row.
    // The row ids a seal can claim never collide across users in practice: voice ids are server-made, and the client
    // makes text ids with 96 random bits (sessionStore.ts callSessionId).
    let created: { id: string } | null = null;
    let filledOwnRow = false;
    // Every write below that may store a grade runs here: under the call's grade lock, and with the grade only when no
    // other row of this call (same user and realtimeSessionId = sessionId) already has a score. The same lock and check
    // guard the PATCH re-grade, so a grade saved here and a re-grade of a sibling row can't both land (src/lib/callGrade.ts).
    const writeGrade = <T,>(rowId: string, write: (tx: Prisma.TransactionClient, mayGrade: boolean) => Promise<T>) =>
      prisma.$transaction(async (tx) => {
        await lockCallGrade(tx, dbUser.id, body.sessionId);
        return write(tx, !(await hasGradedSibling(tx, dbUser.id, body.sessionId, rowId)));
      });
    if (fillExisting) {
      // The fill, graded or not, is one conditional update that lands only while the row is still unfilled.
      // "Unfilled" is realtimeSessionId = null: beginCall (src/lib/usage.ts) never sets it, every fill sets it to the
      // save's sessionId (required, at least one character), and nothing else writes it. It is a plain scalar column,
      // so the condition is exact in Postgres (unlike a JSON comparison on the transcript). Two saves that both read the
      // empty row can't both fill it: the second finds realtimeSessionId set and changes nothing, so an ungraded fill
      // can never erase a grade another save just stored, and a grade lands on this row at most once, ever.
      // A seal for another call id (sessionId differs from callId) never lands here. The model is not part of the fill;
      // it is set once, below. No metering field (endedAt, billing, heartbeats) is written, so settleStale and billing
      // see the row exactly as before.
      const callId = body.callId!;
      const fill = (tx: Prisma.TransactionClient, withGrade: boolean) =>
        tx.trainerSession.updateMany({ where: { id: callId, userId: dbUser.id, realtimeSessionId: null }, data: fieldsFor(withGrade) }).then((r) => ({ filled: r.count === 1, withGrade }));
      const result = ev && callId === body.sessionId ? await writeGrade(callId, fill) : await fill(prisma, false);
      if (result.filled) {
        created = { id: callId };
        filledOwnRow = true;
        graded = result.withGrade;
      }
      // Otherwise another save of this call filled it first: this one becomes a separate ungraded row below, as any save
      // that doesn't fill the call's row always has.
    } else if ((receiptModel || ev) && !sessionRow) {
      const rowId = receiptRowId(body.sessionId);
      try {
        // Unmetered calls have no row at mint, so the tier is stored here, mapped from the sealed model on the server
        // when the save lands (within the receipt's lifetime) and never recomputed later.
        // A P2002 inside writeGrade rolls its transaction back and surfaces here unchanged.
        const insert = (tx: Prisma.TransactionClient, withGrade: boolean) =>
          tx.trainerSession.create({
            data: { id: rowId, ...unmetered, ...fieldsFor(withGrade), ...(receiptModel ? { realtimeModel: receiptModel, voiceTier: tierOfModel(receiptModel) } : {}) },
          }).then((row) => ({ row, withGrade }));
        const result = ev ? await writeGrade(rowId, insert) : await insert(prisma, false);
        created = result.row;
        receiptLogged = !!receiptModel;
        graded = result.withGrade;
      } catch (e) {
        if (!isReceiptReplay(e)) throw e;
        // The call's row already exists (P2002 means the other insert committed). It may hold only the receipt's model
        // (a receipt-only save, or one whose grade didn't verify) or only a grade (a graded save without the receipt).
        // Each may still claim what the row lacks, once, by a conditional update on that column:
        // - grade: lands only while the row has no score (overallScore = null). Every stored grade sets overallScore
        //   (GradeFields requires it), so a second grade for this call, a replay or a race loser, changes nothing.
        //   The save's own fields (with the sealed transcript) go with it, so the row holds what was graded.
        // - model: lands only while the row has none (realtimeModel = null), the same rule as the metered row below,
        //   so a receipt is still logged on exactly one row, once.
        // Only rows of this user are touched. Ungraded text saves never claim this row (they have no receipt and no
        // grade), so they can't block a later grade either.
        if (ev) {
          const claimed = await writeGrade(rowId, async (tx, mayGrade) =>
            mayGrade ? (await tx.trainerSession.updateMany({ where: { id: rowId, userId: dbUser.id, overallScore: null }, data: fieldsFor(true) })).count : 0);
          if (claimed === 1) {
            created = { id: rowId };
            graded = true;
          }
        }
        if (receiptModel) {
          const logged = await prisma.trainerSession.updateMany({ where: { id: rowId, userId: dbUser.id, realtimeModel: null }, data: { realtimeModel: receiptModel, voiceTier: tierOfModel(receiptModel) } });
          receiptLogged = logged.count === 1;
        }
      }
    }
    // Everything else: an ungraded row of its own. That covers a grade whose call already has a row it did not land on
    // (a replay, or a seal for a metered call saved without its callId), and a fill that lost the race. Such a row keeps
    // realtimeSessionId = sessionId, so the PATCH re-grade's sibling check refuses to grade it while the call has a score.
    if (!created) created = await prisma.trainerSession.create({ data: { ...unmetered, ...fieldsFor(false) } });
    // Activation for the CRM: only a stored sealed grade counts. Scheduled as soon as the graded row is written, so a
    // failure in the receipt or audit step below cannot skip it. notifyFirstGradedCall decides in the background, under
    // its own lock and durable marker, whether the user's first graded call has been announced yet; it never delays this response.
    if (graded) notifyFirstGradedCall(dbUser.id);
    if (receiptModel && meteredReceiptRow && meteredReceiptRow.userId === dbUser.id) {
      // Single use on the metered row: the model is written only while it is still unset, in one conditional
      // update, so a replayed or concurrent save of the same receipt changes nothing.
      const logged = await prisma.trainerSession.updateMany({ where: { id: body.sessionId, userId: dbUser.id, realtimeModel: null }, data: { realtimeModel: receiptModel } });
      // The mint usually logged this call's model already. The save that fills the call's own row with a receipt for
      // that same model is the receipt's one use; any later save (a replay, a save without callId) is not.
      receiptLogged = logged.count === 1 || (filledOwnRow && body.callId === body.sessionId && metered?.realtimeModel === receiptModel);
    }
    await prisma.auditEvent.create({
      data: {
        userId: dbUser.id, action: "session.saved", resource: created.id,
        metadata: {
          scenarioId: body.scenario.id, overallScore: graded ? ev?.overallScore ?? null : null,
          ...(body.evaluation && !graded ? { gradeRejected: true } : {}),
          ...(body.realtimeReceipt && !receiptLogged ? { receiptRejected: true } : {}),
        },
      },
    });
    return NextResponse.json({ id: created.id, graded });
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
    select: { id: true, scenarioId: true, scenarioTitle: true, scenarioCategory: true, durationSeconds: true, overallScore: true, grade: true, goalAchieved: true, createdAt: true, evaluation: true, voiceTier: true },
  });
  // An explicit allowlist per entry (sessionListItem): grader version and method, and the neutral voice label only.
  const sessions = rows.map(sessionListItem);
  return NextResponse.json({ sessions });
}
