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
}));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));
vi.mock("@/lib/ghlWebhook", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/ghlWebhook")>()), notifyFirstGradedCall: mocks.notify }));

import { GRADE_SEAL_MAX_AGE_MS, sealEvaluation, stableStringify, transcriptDigest } from "@/lib/gradeSeal";
import { receiptRowId, sealMintReceipt } from "@/lib/mintReceipt";
import { PREMIUM_REALTIME_MODEL } from "@/lib/voiceModels";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { splitSeal } from "@/lib/sessionStore";
import type { Evaluation } from "@/lib/grader-types";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
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
function sealedGrade(sessionId: string, opts: { evaluatedAt?: string; score?: number; forUser?: string } = {}) {
  const evaluation = { method: "heuristic", graderVersion: "heuristic-v2", overallScore: opts.score ?? 62, grade: "C", goalAchievement: { achieved: false }, evaluatedAt: opts.evaluatedAt ?? new Date().toISOString() };
  const seal = sealEvaluation({ userId: opts.forUser ?? userId, sessionId, scenarioId: scenario.id, transcript, evaluation }, KEY)!;
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
      // The graded save tries to insert the call's row; just before, the receipt-only save inserts it.
      const db = fake.db.trainerSession as unknown as { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
      const realCreate = db.create.bind(db);
      let raced = false;
      db.create = async (args) => {
        if (!raced && args.data.id === receiptRowId(SID) && args.data.overallScore != null) {
          raced = true;
          expect((await (await save({ sessionId: SID, realtimeReceipt: receipt() })).json()).graded).toBe(false);
        }
        return realCreate(args);
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

    it("fills the call's own row with the grade once; a replay, with or without callId, is ungraded", async () => {
      seedCall();
      const grade = sealedGrade(CALL);
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
      const res = await save({ sessionId: CALL, ...sealedGrade(CALL) });
      expect((await res.json()).graded).toBe(false);
      expect(gradedRows()).toHaveLength(0);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ transcript: [], overallScore: null });
    });

    it("doesn't overwrite a grade a concurrent save stored between the read and the fill", async () => {
      seedCall();
      fake.interleave("trainerSession", "updateMany", async () => {
        const row = fake.rows("trainerSession").find((s) => s.id === CALL)!;
        Object.assign(row, { overallScore: 80, grade: "B", transcript, realtimeSessionId: CALL });
      });
      const res = await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL) });
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
      const { first, second } = await raceFills(sealedGrade(CALL), {});
      expect(first).toEqual({ id: CALL, graded: true });
      expect(second).toEqual({ id: expect.any(String), graded: false });
      expect(second.id).not.toBe(CALL);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ overallScore: 62, grade: "C", realtimeSessionId: CALL, transcript });
      expect(gradedRows().map((s) => s.id)).toEqual([CALL]);
      expect(mocks.notify).toHaveBeenCalledTimes(1);
    });

    it("a graded fill that loses to an ungraded fill is stored ungraded and schedules nothing", async () => {
      seedCall();
      const { first, second } = await raceFills({}, sealedGrade(CALL));
      expect(first).toEqual({ id: CALL, graded: false });
      expect(second).toEqual({ id: expect.any(String), graded: false });
      expect(second.id).not.toBe(CALL);
      expect(gradedRows()).toHaveLength(0);
      expect(mocks.notify).not.toHaveBeenCalled();
    });

    it("leaves the metering fields alone when it fills", async () => {
      const row = seedCall();
      Object.assign(row, { endedAt: null, billedMinutes: 0, allowanceId: "allow-1", reservedMinutes: 5 });
      expect((await (await save({ sessionId: CALL, callId: CALL, ...sealedGrade(CALL) })).json()).graded).toBe(true);
      expect(sessions().find((s) => s.id === CALL)).toMatchObject({ endedAt: null, billedMinutes: 0, allowanceId: "allow-1", reservedMinutes: 5 });
    });

    it("stores one graded row when the call is saved twice at once", async () => {
      seedCall();
      const grade = sealedGrade(CALL);
      const bodies = await Promise.all([save({ sessionId: CALL, callId: CALL, ...grade }), save({ sessionId: CALL, callId: CALL, ...grade })].map(async (p) => (await p).json()));
      expect(bodies.map((b) => b.graded).sort()).toEqual([false, true]);
      expect(gradedRows()).toHaveLength(1);
    });
  });
});

describe("POST /api/evaluate-call binds the seal to the call's sessionId", () => {
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

  it("refuses a malformed sessionId with 400", async () => {
    const res = await grade({ sessionId: "bad id/../x" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid request body");
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
