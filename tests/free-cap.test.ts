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

import { beginCall, endCall, ensureAllowance, heartbeat, resolveAllowance, usageSummary } from "@/lib/usage";
import { FREE_MINUTES, MAX_CALL_SECONDS, capFor } from "@/lib/usagePlan";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { POST as evaluate } from "@/app/api/evaluate-call/route";
import { POST as simulate } from "@/app/api/simulate/turn/route";

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
  it("2: a call started at 9 of 10 used runs 3 minutes with no cutoff, is graded and debriefed, and usage reads 12", async () => {
    // Minutes are whole and every started minute counts, so "9 of 10 used" is the closest start under the cap.
    await freeUserWith(9);
    const { begun, callId, answers, result } = await runCall("u-1", { endAt: 180 });

    // Past the minute the call held, the server never said stop and never clamped it.
    expect(begun.maxSeconds).toBe(MAX_CALL_SECONDS);
    expect(answers.length).toBeGreaterThan(10);
    for (const a of answers) expect(a).toMatchObject({ found: true, stop: false });
    expect(result).toMatchObject({ endReason: "user_hangup", billedMinutes: 3, creditedMinutes: 0 });
    expect(session(callId)).toMatchObject({ endReason: "user_hangup", billableSeconds: 180, billedMinutes: 3, abuseFlagged: false });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();

    // Every minute counts toward the month, above the cap.
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 12, minutesReserved: 0 });
    expect(await usageSummary("u-1", at(200))).toMatchObject({ minutesCap: 10, minutesUsed: 12, remaining: 0 });

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
