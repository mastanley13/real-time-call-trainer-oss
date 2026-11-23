import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// SAL-1049: a grade seal is bound to one call, expires, and stores at most one graded row. Only the database, the session
// check and the CRM notify are replaced; the seal, the receipt and both routes run for real.
const mocks = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>,
  authId: "u-1",
  notify: vi.fn(),
  /** When set, the grader returns this AI grade (the PATCH re-grade's model call) after `gate` resolves. */
  ai: null as null | { overallScore: number },
  gate: Promise.resolve(),
  aiCalls: 0,
}));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));
vi.mock("@/lib/ghlWebhook", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ghlWebhook")>()), notifyFirstGradedCall: mocks.notify }));
vi.mock("@/lib/grader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/grader")>();
  return {
    ...actual,
    evaluateCall: async (...args: Parameters<typeof actual.evaluateCall>) => {
      if (!mocks.ai) return actual.evaluateCall(...args);
      mocks.aiCalls += 1;
      await mocks.gate;
      return { method: "llm", graderVersion: "llm-test", overallScore: mocks.ai.overallScore, grade: "B", goalAchievement: { achieved: true }, criteria: [] } as unknown as Awaited<ReturnType<typeof actual.evaluateCall>>;
    },
  };
});

import { GRADE_SEAL_MAX_AGE_MS, sealEvaluation, stableStringify, transcriptDigest } from "@/lib/gradeSeal";
import { receiptRowId, sealMintReceipt } from "@/lib/mintReceipt";
import { GRADED_DUPLICATE_SCAN, hasGradedDuplicate, storedTranscriptDigest } from "@/lib/transcriptGrade";
import { PREMIUM_REALTIME_MODEL } from "@/lib/voiceModels";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { splitSeal } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { PATCH as regradePATCH } from "@/app/api/transcripts/[id]/route";
import { POST as evaluateCall } from "@/app/api/evaluate-call/route";

const KEY = "test-jwt-secret-that-is-long-enough-0123456789";
const scenario = BUILT_IN_SCENARIOS[0];
const transcript = [
  { role: "assistant" as const, text: "Hi, my water heater died this morning." },
  { role: "user" as const, text: "Sorry to hear that. When did it stop, and is it leaking?" },
];
const T0 = new Date("2026-11-22T12:00:00.000Z");

let fake: ReturnType<typeof createFakePrisma>;
let n = 0;
let userId: string;

/** A server grade for this user and call, sealed the way /api/evaluate-call seals it. */
function sealedGrade(sessionId: string, opts: { evaluatedAt?: string; score?: number; forUser?: string; callId?: string } = {}) {
  const evaluation = { method: "heuristic", graderVersion: "heuristic-v2", overallScore: opts.score ?? 62, grade: "C", goalAchievement: { achieved: false }, evaluatedAt: opts.evaluatedAt ?? new Date().toISOString() };
  const seal = sealEvaluation({ userId: opts.forUser ?? userId, sessionId, callId: opts.callId, scenarioId: scenario.id, transcript, evaluation }, KEY)!;
  return { evaluation, seal };
}
const save = (body: Record<string, unknown>) =>
  saveTranscript(new NextRequest("http://localhost/api/transcripts", {
    method: "POST",
    body: JSON.stringify({ transcript, durationSeconds: 60, scenario: { id: scenario.id, title: scenario.title }, ...body }),
    headers: { "content-type": "application/json" },
  }));
