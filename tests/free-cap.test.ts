import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Free voice is 10 minutes a month, checked only when a call starts. Same fakes as usage-metering.test.ts:
// the database and the session check are replaced; metering, the ledger and the routes run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, checkCap, creditManual, endCall, ensureAllowance, heartbeat, resolveAllowance, usageSummary } from "@/lib/usage";
import { FREE_MINUTES, MAX_CALL_SECONDS, capFor } from "@/lib/usagePlan";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { POST as evaluate } from "@/app/api/evaluate-call/route";
import { POST as simulate } from "@/app/api/simulate/turn/route";
import { POST as creditRoute } from "@/app/api/usage/credit/route";

const T0 = new Date("2026-10-15T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
// The signup anchor is the 10th at 12:00 UTC, so the month resets on the 10th (billing anchor already in code).
const MAR10 = new Date("2026-03-10T12:00:00Z");

let fake: ReturnType<typeof createFakePrisma>;

function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;

/** A Free user who has already used `used` minutes this month. */
async function freeUserWith(used: number) {
  addUser("u-1");
  await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
  allowanceOf("u-1").minutesUsed = used;
}

/** A voice call on a controlled clock: heartbeats every 10 seconds, collecting every answer, then ends at `endAt`. */
async function runCall(userId: string, o: { endAt: number; start?: number }) {
  const start = o.start ?? 0;
  const begun = await beginCall(userId, scn, at(start));
  if (!begun.ok) throw new Error(begun.error);
  await heartbeat(userId, begun.callId, "connected", at(start));
  const answers = [];
  for (let t = start + 10; t < start + o.endAt; t += 10) answers.push(await heartbeat(userId, begun.callId, "ok", at(t)));
  const result = await endCall(userId, begun.callId, "user_hangup", at(start + o.endAt));
  return { begun, callId: begun.callId, answers, result: result! };
}

const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const scenario = BUILT_IN_SCENARIOS[0];
const transcript = [
  { role: "assistant", text: "Hello, this is Dana." },
  { role: "user", text: "Hi Dana, I am calling about the quote we sent last week. Do you have a few minutes?" },
  { role: "assistant", text: "Sure, but I only have a couple of minutes." },
  { role: "user", text: "Thanks. What would help you decide, and when could we talk again?" },
];

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
  // No model keys: grading and the text caller use their rules-based fallbacks, with no network.
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("the Free allowance", () => {
  it("1: a new Free account has 10 voice minutes and a call at 0 used starts", async () => {
    expect(FREE_MINUTES).toBe(10);
    expect(capFor("free")).toBe(10);
    addUser("u-1");
    const summary = await usageSummary("u-1", at(0));
    expect(summary).toMatchObject({ plan: "free", minutesCap: 10, minutesUsed: 0, remaining: 10 });
    const r = await resolveAllowance(fake.db as never, "u-1", at(0));
    expect(r).toMatchObject({ remaining: 10, available: 10 });

    const begun = await beginCall("u-1", scn, at(0));
    expect(begun).toMatchObject({ ok: true, remaining: 10 });
  });
});

describe("the cap is checked only when a call starts", () => {
  it("2: a call started at 9.5 of 10 used runs 3 minutes with no cutoff, is graded and debriefed, and usage reads 12.5", async () => {
    await freeUserWith(9.5);
    const start = await resolveAllowance(fake.db as never, "u-1", at(0));
    expect(start).toMatchObject({ remaining: 0.5, available: 0.5 });
    const { begun, callId, answers, result } = await runCall("u-1", { endAt: 180 });

    // Past the minute the call held, the server never said stop and never clamped it.
    expect(begun.maxSeconds).toBe(MAX_CALL_SECONDS);
    expect(answers.length).toBeGreaterThan(10);
    for (const a of answers) expect(a).toMatchObject({ found: true, stop: false });
    expect(result).toMatchObject({ endReason: "user_hangup", billedMinutes: 3, creditedMinutes: 0 });
    expect(session(callId)).toMatchObject({ endReason: "user_hangup", billableSeconds: 180, billedMinutes: 3, abuseFlagged: false });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();

    // Every minute counts toward the month, above the cap.
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 12.5, minutesReserved: 0 });
    expect(await usageSummary("u-1", at(200))).toMatchObject({ minutesCap: 10, minutesUsed: 12.5, remaining: 0 });

    // The debrief path is open: the call is graded and its transcript is saved against the metered call.
    const graded = await evaluate(post("/api/evaluate-call", { scenario, transcript }));
    expect(graded.status).toBe(200);
    const evaluation = await graded.json();
    expect(typeof evaluation.overallScore).toBe("number");
    const saved = await saveTranscript(post("/api/transcripts", { sessionId: "voice-1", callId, transcript, durationSeconds: 180, scenario: { id: scenario.id }, evaluation }));
    expect(saved.status).toBe(200);
    expect(session(callId).transcript).toHaveLength(transcript.length);
  });

  it("a Free call that runs far past the cap is never stopped or flagged, and all of it counts", async () => {
    await freeUserWith(9);
    const { answers, result } = await runCall("u-1", { endAt: 40 * 60 });
    expect(answers.every((a) => a.found && !a.stop)).toBe(true);
    expect(result).toMatchObject({ endReason: "user_hangup", billedMinutes: 40 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 49, minutesReserved: 0 });
    expect(fake.rows("trainerSession")[0].abuseFlagged).toBe(false);
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
    // A late stray end event for a call that was never clamped is not an overrun either.
    await endCall("u-1", fake.rows("trainerSession")[0].id as string, "user_hangup", at(40 * 60 + 600));
    expect(fake.rows("trainerSession")[0].abuseFlagged).toBe(false);
  });

  it("the call length limit still applies to a Free call", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    const r = await heartbeat("u-1", begun.callId, "ok", at(MAX_CALL_SECONDS + 5));
    expect(r).toMatchObject({ found: true, stop: true, reason: "max_duration" });
    expect(session(begun.callId)).toMatchObject({ endReason: "max_duration", billedMinutes: MAX_CALL_SECONDS / 60 });
  });

  it("a plan change mid-call does not change the rule the call started under", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    expect(session(begun.callId).capEnforced).toBe(false);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    fake.rows("user")[0].planTier = "pro"; // upgraded while the call is running
    const r = await heartbeat("u-1", begun.callId, "ok", at(15 * 60));
    expect(r).toMatchObject({ found: true, stop: false });
    await endCall("u-1", begun.callId, "user_hangup", at(15 * 60));
    expect(session(begun.callId).billedMinutes).toBe(15);
  });
});

describe("fractional usage", () => {
  it("any minutes left let a Free call start, and a second start cannot take the same half minute", async () => {
    await freeUserWith(9.5);
    expect(checkCap({ remaining: 0.5, plan: "free" })).toEqual({ ok: true });
    expect(checkCap({ remaining: 0, plan: "free" })).toEqual({ ok: false, error: "cap_reached" });
    const first = await beginCall("u-1", scn, at(0));
    expect(first).toMatchObject({ ok: true, remaining: 0.5, maxSeconds: MAX_CALL_SECONDS });
    expect(allowanceOf("u-1").minutesReserved).toBe(1);
    expect(await beginCall("u-1", scn, at(1))).toEqual({ ok: false, error: "minutes_reserved" });
  });

  it("a plan the cap stops mid-call still needs one whole minute to start", async () => {
    expect(checkCap({ remaining: 0.5, plan: "pro" })).toEqual({ ok: false, error: "cap_reached" });
    expect(checkCap({ remaining: 1, plan: "pro" })).toEqual({ ok: true });
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 199.5;
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });
    allowanceOf("u-1").minutesUsed = 198.5;
    expect(await beginCall("u-1", scn, at(0))).toMatchObject({ ok: true, maxSeconds: 60 });
  });

  it("a half-minute support credit takes an account from 10 to 9.5 and lets it start a call", async () => {
    await freeUserWith(10);
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });
    fake.seed("user", { id: "admin-1", email: "a@example.test", isPlatformAdmin: true });
    mocks.authId = "admin-1";
    const res = await creditRoute(post("/api/usage/credit", { userId: "u-1", minutes: 0.5, reason: "Goodwill" }));
    expect(res.status).toBe(200);
    expect(allowanceOf("u-1").minutesUsed).toBe(9.5);
    expect(fake.rows("usageEntry")[0]).toMatchObject({ kind: "credit_manual", minutes: -0.5 });
    mocks.authId = "u-1";
    expect(await beginCall("u-1", scn, at(0))).toMatchObject({ ok: true });
    // Only half minutes are accepted.
    mocks.authId = "admin-1";
    expect((await creditRoute(post("/api/usage/credit", { userId: "u-1", minutes: 0.3, reason: "Goodwill" }))).status).toBe(400);
    expect(await creditManual({ targetUserId: "u-1", minutes: 1.5, actorId: "admin-1", reason: "Goodwill" }, at(5))).toMatchObject({ minutesUsed: 8 });
  });
});