const sessions = () => fake.rows("trainerSession");
const gradedRows = () => sessions().filter((s) => s.overallScore != null);
const audits = () => fake.rows("auditEvent").filter((a) => a.action === "session.saved");
const textId = () => `text-${T0.getTime()}-${(++n).toString(16).padStart(24, "0")}`;

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.notify.mockReset();
  mocks.ai = null;
  mocks.gate = Promise.resolve();
  mocks.aiCalls = 0;
  // A fresh user per test, so the per-account save limit never carries over.
  userId = mocks.authId = `u-seal-${++n}`;
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123" });
  fake.seed("user", { id: userId, email: `${userId}@example.test`, organizationId: "org-1" });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("POST /api/transcripts: a seal stores one graded row, for its own call, while fresh", () => {
  it("stores a fresh sealed grade once; the same seal saved again is stored ungraded", async () => {
    const sessionId = textId();
    const grade = sealedGrade(sessionId);
    const first = await save({ sessionId, ...grade });
    expect(await first.json()).toEqual({ id: receiptRowId(sessionId), graded: true });
    const again = await save({ sessionId, ...grade });
    const body = await again.json();
    expect(body).toEqual({ id: expect.any(String), graded: false });
    expect(body.id).not.toBe(receiptRowId(sessionId));
    expect(gradedRows()).toHaveLength(1);
    expect(sessions()).toHaveLength(2);
    expect(sessions().find((s) => s.id === body.id)).toMatchObject({ overallScore: null, grade: null, goalAchieved: null });
    // The CRM activation is scheduled for the stored grade only, and the audit row marks the replay.
    expect(mocks.notify).toHaveBeenCalledTimes(1);
    expect(audits().map((a) => a.metadata)).toEqual([
      { scenarioId: scenario.id, overallScore: 62 },
      { scenarioId: scenario.id, overallScore: null, gradeRejected: true },
    ]);
  });

  it("stores one graded row when the same seal is saved several times at once", async () => {
    const sessionId = textId();
    const grade = sealedGrade(sessionId);
    const results = await Promise.all([save({ sessionId, ...grade }), save({ sessionId, ...grade }), save({ sessionId, ...grade })]);
    const bodies = await Promise.all(results.map((r) => r.json()));
    expect(bodies.map((b) => b.graded).sort()).toEqual([false, false, true]);
    expect(gradedRows()).toHaveLength(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("stores a seal made for session A, saved under session B, ungraded", async () => {
    const a = textId();
    const b = textId();
    const res = await save({ sessionId: b, ...sealedGrade(a) });
    expect(await res.json()).toEqual({ id: expect.any(String), graded: false });
    expect(gradedRows()).toHaveLength(0);
    expect(audits()[0].metadata).toMatchObject({ gradeRejected: true });
    expect(mocks.notify).not.toHaveBeenCalled();
    // Another user's seal for the same call id doesn't verify either.
    expect((await (await save({ sessionId: a, ...sealedGrade(a, { forUser: "someone-else" }) })).json()).graded).toBe(false);
  });

  it("stores a grade older than 30 minutes, from the future, or without evaluatedAt ungraded, and a fresh one graded", async () => {
    const ago = (ms: number) => new Date(T0.getTime() - ms).toISOString();
    for (const evaluatedAt of [ago(GRADE_SEAL_MAX_AGE_MS + 1_000), ago(31 * 60_000), ago(-5 * 60_000), "not a date"]) {
      const sessionId = textId();
      expect((await (await save({ sessionId, ...sealedGrade(sessionId, { evaluatedAt }) })).json()).graded).toBe(false);
    }
    const missing = textId();
    const { evaluation } = sealedGrade(missing);
    const noTime = { ...evaluation, evaluatedAt: undefined };
    const noTimeSeal = sealEvaluation({ userId, sessionId: missing, scenarioId: scenario.id, transcript, evaluation: noTime }, KEY);
    expect((await (await save({ sessionId: missing, evaluation: noTime, seal: noTimeSeal })).json()).graded).toBe(false);
    expect(gradedRows()).toHaveLength(0);

    const fresh = textId();
    expect((await (await save({ sessionId: fresh, ...sealedGrade(fresh, { evaluatedAt: ago(29 * 60_000) }) })).json()).graded).toBe(true);
    expect(gradedRows()).toHaveLength(1);
  });

  it("stores a grade with a v1 seal (no sessionId bound) ungraded", async () => {
    const sessionId = textId();
    const { evaluation } = sealedGrade(sessionId);
    const v1 = createHmac("sha256", KEY)
      .update(stableStringify({ v: "grade-seal-v1", u: userId, s: scenario.id, t: transcriptDigest(transcript), e: evaluation }))
      .digest("hex");
    expect(await (await save({ sessionId, evaluation, seal: v1 })).json()).toEqual({ id: expect.any(String), graded: false });
    expect(gradedRows()).toHaveLength(0);
  });

  it("keeps one graded row per call across the receipt path: grade and model claim the same row", async () => {
    const sessionId = "uuid-0000-0000-0001";
    const receipt = sealMintReceipt(userId, sessionId, PREMIUM_REALTIME_MODEL)!;
    const grade = sealedGrade(sessionId);
    expect(await (await save({ sessionId, ...grade, realtimeReceipt: receipt })).json()).toEqual({ id: receiptRowId(sessionId), graded: true });
    expect(sessions()[0]).toMatchObject({ id: receiptRowId(sessionId), realtimeModel: PREMIUM_REALTIME_MODEL, overallScore: 62 });
    // The same seal without the receipt, and the same receipt again, both land ungraded and without a model.
    expect((await (await save({ sessionId, ...grade })).json()).graded).toBe(false);
    expect((await (await save({ sessionId, ...grade, realtimeReceipt: receipt })).json()).graded).toBe(false);
    expect(gradedRows()).toHaveLength(1);
    expect(sessions().filter((s) => s.realtimeModel != null)).toHaveLength(1);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("refuses a seal replayed with a receipt after it was stored without one; the unused receipt still logs once", async () => {
    const sessionId = "uuid-0000-0000-0002";
    const grade = sealedGrade(sessionId);
    const receipt = sealMintReceipt(userId, sessionId, PREMIUM_REALTIME_MODEL)!;
    expect((await (await save({ sessionId, ...grade })).json()).graded).toBe(true);
    const res = await save({ sessionId, ...grade, realtimeReceipt: receipt });
    expect((await res.json()).graded).toBe(false);
    expect(gradedRows()).toHaveLength(1);
    // The receipt had not been used, so it claims the call's row's empty model slot; the grade is not stored again.
    expect(sessions().find((s) => s.id === receiptRowId(sessionId))).toMatchObject({ realtimeModel: PREMIUM_REALTIME_MODEL, overallScore: 62 });
    expect(audits()[1].metadata).toEqual({ scenarioId: scenario.id, overallScore: null, gradeRejected: true });
    // A third save with the same receipt logs nothing more.
    await save({ sessionId, realtimeReceipt: receipt });
    expect(sessions().filter((s) => s.realtimeModel != null)).toHaveLength(1);
    expect(audits()[2].metadata).toMatchObject({ receiptRejected: true });
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  describe("unmetered voice call whose row a receipt-only save claimed first", () => {
    const SID = "uuid-0000-0000-0003";
    const receipt = () => sealMintReceipt(userId, SID, PREMIUM_REALTIME_MODEL)!;

    it("lets a later fresh sealed grade claim that row once", async () => {
      expect(await (await save({ sessionId: SID, realtimeReceipt: receipt() })).json()).toEqual({ id: receiptRowId(SID), graded: false });
      const grade = sealedGrade(SID);
      expect(await (await save({ sessionId: SID, ...grade })).json()).toEqual({ id: receiptRowId(SID), graded: true });
      expect(sessions()).toHaveLength(1);
      expect(sessions()[0]).toMatchObject({ id: receiptRowId(SID), realtimeModel: PREMIUM_REALTIME_MODEL, overallScore: 62, transcript, endedAt: expect.any(Date) });
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      // The same seal, or another fresh seal for the call, doesn't grade it again.
      expect((await (await save({ sessionId: SID, ...grade })).json()).graded).toBe(false);
      expect((await (await save({ sessionId: SID, ...sealedGrade(SID, { score: 99 }) })).json()).graded).toBe(false);
      expect(gradedRows()).toHaveLength(1);
      expect(sessions()[0].overallScore).toBe(62);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it("lets the grade claim the row after a receipt save whose grade didn't verify", async () => {
      const { evaluation } = sealedGrade(SID);
      expect((await (await save({ sessionId: SID, realtimeReceipt: receipt(), evaluation: { ...evaluation, overallScore: 100 }, seal: sealedGrade(SID).seal })).json()).graded).toBe(false);
      expect(await (await save({ sessionId: SID, ...sealedGrade(SID) })).json()).toEqual({ id: receiptRowId(SID), graded: true });
      expect(gradedRows()).toHaveLength(1);
    });

    it("stores one graded row and one model whichever of the receipt-only and graded saves lands first", async () => {
      const grade = sealedGrade(SID);
      const bodies = await Promise.all([save({ sessionId: SID, realtimeReceipt: receipt() }), save({ sessionId: SID, ...grade }), save({ sessionId: SID, ...grade })].map(async (p) => (await p).json()));
      expect(bodies.filter((b) => b.graded)).toEqual([{ id: receiptRowId(SID), graded: true }]);
      expect(gradedRows()).toHaveLength(1);
      expect(sessions().find((s) => s.id === receiptRowId(SID))).toMatchObject({ realtimeModel: PREMIUM_REALTIME_MODEL, overallScore: 62 });
      expect(sessions().filter((s) => s.realtimeModel != null)).toHaveLength(1);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it("stores the grade when the receipt-only save commits between the graded save's read and its insert", async () => {
      // The graded save reads where the call's row is (no row has id = sessionId); just after, before it takes the call's
      // lock and inserts, the receipt-only save inserts the call's row. The insert is then a P2002 and the grade claims it.
      const db = fake.db.trainerSession as unknown as { findUnique: (args: { where: { id: string } }) => Promise<unknown> };
      const realFind = db.findUnique.bind(db);
      let raced = false;
      db.findUnique = async (args) => {
        const out = await realFind(args);
        if (!raced && args.where.id === SID) {
          raced = true;
          expect((await (await save({ sessionId: SID, realtimeReceipt: receipt() })).json()).graded).toBe(false);
        }
        return out;
      };
      expect(await (await save({ sessionId: SID, ...sealedGrade(SID) })).json()).toEqual({ id: receiptRowId(SID), graded: true });
      expect(raced).toBe(true);
      expect(sessions()).toHaveLength(1);
      expect(sessions()[0]).toMatchObject({ realtimeModel: PREMIUM_REALTIME_MODEL, overallScore: 62 });
    });
  });

  describe("metered voice call (its row exists from mint, id = sessionId = callId)", () => {
    const CALL = "cm-call-seal-0001";
    const seedCall = () => fake.seed("trainerSession", { id: CALL, userId, organizationId: "org-1", transcript: [], evaluation: null, overallScore: null, grade: null, goalAchieved: null });
    /** Sealed the way the client grades a metered call: with its sessionId and its callId. */
    const meteredGrade = (opts: { score?: number } = {}) => sealedGrade(CALL, { ...opts, callId: CALL });

    it("fills the call's own row with the grade once; a replay, with or without callId, is ungraded", async () => {
      seedCall();
      const grade = meteredGrade();
      expect(await (await save({ sessionId: CALL, callId: CALL, ...grade })).json()).toEqual({ id: CALL, graded: true });
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ overallScore: 62, grade: "C", transcript });
      expect((await (await save({ sessionId: CALL, callId: CALL, ...grade })).json()).graded).toBe(false);
      expect((await (await save({ sessionId: CALL, ...grade })).json()).graded).toBe(false);
      expect(gradedRows().map((s) => s.id)).toEqual([CALL]);
      expect(sessions().some((s) => s.id === receiptRowId(CALL))).toBe(false);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it("never moves the call's seal to another row: saved without callId it is ungraded and the call's row stays empty", async () => {
      seedCall();
      // A seal made without the callId verifies on a save without one, but the call's row exists, so it isn't stored.
      const res = await save({ sessionId: CALL, ...sealedGrade(CALL) });
      expect((await res.json()).graded).toBe(false);
      expect(gradedRows()).toHaveLength(0);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ transcript: [], overallScore: null });
    });

    it("stores a seal bound to another callId, or made without one, ungraded when the save names this callId", async () => {
      seedCall();
      const OTHER = "cm-call-seal-0002";
      fake.seed("trainerSession", { id: OTHER, userId, organizationId: "org-1", transcript: [], evaluation: null, overallScore: null, grade: null, goalAchieved: null });
      // Sealed for this sessionId with another call's callId, then saved naming this call's callId.
      expect((await (await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL, { callId: OTHER }) })).json()).graded).toBe(false);
      // Sealed for this call with no callId, then saved naming it.
      expect((await (await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL) })).json()).graded).toBe(false);
      // This call's seal saved naming the other call's callId.
      expect((await (await save({ sessionId: CALL, callId: OTHER, ...meteredGrade() })).json()).graded).toBe(false);
      expect(gradedRows()).toHaveLength(0);
      expect(audits().every((a) => (a.metadata as { gradeRejected?: boolean }).gradeRejected)).toBe(true);
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("doesn't overwrite a grade a concurrent save stored between the read and the fill", async () => {
      seedCall();
      fake.interleave("trainerSession", "updateMany", async () => {
        const row = fake.rows("trainerSession").find((s) => s.id === CALL)!;
        Object.assign(row, { overallScore: 80, grade: "B", transcript, realtimeSessionId: CALL });
      });
      const res = await save({ sessionId: CALL, callId: CALL, ...meteredGrade() });
      const body = await res.json();
      expect(body).toEqual({ id: expect.any(String), graded: false });
      expect(body.id).not.toBe(CALL);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ overallScore: 80, grade: "B" });
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    // Both saves read the empty row first; the hook runs the other save to completion just before this one's fill.
    const raceFills = async (first: Record<string, unknown>, second: Record<string, unknown>) => {
      let firstRes: { id: string; graded: boolean } | undefined;
      fake.interleave("trainerSession", "updateMany", async () => {
        firstRes = await (await save({ sessionId: CALL, callId: CALL, ...first })).json();
      });
      const secondRes = (await (await save({ sessionId: CALL, callId: CALL, ...second })).json()) as { id: string; graded: boolean };
      return { first: firstRes!, second: secondRes };
    };

    it("an ungraded fill that read the empty row can't erase the grade a concurrent graded fill just stored", async () => {
      seedCall();
      const { first, second } = await raceFills(meteredGrade(), {});
      expect(first).toEqual({ id: CALL, graded: true });
      expect(second).toEqual({ id: expect.any(String), graded: false });
      expect(second.id).not.toBe(CALL);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ overallScore: 62, grade: "C", realtimeSessionId: CALL, transcript });
      expect(gradedRows().map((s) => s.id)).toEqual([CALL]);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it("a graded fill that loses to an ungraded fill is stored ungraded and schedules nothing", async () => {
      seedCall();
      const { first, second } = await raceFills({}, meteredGrade());
      expect(first).toEqual({ id: CALL, graded: false });
      expect(second).toEqual({ id: expect.any(String), graded: false });
      expect(second.id).not.toBe(CALL);
      expect(gradedRows()).toHaveLength(0);
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("leaves the metering fields alone when it fills", async () => {
      const row = seedCall();
      Object.assign(row, { endedAt: null, billedMinutes: 0, allowanceId: "allow-1", reservedMinutes: 5 });
      expect((await (await save({ sessionId: CALL, callId: CALL, ...meteredGrade() })).json()).graded).toBe(true);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ endedAt: null, billedMinutes: 0, allowanceId: "allow-1", reservedMinutes: 5 });
    });

    it("stores one graded row when the call is saved twice at once", async () => {
      seedCall();
      const grade = meteredGrade();
      const bodies = await Promise.all([save({ sessionId: CALL, callId: CALL, ...grade }), save({ sessionId: CALL, callId: CALL, ...grade })].map(async (p) => (await p).json()));
      expect(bodies.map((b) => b.graded).sort()).toEqual([false, true]);
      expect(gradedRows()).toHaveLength(1);
    });
  });
});

describe("POST /api/evaluate-call binds the seal to the call's sessionId and callId", () => {
  const grade = (body: Record<string, unknown>) =>
    evaluateCall(new NextRequest("http://localhost/api/evaluate-call", { method: "POST", body: JSON.stringify({ scenario, transcript, ...body }), headers: { "content-type": "application/json" } }));

  it("returns the same fields with or without a sessionId; only a request with one gets a seal", async () => {
    const plain = await (await grade({})).json();
    const sealed = await (await grade({ sessionId: textId() })).json();
    expect(plain).not.toHaveProperty("seal");
    expect(sealed.seal).toMatch(/^[0-9a-f]{64}$/);
    const { seal: _seal, ...rest } = sealed;
    void _seal;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(plain).sort());
    expect(plain).toHaveProperty("evaluatedAt");
  });

  it("refuses a malformed sessionId or callId with 400", async () => {
    for (const bad of [{ sessionId: "bad id/../x" }, { sessionId: textId(), callId: "bad id/../x" }, { sessionId: textId(), callId: "c".repeat(65) }]) {
      const res = await grade(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("Invalid request body");
    }
  });

  it("metered call: grade with its sessionId and callId, then save with both, is graded once; with another or no callId it is not", async () => {
    const CALL = "cm-call-seal-e2e1";
    const OTHER = "cm-call-seal-e2e2";
    for (const id of [CALL, OTHER]) fake.seed("trainerSession", { id, userId, organizationId: "org-1", transcript: [], evaluation: null, overallScore: null, grade: null, goalAchieved: null });
    const { evaluation, seal } = splitSeal((await (await grade({ sessionId: CALL, callId: CALL })).json()) as Evaluation);
    expect((await (await save({ sessionId: CALL, callId: OTHER, evaluation, seal })).json()).graded).toBe(false);
    expect((await (await save({ sessionId: CALL, evaluation, seal })).json()).graded).toBe(false);
    expect(await (await save({ sessionId: CALL, callId: CALL, evaluation, seal })).json()).toEqual({ id: CALL, graded: true });
    expect((await (await save({ sessionId: CALL, callId: CALL, evaluation, seal })).json()).graded).toBe(false);
    expect(gradedRows().map((s) => s.id)).toEqual([CALL]);
    expect(mocks.notify).toHaveBeenCalledTimes(1);
  });

  it("grade then save under the same id is graded once; under another id, or without a sessionId, it is not", async () => {
    const sessionId = textId();
    const { evaluation, seal } = splitSeal((await (await grade({ sessionId })).json()) as Evaluation);
    expect(seal).toBeDefined();
    expect(await (await save({ sessionId, evaluation, seal })).json()).toEqual({ id: receiptRowId(sessionId), graded: true });
    expect((await (await save({ sessionId, evaluation, seal })).json()).graded).toBe(false);
    expect((await (await save({ sessionId: textId(), evaluation, seal })).json()).graded).toBe(false);

    const unsealed = splitSeal((await (await grade({})).json()) as Evaluation);
    expect(unsealed.seal).toBeUndefined();
    expect((await (await save({ sessionId: textId(), evaluation: unsealed.evaluation })).json()).graded).toBe(false);
    expect(gradedRows()).toHaveLength(1);
  });
});

describe("PATCH /api/transcripts/[id]: one graded row per call (src/lib/callRow.ts)", () => {
  const NOT_ALLOWED = { error: "regrade_not_allowed", message: "This call already has an AI grade. Ask your manager if you think it is wrong." };
  const patch = (id: string) =>
    regradePATCH(new NextRequest(`http://localhost/api/transcripts/${id}`, { method: "PATCH", body: JSON.stringify({ scenario }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id }) });
  const as = (id: string) => { mocks.authId = id; };
  let trainee: string;
  let manager: string;
  let admin: string;
  const callRows = (sessionId: string) => sessions().filter((s) => s.realtimeSessionId === sessionId);
  /** Holds every model call until `count` have started, so each re-grade passes its pre-checks before any writes. */
  const holdGrades = (count: number) => {
    let release!: () => void;
    mocks.gate = new Promise<void>((r) => (release = r));
    const started = setInterval(() => { if (mocks.aiCalls >= count) { clearInterval(started); release(); } }, 0);
  };

  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "test-key");
    mocks.ai = { overallScore: 88 };
    trainee = userId;
    manager = `${userId}-manager`;
    admin = `${userId}-admin`;
    fake.seed("user", { id: manager, email: `${manager}@example.test`, organizationId: "org-1", role: "manager" });
    fake.seed("user", { id: admin, email: `${admin}@example.test`, organizationId: "org-2", isPlatformAdmin: true });
  });

  /** A call saved twice with the same sealed rules-based grade: the call's own row, graded, and an ungraded replay copy. */
  const savedWithReplay = async () => {
    mocks.ai = null;
    const sessionId = textId();
    const grade = sealedGrade(sessionId);
    const own = (await (await save({ sessionId, ...grade })).json()) as { id: string; graded: boolean };
    const copy = (await (await save({ sessionId, ...grade })).json()) as { id: string; graded: boolean };
    mocks.ai = { overallScore: 88 };
    expect(own).toEqual({ id: receiptRowId(sessionId), graded: true });
    expect(copy.graded).toBe(false);
    return { sessionId, own: own.id, copy: copy.id };
  };

  it("refuses to re-grade a replay copy, for the owner, their manager and a platform admin, without a model call", async () => {
    const { sessionId, copy } = await savedWithReplay();
    for (const who of [trainee, manager, admin]) {
      as(who);
      const res = await patch(copy);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(NOT_ALLOWED);
    }
    expect(mocks.aiCalls).toBe(0);
    expect(callRows(sessionId).filter((s) => s.overallScore != null)).toHaveLength(1);
  });

  it("still re-grades the call's own row: the owner on a rules-based grade, a manager on an AI grade", async () => {
    const { sessionId, own } = await savedWithReplay();
    as(trainee);
    expect((await patch(own)).status).toBe(200);
    expect(sessions().find((s) => s.id === own)).toMatchObject({ overallScore: 88, evaluation: expect.objectContaining({ method: "llm" }) });
    // Now an AI grade: the owner may not re-roll it; their manager may.
    expect(await (await patch(own)).json()).toEqual(NOT_ALLOWED);
    as(manager);
    expect((await patch(own)).status).toBe(200);
    expect(callRows(sessionId).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual([own]);
  });

  it("lands an ungraded first save on the call's own row, so it can be re-graded; its replay copy can't", async () => {
    const sessionId = textId();
    const first = (await (await save({ sessionId })).json()) as { id: string; graded: boolean };
    expect(first).toEqual({ id: receiptRowId(sessionId), graded: false });
    const copy = (await (await save({ sessionId })).json()) as { id: string };
    expect(copy.id).not.toBe(first.id);
    as(trainee);
    expect(await (await patch(copy.id)).json()).toEqual(NOT_ALLOWED);
    expect((await patch(first.id)).status).toBe(200);
    expect(callRows(sessionId).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual([first.id]);
  });

  it("re-grades a metered call's own row and refuses its copy", async () => {
    const CALL = "cm-call-regrade-01";
    fake.seed("trainerSession", { id: CALL, userId, organizationId: "org-1", transcript: [], evaluation: null, overallScore: null, grade: null, goalAchieved: null });
    expect(await (await save({ sessionId: CALL, callId: CALL })).json()).toEqual({ id: CALL, graded: false });
    const copy = (await (await save({ sessionId: CALL, callId: CALL })).json()) as { id: string };
    as(trainee);
    expect(await (await patch(copy.id)).json()).toEqual(NOT_ALLOWED);
    expect((await patch(CALL)).status).toBe(200);
    expect(callRows(CALL).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual([CALL]);
  });

  it("doesn't fill a metered call's row from a save whose callId differs from its sessionId; the real call's save still fills it and re-grades", async () => {
    const CALL = "cm-call-regrade-02";
    fake.seed("trainerSession", { id: CALL, userId, organizationId: "org-1", transcript: [], realtimeSessionId: null, evaluation: null, overallScore: null, grade: null, goalAchieved: null });
    const stray = (await (await save({ sessionId: textId(), callId: CALL })).json()) as { id: string };
    expect(stray.id).not.toBe(CALL);
    expect(sessions().find((s) => s.id === CALL)).toMatchObject({ transcript: [], realtimeSessionId: null });
    // The real call, saved under its own id, still fills its row; that row is the call's own and re-grades.
    expect(await (await save({ sessionId: CALL, callId: CALL })).json()).toEqual({ id: CALL, graded: false });
    expect(sessions().find((s) => s.id === CALL)).toMatchObject({ transcript, realtimeSessionId: CALL });
    as(trainee);
    expect((await patch(CALL)).status).toBe(200);
    expect(sessions().find((s) => s.id === CALL)).toMatchObject({ overallScore: 88 });
  });

  it("stores a graded metered fill ungraded when a legacy copy of the call already has a score", async () => {
    const CALL = "cm-call-regrade-03";
    fake.seed("trainerSession", { id: CALL, userId, organizationId: "org-1", transcript: [], realtimeSessionId: null, evaluation: null, overallScore: null, grade: null, goalAchieved: null });
    fake.seed("trainerSession", { id: "legacy-graded", userId, organizationId: "org-1", scenarioId: scenario.id, transcript, realtimeSessionId: CALL, evaluation: { method: "heuristic", overallScore: 50 }, overallScore: 50, grade: "D" });
    expect(await (await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL, { callId: CALL }) })).json()).toEqual({ id: CALL, graded: false });
    expect(sessions().find((s) => s.id === CALL)).toMatchObject({ transcript, overallScore: null, realtimeSessionId: CALL });
    expect(callRows(CALL).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual(["legacy-graded"]);
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  it("stores a graded save as an ungraded copy when the call's ungraded receipt row and a graded legacy copy coexist", async () => {
    const sessionId = textId();
    expect(await (await save({ sessionId })).json()).toEqual({ id: receiptRowId(sessionId), graded: false });
    fake.seed("trainerSession", { id: "legacy-graded", userId, organizationId: "org-1", scenarioId: scenario.id, transcript, realtimeSessionId: sessionId, evaluation: { method: "heuristic", overallScore: 50 }, overallScore: 50, grade: "D" });
    const body = (await (await save({ sessionId, ...sealedGrade(sessionId) })).json()) as { id: string; graded: boolean };
    expect(body.graded).toBe(false);
    expect(body.id).not.toBe(receiptRowId(sessionId));
    expect(sessions().find((s) => s.id === receiptRowId(sessionId))).toMatchObject({ overallScore: null });
    expect(callRows(sessionId).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual(["legacy-graded"]);
  });

  it("doesn't let a manager's re-grade overwrite a sealed save that replaced the row's transcript and grade meanwhile", async () => {
    const sessionId = textId();
    const oldTranscript = [{ role: "assistant", text: "Hello?" }, { role: "user", text: "Hi, it's a different call." }];
    expect(await (await save({ sessionId, transcript: oldTranscript })).json()).toEqual({ id: receiptRowId(sessionId), graded: false });
    // The manager's model call is held until the sealed save has claimed the row.
    let release!: () => void;
    mocks.gate = new Promise<void>((r) => (release = r));
    as(manager);
    const regrade = patch(receiptRowId(sessionId));
    while (mocks.aiCalls < 1) await new Promise((r) => setTimeout(r, 0));
    as(trainee);
    expect(await (await save({ sessionId, ...sealedGrade(sessionId) })).json()).toEqual({ id: receiptRowId(sessionId), graded: true });
    release();
    const res = await regrade;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conflict");
    // The row keeps the sealed save's transcript and grade, not a grade of the old transcript.
    expect(sessions().find((s) => s.id === receiptRowId(sessionId))).toMatchObject({ transcript, overallScore: 62 });
  });

  it("concurrent re-grades of the original and its replay copy leave one graded row", async () => {
    const sessionId = textId();
    const first = (await (await save({ sessionId })).json()) as { id: string };
    const copy = (await (await save({ sessionId })).json()) as { id: string };
    as(manager);
    const [a, b] = await Promise.all([patch(first.id), patch(copy.id)]);
    expect([a.status, b.status]).toEqual([200, 403]);
    expect(callRows(sessionId).filter((s) => s.overallScore != null).map((s) => s.id)).toEqual([first.id]);
  });

  describe("legacy call (saved before call rows existed: only copies, under random row ids)", () => {
    const LEGACY = "text-1761559200000";
    const seedLegacy = (id: string, score: number | null = null) =>
      fake.seed("trainerSession", { id, userId, organizationId: "org-1", scenarioId: scenario.id, transcript, realtimeSessionId: LEGACY, evaluation: score == null ? null : { method: "heuristic", overallScore: score }, overallScore: score, grade: score == null ? null : "C", goalAchieved: null });
    const graded = () => callRows(LEGACY).filter((s) => s.overallScore != null).map((s) => s.id).sort();

    it("keeps the old rules on a lone legacy row: the owner re-grades it while it has no AI grade", async () => {
      seedLegacy("legacy-a");
      as(trainee);
      expect((await patch("legacy-a")).status).toBe(200);
      expect(graded()).toEqual(["legacy-a"]);
      expect(await (await patch("legacy-a")).json()).toEqual(NOT_ALLOWED);
    });

    it("refuses a legacy copy while another row of the call has a score, but lets a graded one be re-graded", async () => {
      seedLegacy("legacy-a", 55);
      seedLegacy("legacy-b");
      as(manager);
      expect(await (await patch("legacy-b")).json()).toEqual(NOT_ALLOWED);
      expect(mocks.aiCalls).toBe(0);
      expect((await patch("legacy-a")).status).toBe(200);
      expect(graded()).toEqual(["legacy-a"]);
    });

    it("refuses a scored legacy row while a sibling is also scored, for a manager and a platform admin; a lone scored one still re-grades", async () => {
      // An old call saved twice, both copies graded (the bug this card fixes).
      seedLegacy("legacy-a", 55);
      seedLegacy("legacy-b", 60);
      for (const who of [manager, admin]) {
        as(who);
        for (const id of ["legacy-a", "legacy-b"]) expect(await (await patch(id)).json()).toEqual(NOT_ALLOWED);
      }
      expect(mocks.aiCalls).toBe(0);
      expect(sessions().filter((s) => s.realtimeSessionId === LEGACY).map((s) => s.overallScore).sort()).toEqual([55, 60]);
      // A lone scored legacy row (its call has no other graded row) keeps the old rules.
      fake.rows("trainerSession").find((s) => s.id === "legacy-b")!.overallScore = null;
      as(manager);
      expect((await patch("legacy-a")).status).toBe(200);
      expect(sessions().find((s) => s.id === "legacy-a")).toMatchObject({ overallScore: 88 });
    });

    it("concurrent re-grades of two ungraded legacy copies store one grade (the second is refused under the call's lock)", async () => {
      seedLegacy("legacy-a");
      seedLegacy("legacy-b");
      as(manager);
      holdGrades(2);
      const results = await Promise.all([patch("legacy-a"), patch("legacy-b")]);
      expect(mocks.aiCalls).toBe(2);
      expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
      expect(graded()).toHaveLength(1);
      expect(fake.rawQueries.filter((q) => q.sql.includes("pg_advisory_xact_lock") && String(q.values[0]).includes(LEGACY))).toHaveLength(2);
    });

    it("never gives a legacy call its own row: a new sealed grade for it is saved as an ungraded copy, also while a re-grade runs", async () => {
      seedLegacy("legacy-a");
      as(trainee);
      holdGrades(1);
      const [regrade, saved] = await Promise.all([patch("legacy-a"), save({ sessionId: LEGACY, ...sealedGrade(LEGACY) })]);
      expect(regrade.status).toBe(200);
      const body = (await saved.json()) as { id: string; graded: boolean };
      expect(body.graded).toBe(false);
      expect(body.id).not.toBe(receiptRowId(LEGACY));
      expect(sessions().some((s) => s.id === receiptRowId(LEGACY))).toBe(false);
      expect(graded()).toEqual(["legacy-a"]);
    });
  });

  describe("one graded row per transcript (src/lib/transcriptGrade.ts)", () => {
    const expired = (sid: string) => sealedGrade(sid, { evaluatedAt: new Date(T0.getTime() - GRADE_SEAL_MAX_AGE_MS - 1_000).toISOString() });
    const tampered = (sid: string) => {
      const g = sealedGrade(sid);
      return { ...g, evaluation: { ...g.evaluation, overallScore: 100, grade: "A" } };
    };
    const crossUser = (sid: string) => sealedGrade(sid, { forUser: "someone-else" });
    /** Saves the shared transcript under a new sessionId; the body is the save's answer. */
    const saveNew = async (make: (sid: string) => Record<string, unknown> = () => ({}), extra: Record<string, unknown> = {}) => {
      const sid = textId();
      const body = (await (await save({ sessionId: sid, ...make(sid), ...extra })).json()) as { id: string; graded: boolean };
      return { sid, ...body };
    };
    const gradedIds = () => gradedRows().map((s) => s.id).sort();
    const lockKeys = () => fake.rawQueries.filter((q) => q.sql.includes("pg_advisory_xact_lock")).map((q) => String(q.values[0]));
    const isTranscriptLock = (k: string) => k.startsWith("ct-transcript-grade:");
    const isCallLock = (k: string) => k.startsWith("ct-call-grade:");
    const otherTranscript = [{ role: "assistant", text: "Hello, this is a different caller." }, { role: "user", text: "Thanks for calling, how can I help today?" }];

    it("Tally's case: a solo owner's graded call replayed under a new sessionId is stored ungraded and its copy can't be re-graded", async () => {
      fake.rows("user").find((u) => u.id === trainee)!.role = "owner";
      const original = await saveNew((sid) => sealedGrade(sid, { score: 74 }));
      expect(original).toMatchObject({ id: receiptRowId(original.sid), graded: true });
      // The same {transcript, evaluation, seal} under a different sessionId: stored ungraded on that sessionId's own row.
      const grade = sealedGrade(original.sid, { score: 74 });
      const replaySid = textId();
      expect(await (await save({ sessionId: replaySid, ...grade })).json()).toEqual({ id: receiptRowId(replaySid), graded: false });
      as(trainee);
      const res = await patch(receiptRowId(replaySid));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(NOT_ALLOWED);
      expect(mocks.aiCalls).toBe(0);
      expect(gradedIds()).toEqual([original.id]);
      expect(sessions().find((s) => s.id === receiptRowId(replaySid))).toMatchObject({ overallScore: null, grade: null });
      // The original still follows the trainee rule: its rules-based grade may be re-graded once.
      expect((await patch(original.id)).status).toBe(200);
      expect(gradedIds()).toEqual([original.id]);
    });

    it("stores a fresh, valid seal for the same transcript under a new sessionId ungraded (grading it again doesn't make a second graded row)", async () => {
      const original = await saveNew(sealedGrade);
      expect(original.graded).toBe(true);
      // A seal minted for the new sessionId verifies, but the user already has a graded row of this transcript.
      const again = await saveNew((sid) => sealedGrade(sid, { score: 90 }));
      expect(again).toMatchObject({ id: receiptRowId(again.sid), graded: false });
      expect(audits().at(-1)!.metadata).toEqual({ scenarioId: scenario.id, overallScore: null, gradeRejected: true });
      expect(gradedIds()).toEqual([original.id]);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
      // A different transcript under a new sessionId is still graded.
      const sid = textId();
      const evaluation = { method: "heuristic", graderVersion: "heuristic-v2", overallScore: 70, grade: "C", goalAchievement: { achieved: false }, evaluatedAt: new Date().toISOString() };
      const seal = sealEvaluation({ userId, sessionId: sid, scenarioId: scenario.id, transcript: otherTranscript, evaluation }, KEY);
      expect(await (await save({ sessionId: sid, transcript: otherTranscript, evaluation, seal })).json()).toEqual({ id: receiptRowId(sid), graded: true });
      expect(gradedRows()).toHaveLength(2);
    });

    it("refuses the copy saved from an expired, tampered, cross-user or missing seal while a graded original exists, for owner, manager and admin", async () => {
      const original = await saveNew(sealedGrade);
      expect(original.graded).toBe(true);
      for (const make of [expired, tampered, crossUser, () => ({})]) {
        as(trainee);
        const copy = await saveNew(make);
        expect(copy).toEqual({ sid: copy.sid, id: receiptRowId(copy.sid), graded: false });
        for (const who of [trainee, manager, admin]) {
          as(who);
          const res = await patch(copy.id);
          expect(res.status).toBe(403);
          expect(await res.json()).toEqual(NOT_ALLOWED);
        }
      }
      expect(mocks.aiCalls).toBe(0);
      expect(gradedIds()).toEqual([original.id]);
    });

    it("lets an expired-seal first save with no graded original be self re-graded once; a second copy is then refused", async () => {
      const first = await saveNew(expired);
      expect(first).toMatchObject({ id: receiptRowId(first.sid), graded: false });
      as(trainee);
      expect((await patch(first.id)).status).toBe(200);
      expect(sessions().find((s) => s.id === first.id)).toMatchObject({ overallScore: 88 });
      const second = await saveNew(expired);
      expect(second.graded).toBe(false);
      expect(await (await patch(second.id)).json()).toEqual(NOT_ALLOWED);
      expect(gradedIds()).toEqual([first.id]);
      expect(mocks.aiCalls).toBe(1);
    });

    it("keeps a manager's re-grade of a trainee's genuine call working: graded or ungraded, it is 200", async () => {
      const gradedCall = await saveNew(sealedGrade);
      const ungradedCall = await saveNew(undefined, { transcript: otherTranscript });
      expect([gradedCall.graded, ungradedCall.graded]).toEqual([true, false]);
      as(manager);
      for (const id of [gradedCall.id, ungradedCall.id]) {
        const res = await patch(id);
        expect(res.status).toBe(200);
        expect(sessions().find((s) => s.id === id)).toMatchObject({ overallScore: 88 });
      }
      expect(gradedIds()).toEqual([gradedCall.id, ungradedCall.id].sort());
    });

    it("refuses a manager's re-grade of a trainee's replay copy, without a model call", async () => {
      const original = await saveNew(sealedGrade);
      const copy = await saveNew(() => sealedGrade(original.sid));
      expect(copy.graded).toBe(false);
      as(manager);
      const res = await patch(copy.id);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual(NOT_ALLOWED);
      expect(mocks.aiCalls).toBe(0);
      expect(gradedIds()).toEqual([original.id]);
    });

    it("platform admin: refused on a copy like everyone else, and can still re-grade the original", async () => {
      const original = await saveNew(expired);
      const copy = await saveNew(expired);
      as(admin);
      expect((await patch(original.id)).status).toBe(200);
      expect(await (await patch(copy.id)).json()).toEqual(NOT_ALLOWED);
      expect((await patch(original.id)).status).toBe(200);
      expect(gradedIds()).toEqual([original.id]);
    });

    for (const actor of ["owner", "manager"] as const) {
      it(`concurrent re-grades of two copies by the ${actor} store one grade (the second is refused under the transcript's lock)`, async () => {
        const a = await saveNew();
        const b = await saveNew();
        as(actor === "owner" ? trainee : manager);
        holdGrades(2);
        const results = await Promise.all([patch(a.id), patch(b.id)]);
        expect(mocks.aiCalls).toBe(2);
        expect(results.map((r) => r.status).sort()).toEqual([200, 403]);
        expect(gradedRows()).toHaveLength(1);
        expect(lockKeys().filter(isTranscriptLock)).toHaveLength(2);
      });
    }

    it("refuses a re-grade of a copy when a sealed save of the same transcript stores its grade during the model call", async () => {
      const copy = await saveNew();
      let release!: () => void;
      mocks.gate = new Promise<void>((r) => (release = r));
      as(manager);
      const regrade = patch(copy.id);
      while (mocks.aiCalls < 1) await new Promise((r) => setTimeout(r, 0));
      as(trainee);
      const saved = await saveNew(sealedGrade);
      expect(saved.graded).toBe(true);
      release();
      expect(await (await regrade).json()).toEqual(NOT_ALLOWED);
      expect(gradedIds()).toEqual([saved.id]);
    });

    it("stores one graded row when sealed saves of the same transcript under two sessionIds race", async () => {
      const [s1, s2] = [textId(), textId()];
      const bodies = await Promise.all([save({ sessionId: s1, ...sealedGrade(s1) }), save({ sessionId: s2, ...sealedGrade(s2) })].map(async (p) => (await p).json()));
      expect(bodies.map((b) => b.graded).sort()).toEqual([false, true]);
      expect(gradedRows()).toHaveLength(1);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    describe("organization change between mint and save: the check uses the organization of the row the grade lands on", () => {
      const moveUser = (org: string) => { fake.rows("user").find((u) => u.id === trainee)!.organizationId = org; };
      const seedGradedDup = (org: string) => fake.seed("trainerSession", { id: `dup-${org}`, userId, organizationId: org, scenarioId: scenario.id, transcript, overallScore: 70, grade: "C" });
      const CALL = "cm-call-org-0001";
      const seedMetered = () => fake.seed("trainerSession", { id: CALL, userId, organizationId: "org-1", transcript: [], evaluation: null, overallScore: null, grade: null, goalAchieved: null });
      const saveMetered = async () => (await (await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL, { callId: CALL }) })).json()) as { id: string; graded: boolean };
      const SID = "uuid-0000-0000-org1";
      /** A receipt-only save makes the call's receipt row in org-1; the user then moves; the graded save claims that row. */
      const claimAfterMove = async (dupOrg: string) => {
        expect(await (await save({ sessionId: SID, realtimeReceipt: sealMintReceipt(userId, SID, PREMIUM_REALTIME_MODEL)! })).json()).toEqual({ id: receiptRowId(SID), graded: false });
        seedGradedDup(dupOrg);
        moveUser("org-2");
        return (await (await save({ sessionId: SID, ...sealedGrade(SID) })).json()) as { id: string; graded: boolean };
      };

      it("metered fill: a graded duplicate in the row's (old) organization refuses the grade after the user moved", async () => {
        seedMetered();
        seedGradedDup("org-1");
        moveUser("org-2");
        expect(await saveMetered()).toEqual({ id: CALL, graded: false });
        expect(gradedIds()).toEqual(["dup-org-1"]);
      });

      it("metered fill: a graded duplicate only in the user's new organization doesn't refuse a grade for the old organization's row", async () => {
        seedMetered();
        seedGradedDup("org-2");
        moveUser("org-2");
        expect(await saveMetered()).toEqual({ id: CALL, graded: true });
        expect(sessions().find((s) => s.id === CALL)).toMatchObject({ organizationId: "org-1", overallScore: 62 });
      });

      it("receipt-row claim: a graded duplicate in the existing row's organization refuses the grade", async () => {
        expect(await claimAfterMove("org-1")).toEqual({ id: expect.any(String), graded: false });
        expect(sessions().find((s) => s.id === receiptRowId(SID))).toMatchObject({ organizationId: "org-1", overallScore: null });
        expect(gradedIds()).toEqual(["dup-org-1"]);
      });

      it("receipt-row claim: a graded duplicate only in the user's new organization doesn't refuse it", async () => {
        expect(await claimAfterMove("org-2")).toEqual({ id: receiptRowId(SID), graded: true });
        expect(sessions().find((s) => s.id === receiptRowId(SID))).toMatchObject({ organizationId: "org-1", overallScore: 62 });
      });

      it("a brand-new row uses the user's current organization", async () => {
        seedGradedDup("org-1");
        moveUser("org-2");
        const fresh = await saveNew(sealedGrade);
        expect(fresh).toMatchObject({ id: receiptRowId(fresh.sid), graded: true });
        expect(sessions().find((s) => s.id === fresh.id)).toMatchObject({ organizationId: "org-2" });
        expect((await saveNew(sealedGrade)).graded).toBe(false);
      });
    });

    it("takes the call's lock before the transcript's lock, in the save and in a legacy re-grade", async () => {
      await saveNew(sealedGrade);
      const saveKeys = lockKeys();
      expect(saveKeys.map((k) => (isCallLock(k) ? "call" : isTranscriptLock(k) ? "transcript" : "other"))).toEqual(["call", "transcript"]);
      fake.rawQueries.length = 0;
      fake.seed("trainerSession", { id: "legacy-solo", userId, organizationId: "org-1", scenarioId: scenario.id, transcript: otherTranscript, realtimeSessionId: "text-1761559200001", evaluation: null, overallScore: null, grade: null, goalAchieved: null });
      as(trainee);
      expect((await patch("legacy-solo")).status).toBe(200);
      expect(lockKeys().map((k) => (isCallLock(k) ? "call" : isTranscriptLock(k) ? "transcript" : "other"))).toEqual(["call", "transcript"]);
    });
  });
});

describe("transcriptGrade helpers", () => {
  it("digests a stored transcript like the seal does, ignoring timestamps, and rejects anything that isn't turns", () => {
    expect(storedTranscriptDigest(transcript.map((t, i) => ({ ...t, timestamp: `2026-11-22T12:00:0${i}.000Z` })))).toBe(transcriptDigest(transcript));
    for (const bad of [null, {}, "turns", [{ role: "user" }], [null], [{ role: 1, text: "x" }]]) expect(storedTranscriptDigest(bad)).toBeNull();
  });

  it(`compares only the ${GRADED_DUPLICATE_SCAN} most recent graded rows of the same user, organization and persona`, async () => {
    const seedRow = (over: Record<string, unknown>) => fake.seed("trainerSession", { userId, organizationId: "org-1", scenarioId: scenario.id, transcript, overallScore: 60, ...over });
    const scope = { userId, organizationId: "org-1", scenarioId: scenario.id, excludeId: "self" };
    const digest = transcriptDigest(transcript);
    seedRow({ id: "self", overallScore: null });
    // Not duplicates: ungraded, another user, another organization, another persona.
    seedRow({ overallScore: null });
    seedRow({ userId: "someone-else" });
    seedRow({ organizationId: "org-2" });
    seedRow({ scenarioId: "another-persona" });
    expect(await hasGradedDuplicate(fake.db as never, scope, digest)).toBe(false);
    seedRow({ id: "old-dup", createdAt: new Date(T0.getTime() - 1_000_000) });
    for (let i = 0; i < GRADED_DUPLICATE_SCAN - 1; i++) seedRow({ transcript: [{ role: "user", text: `call ${i}` }], createdAt: new Date(T0.getTime() - i) });
    expect(await hasGradedDuplicate(fake.db as never, scope, digest)).toBe(true);
    seedRow({ transcript: [{ role: "user", text: "one more" }], createdAt: T0 });
    expect(await hasGradedDuplicate(fake.db as never, scope, digest)).toBe(false);
  });
});