describe("past the cap, the next voice call is refused", () => {
  const mint = () => realtimeSession(post("/api/realtime/session", { scenario }));

  it("3: at 10 or more used a voice start is refused with the upgrade and text prompt, and nothing is charged", async () => {
    for (const used of [10, 12]) {
      fake = createFakePrisma();
      mocks.fake = fake;
      await freeUserWith(used);
      const upstream = vi.fn();
      vi.stubGlobal("fetch", upstream);
      vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");

      expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });
      const res = await mint();
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("cap_reached");
      expect(body.message).toMatch(/Text/);
      expect(body.message).toMatch(/upgrade/i);

      // No provider session, no call row, no ledger entry, no change to the counters.
      expect(upstream).not.toHaveBeenCalled();
      expect(fake.rows("trainerSession")).toHaveLength(0);
      expect(fake.rows("usageEntry")).toHaveLength(0);
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: used, minutesReserved: 0 });
    }
  });

  it("4: usage at 10, then the next month boundary: usage is 0 and a call starts", async () => {
    await freeUserWith(10);
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });

    // The reset is on the signup anchor: the 10th at 12:00 UTC. One second earlier is still the old month.
    const before = await resolveAllowance(fake.db as never, "u-1", new Date("2026-11-10T11:59:59Z"));
    expect(before).toMatchObject({ remaining: 0 });
    expect(await beginCall("u-1", scn, new Date("2026-11-10T11:59:59Z"))).toEqual({ ok: false, error: "cap_reached" });

    const boundary = new Date("2026-11-10T12:00:00Z");
    const after = await resolveAllowance(fake.db as never, "u-1", boundary);
    expect(after?.allowance).toMatchObject({ minutesUsed: 0, minutesCap: 10 });
    expect(after?.allowance.periodStart.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(after?.remaining).toBe(10);
    expect(await beginCall("u-1", scn, boundary)).toMatchObject({ ok: true, remaining: 10 });
  });
});

describe("text practice is never capped", () => {
  it("5: at 10 or more used a text session starts, is graded and is saved, and writes no usage", async () => {
    await freeUserWith(12);

    const turn = await simulate(post("/api/simulate/turn", { scenario, history: [{ role: "user", text: "Hi, thanks for taking my call. Do you have a few minutes?" }] }));
    expect(turn.status).toBe(200);
    expect(((await turn.json()) as { reply?: string }).reply).toBeTruthy();

    const graded = await evaluate(post("/api/evaluate-call", { scenario, transcript }));
    expect(graded.status).toBe(200);
    const evaluation = await graded.json();
    expect(typeof evaluation.overallScore).toBe("number");

    const saved = await saveTranscript(post("/api/transcripts", { sessionId: "text-1", transcript, durationSeconds: 600, scenario: { id: scenario.id }, evaluation }));
    expect(saved.status).toBe(200);
    expect(fake.rows("trainerSession")[0]).toMatchObject({ billedMinutes: 0, billableSeconds: 0, connectedAt: null });
    expect(fake.rows("usageEntry")).toHaveLength(0);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 12, minutesReserved: 0 });

    // Voice is still refused while text keeps working.
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });
  });
});
