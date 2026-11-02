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
import { GET as purge } from "@/app/api/cron/purge-expired/route";

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
    expect(checkCap({ remaining: 0.5 })).toEqual({ ok: true });
    expect(checkCap({ remaining: 0 })).toEqual({ ok: false, error: "cap_reached" });
    const first = await beginCall("u-1", scn, at(0));
    expect(first).toMatchObject({ ok: true, remaining: 0.5, maxSeconds: MAX_CALL_SECONDS });
    expect(allowanceOf("u-1").minutesReserved).toBe(1);
    expect(await beginCall("u-1", scn, at(1))).toEqual({ ok: false, error: "minutes_reserved" });
  });

  it("Pro and Team start with any minutes left, like Free: what the screen shows is what the check enforces", async () => {
    expect(checkCap({ remaining: 0.5 })).toEqual({ ok: true });
    expect(checkCap({ remaining: 0.01 })).toEqual({ ok: true });
    expect(checkCap({ remaining: 0 })).toEqual({ ok: false, error: "cap_reached" });

    // Pro at 199.5 of 200: 0.5 minutes left, so the call starts. It holds one whole minute and is stopped at it.
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 199.5;
    expect(await resolveAllowance(fake.db as never, "u-1", at(0))).toMatchObject({ plan: "pro", remaining: 0.5 });
    const begun = await beginCall("u-1", scn, at(0));
    expect(begun).toMatchObject({ ok: true, remaining: 0.5, maxSeconds: 60 });
    if (!begun.ok) return;
    await heartbeat("u-1", begun.callId, "connected", at(0));
    expect(await heartbeat("u-1", begun.callId, "ok", at(30))).toMatchObject({ found: true, stop: false });
    // The cap still stops a Pro call: at its one reserved minute, billed that minute, nothing more.
    expect(await heartbeat("u-1", begun.callId, "ok", at(70))).toMatchObject({ found: true, stop: true, reason: "cap_reached" });
    expect(session(begun.callId)).toMatchObject({ billedMinutes: 1, endReason: "cap_reached" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 200.5, minutesReserved: 0 });
    // Now nothing is left, so the next start is refused.
    expect(await beginCall("u-1", scn, at(100))).toEqual({ ok: false, error: "cap_reached" });
  });

  it("a Team pool with half a minute left starts a call for a member, and a second start cannot take the same minute", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3 });
    addUser("u-1");
    addUser("u-2");
    await ensureAllowance(fake.db as never, { organizationId: "org-1" }, at(0));
    const pool = fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
    pool.minutesUsed = 899.5;
    expect(await beginCall("u-1", scn, at(0))).toMatchObject({ ok: true, remaining: 0.5, maxSeconds: 60 });
    expect(pool.minutesReserved).toBe(1);
    expect(await beginCall("u-2", scn, at(1))).toEqual({ ok: false, error: "minutes_reserved" });
  });

  it("a Pro user at exactly the cap is still refused", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 200;
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "cap_reached" });
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

describe("a Free call that goes silent keeps the time it was confirmed to have used", () => {
  /** Starts a call, heartbeats every 10 seconds for `confirmedSec`, then says nothing more. */
  async function goSilentAfter(confirmedSec: number) {
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    for (let t = 10; t < confirmedSec; t += 10) await heartbeat("u-1", begun.callId, "ok", at(t));
    return begun;
  }

  it("9.5 used, 3 minutes of heartbeats, then lost connection: the 3 minutes count, not just the 1 minute reserved", async () => {
    await freeUserWith(9.5);
    const begun = await goSilentAfter(180); // last heartbeat at 170 seconds
    expect(allowanceOf("u-1").minutesReserved).toBe(1);

    await usageSummary("u-1", at(600)); // the server notices the silence and settles the call
    const s = session(begun.callId);
    expect(s).toMatchObject({ endReason: "heartbeat_timeout", abuseFlagged: false });
    // Through the last heartbeat (170 s) plus the silent stretch bounded by the 1 minute reservation: 230 s, 4 minutes.
    expect(s.billableSeconds).toBe(230);
    expect(s.billedMinutes).toBe(4);
    expect(s.billedMinutes as number).toBeGreaterThanOrEqual(3);
    // The old rule clamped the whole call to its reservation: 1 minute, usage 10.5.
    expect(allowanceOf("u-1").minutesUsed).toBe(13.5);
    expect(allowanceOf("u-1").minutesUsed as number).toBeGreaterThan(10.5);
    expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 0 });
  });

  it("a longer confirmed call is counted in full, however long the silence that follows", async () => {
    await freeUserWith(9.5);
    const begun = await goSilentAfter(25 * 60); // 25 minutes of heartbeats, last at 1490 s
    await usageSummary("u-1", at(24 * 3600));
    const s = session(begun.callId);
    expect(s.billableSeconds).toBe(1490 + 60); // confirmed time plus at most the reservation
    expect(s.billedMinutes).toBe(26);
    expect(allowanceOf("u-1").minutesUsed).toBe(9.5 + 26);
  });

  it("a call that never sent a heartbeat is still bounded by its reservation", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await usageSummary("u-1", at(3 * 3600));
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 10 });
    expect(allowanceOf("u-1").minutesUsed).toBe(10);
  });
});

describe("a Free user at 9.5 of 10 used can start a voice call", () => {
  it("the realtime route mints a session and holds one minute, instead of answering cap_reached", async () => {
    await freeUserWith(9.5);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    const res = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.callId).toBeTruthy();
    expect(body.maxSeconds).toBe(MAX_CALL_SECONDS);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 9.5, minutesReserved: 1 });
  });

  it("any minutes left count as under the cap, and none left do not", async () => {
    for (const [used, ok] of [[9, true], [9.5, true], [9.99, true], [10, false], [13, false]] as const) {
      fake = createFakePrisma();
      mocks.fake = fake;
      await freeUserWith(used);
      expect((await beginCall("u-1", scn, at(0))).ok, `${used} of 10 used`).toBe(ok);
    }
  });
});

describe("a Team that ends does not give its members a fresh Free allowance", () => {
  const SEATS = { planTier: "team", seatCount: 3 };
  const downgrade = () => { fake.rows("organization")[0].planTier = "free"; };
  const downgradedAt = at(2 * 3600);

  async function setUpTeam() {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, ...SEATS });
    addUser("u-1");
    addUser("u-2");
  }

  it("a member who used 12 minutes of the pool this month is over the Free cap and cannot start a call", async () => {
    await setUpTeam();
    await runCall("u-1", { endAt: 12 * 60 }); // 12 minutes from the Team pool
    expect(fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")).toMatchObject({ minutesUsed: 12 });
    downgrade();

    const r = await resolveAllowance(fake.db as never, "u-1", downgradedAt);
    expect(r).toMatchObject({ plan: "free", pooled: false, usedElsewhere: 12, remaining: 0, available: 0 });
    expect(await usageSummary("u-1", downgradedAt)).toMatchObject({ plan: "free", minutesCap: 10, minutesUsed: 12, remaining: 0 });
    const before = fake.rows("trainerSession").length;
    expect(await beginCall("u-1", scn, downgradedAt)).toEqual({ ok: false, error: "cap_reached" });
    expect(fake.rows("trainerSession")).toHaveLength(before);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  it("a member who used 4 minutes keeps the other 6, and a member who used none has all 10", async () => {
    await setUpTeam();
    await runCall("u-1", { endAt: 4 * 60 });
    downgrade();
    expect(await resolveAllowance(fake.db as never, "u-1", downgradedAt)).toMatchObject({ usedElsewhere: 4, remaining: 6 });
    // Another member's pool usage is not this member's.
    expect(await resolveAllowance(fake.db as never, "u-2", downgradedAt)).toMatchObject({ usedElsewhere: 0, remaining: 10 });
    expect(await beginCall("u-1", scn, downgradedAt)).toMatchObject({ ok: true, remaining: 6 });
  });

  it("a Free call after the downgrade adds to the pool usage and is not counted twice", async () => {
    await setUpTeam();
    await runCall("u-1", { endAt: 4 * 60 });
    downgrade();
    const { callId } = await runCall("u-1", { start: 2 * 3600, endAt: 3 * 60 }); // 3 more minutes, now on the Free allowance
    expect(session(callId).billedMinutes).toBe(3);
    expect(allowanceOf("u-1").minutesUsed).toBe(3);
    expect(await usageSummary("u-1", at(3 * 3600))).toMatchObject({ minutesUsed: 7, remaining: 3 });
  });

  it("usage from before the current month is not carried", async () => {
    await setUpTeam();
    await runCall("u-1", { endAt: 12 * 60 });
    downgrade();
    // The personal month rolls over on Nov 10 at 12:00 UTC: the pool minutes belong to the month that ended.
    const nextMonth = new Date("2026-11-10T12:00:00Z");
    expect(await resolveAllowance(fake.db as never, "u-1", nextMonth)).toMatchObject({ usedElsewhere: 0, remaining: 10 });
    expect(await beginCall("u-1", scn, nextMonth)).toMatchObject({ ok: true });
  });

  it("a member who moves to Pro does not have pool minutes counted against the Pro cap", async () => {
    await setUpTeam();
    await runCall("u-1", { endAt: 12 * 60 });
    downgrade();
    fake.rows("user").find((u) => u.id === "u-1")!.planTier = "pro";
    expect(await resolveAllowance(fake.db as never, "u-1", downgradedAt)).toMatchObject({ plan: "pro", usedElsewhere: 0, remaining: 200 });
  });
});

describe("carried Team usage follows when the call ran, not when it was settled", () => {
  // The organization resets on the 20th at 12:00 UTC. Member u-1 resets on the 10th, member u-2 on the 25th.
  const ORG_ANCHOR = new Date("2026-03-20T12:00:00Z");
  const U2_ANCHOR = new Date("2026-03-25T12:00:00Z");
  const utc = (s: string) => new Date(`2026-${s}Z`);
  const AFTER = utc("11-12T12:00:00"); // a Free call is judged here: u-1's period is Nov 10 12:00 to Dec 10 12:00

  async function setUp() {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: ORG_ANCHOR, planTier: "team", seatCount: 3 });
    addUser("u-1");
    addUser("u-2", { usageAnchorAt: U2_ANCHOR });
  }
  /** A Team call that really ran from `start` for `seconds`. The ledger rows are written at settlement, whenever that is. */
  async function teamCall(userId: string, start: Date, seconds: number) {
    const begun = await beginCall(userId, scn, start);
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat(userId, begun.callId, "connected", start);
    await endCall(userId, begun.callId, "user_hangup", new Date(start.getTime() + seconds * 1000));
    return begun.callId;
  }
  const endTeam = () => { fake.rows("organization")[0].planTier = "free"; };
  const carried = async (userId: string, now = AFTER) => (await resolveAllowance(fake.db as never, userId, now))!;

  it("a 10 minute Team call with 5 minutes after the member's reset counts only 5 against Free", async () => {
    await setUp();
    const callId = await teamCall("u-1", utc("11-10T11:55:00"), 600); // 11:55 to 12:05, reset at 12:00
    // The organization's period did not change at the member's reset: all 10 minutes are in the pool.
    expect(fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")).toMatchObject({ minutesUsed: 10 });
    expect(session(callId)).toMatchObject({ billedMinutes: 10, billableSeconds: 600 });
    endTeam();

    const r = await carried("u-1");
    expect(r).toMatchObject({ plan: "free", pooled: false, usedElsewhere: 5, remaining: 5, available: 5 });
    expect(await usageSummary("u-1", AFTER)).toMatchObject({ minutesCap: 10, minutesUsed: 5, remaining: 5 });
    // 5 minutes are left, so the member is not refused.
    expect(await beginCall("u-1", scn, AFTER)).toMatchObject({ ok: true, remaining: 5 });
  });

  it("a call that ended before the member's reset counts nothing, however late it was settled", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T11:40:00"), 600); // 11:40 to 11:50
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 0, remaining: 10 });
    expect(await beginCall("u-1", scn, AFTER)).toMatchObject({ ok: true, remaining: 10 });
  });

  it("a call that ran entirely after the reset counts in full, and 10 of them refuse the next call", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T12:30:00"), 600);
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 10, remaining: 0 });
    expect(await beginCall("u-1", scn, AFTER)).toEqual({ ok: false, error: "cap_reached" });
  });

  it("a call that started before the reset and ran past it counts only the part after it", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T11:50:00"), 1200); // 20 minutes, 10 of them after the reset
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 10, remaining: 0 });
    expect(await beginCall("u-1", scn, AFTER)).toEqual({ ok: false, error: "cap_reached" });
  });

  it("calls add up by when they ran: 5 from the straddling call and 4 after the reset leave 1 minute", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T11:55:00"), 600);
    await teamCall("u-1", utc("11-10T13:00:00"), 240);
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 9, remaining: 1 });
    expect(await beginCall("u-1", scn, AFTER)).toMatchObject({ ok: true, remaining: 1 });
  });

  it("5 straddling minutes and 6 after the reset together are over the Free cap", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T11:55:00"), 600);
    await teamCall("u-1", utc("11-10T13:00:00"), 360);
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 11, remaining: 0 });
    expect(await beginCall("u-1", scn, AFTER)).toEqual({ ok: false, error: "cap_reached" });
  });

  it("members with different reset days are judged on their own month: the same pool call counts differently", async () => {
    await setUp();
    const at1155 = utc("11-10T11:55:00");
    await teamCall("u-1", at1155, 600);
    await teamCall("u-2", at1155, 600);
    endTeam();
    // u-1 resets at 12:00 that day: 5 of the 10 minutes are in its month.
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 5, remaining: 5 });
    // u-2's month runs Oct 25 to Nov 25, so all 10 minutes are in it.
    expect(await carried("u-2")).toMatchObject({ usedElsewhere: 10, remaining: 0 });
    expect(await beginCall("u-2", scn, AFTER)).toEqual({ ok: false, error: "cap_reached" });
  });

  it("the carry does not depend on when the ledger rows were written", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T11:55:00"), 600);
    endTeam();
    const answer = await carried("u-1");
    // Move every ledger row to a different day: nothing about the answer may change.
    for (const e of fake.rows("usageEntry")) e.createdAt = utc("12-01T00:00:00");
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: answer.usedElsewhere, remaining: answer.remaining });
    for (const e of fake.rows("usageEntry")) e.createdAt = utc("01-01T00:00:00");
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 5, remaining: 5 });
  });

  it("a support credit given on the pool this month lowers the carried minutes", async () => {
    await setUp();
    await teamCall("u-1", utc("11-10T12:30:00"), 600); // 10 minutes after the reset
    const pool = fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
    fake.seed("usageEntry", { userId: "u-1", allowanceId: pool.id, kind: "credit_manual", minutes: -4, createdAt: utc("11-11T09:00:00") });
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 6, remaining: 4 });
  });

  it("another member's pool calls are never counted, and a short credited drop counts nothing", async () => {
    await setUp();
    await teamCall("u-2", utc("11-10T12:30:00"), 600);
    const begun = await beginCall("u-1", scn, utc("11-10T13:00:00"));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", utc("11-10T13:00:00"));
    await endCall("u-1", begun.callId, "network_drop", utc("11-10T13:00:12")); // credited back, billed 0
    endTeam();
    expect(await carried("u-1")).toMatchObject({ usedElsewhere: 0, remaining: 10 });
  });

  describe("call timing is durable: the retention purge cannot hand minutes back", () => {
    const NOW = utc("11-14T12:00:00"); // inside u-1's month (Nov 10 12:00 to Dec 10 12:00)
    const callEntries = () => fake.rows("usageEntry").filter((e) => e.kind !== "credit_manual");

    /** Runs the real nightly purge with a 3 day retention window, as of Nov 14: Nov 10 calls are past it. */
    async function purgeOldCalls() {
      fake.rows("organization")[0].sessionRetentionDays = 3;
      vi.stubEnv("CRON_SECRET", "cron-test-secret-not-real");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(NOW);
      const res = await purge(new NextRequest("https://trainer.example/api/cron/purge-expired", { headers: { authorization: "Bearer cron-test-secret-not-real" } }));
      expect(res.status).toBe(200);
      vi.useRealTimers();
    }

    it("every call entry stores when the call ran, apart from the call row", async () => {
      await setUp();
      const callId = await teamCall("u-1", utc("11-10T11:55:00"), 600);
      const entries = callEntries().filter((e) => e.trainerSessionId === callId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "voice_call", minutes: 10 });
      expect((entries[0].ranFrom as Date).toISOString()).toBe("2026-11-10T11:55:00.000Z");
      expect((entries[0].ranTo as Date).toISOString()).toBe("2026-11-10T12:05:00.000Z");
    });

    it("a purged call keeps its carried 5 minutes: the member is not given those Free minutes back", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T11:55:00"), 600); // 5 minutes after the member's reset
      endTeam();
      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 5, remaining: 5 });
      const entriesBefore = callEntries().length;

      await purgeOldCalls();
      // The call row is gone and its ledger entry is unlinked, not deleted.
      expect(fake.rows("trainerSession").filter((s) => s.userId === "u-1")).toHaveLength(0);
      expect(callEntries()).toHaveLength(entriesBefore);
      expect(callEntries().every((e) => e.trainerSessionId === null)).toBe(true);

      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 5, remaining: 5, available: 5 });
      expect(await usageSummary("u-1", NOW)).toMatchObject({ minutesUsed: 5, remaining: 5 });
    });

    it("a purged call that used the whole Free allowance still refuses the next call", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T11:55:00"), 600); // 5 carried
      await teamCall("u-1", utc("11-10T13:00:00"), 360); // 6 carried, 11 in all
      endTeam();
      expect(await beginCall("u-1", scn, NOW)).toEqual({ ok: false, error: "cap_reached" });

      await purgeOldCalls();
      expect(fake.rows("trainerSession").filter((s) => s.userId === "u-1")).toHaveLength(0);
      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 11, remaining: 0 });
      expect(await beginCall("u-1", scn, NOW)).toEqual({ ok: false, error: "cap_reached" });
      expect(fake.rows("trainerSession").filter((s) => s.userId === "u-1")).toHaveLength(0); // nothing was started
    });

    it("the purge changes nothing about a call before the member's reset, a drop credit, or another member", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T11:30:00"), 600); // before the reset: 0
      await teamCall("u-2", utc("11-10T12:30:00"), 600); // someone else
      const dropped = await beginCall("u-1", scn, utc("11-10T13:00:00"));
      if (!dropped.ok) throw new Error(dropped.error);
      await heartbeat("u-1", dropped.callId, "connected", utc("11-10T13:00:00"));
      await endCall("u-1", dropped.callId, "network_drop", utc("11-10T13:00:12")); // billed 1, credited 1
      endTeam();
      const before = await carried("u-1", NOW);
      expect(before).toMatchObject({ usedElsewhere: 0, remaining: 10 });
      await purgeOldCalls();
      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 0, remaining: 10 });
      // u-2's month runs to Nov 25, so its 10 minutes are all in it, purged or not.
      expect(await carried("u-2", NOW)).toMatchObject({ usedElsewhere: 10, remaining: 0 });
    });

    it("a call that ran across the personal reset is prorated from its stored interval after the purge", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T11:50:00"), 1200); // 20 minutes, 10 of them after the reset
      endTeam();
      await purgeOldCalls();
      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 10, remaining: 0 });
    });

    it("support credits are unaffected by the purge, and untimed call entries from before the columns existed count by date written", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T12:30:00"), 600); // 10 minutes after the reset
      const pool = fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
      fake.seed("usageEntry", { userId: "u-1", allowanceId: pool.id, kind: "credit_manual", minutes: -4, createdAt: utc("11-11T09:00:00") });
      // A call entry written before ranFrom and ranTo existed, whose call row was already gone: no interval, so its date counts.
      fake.seed("usageEntry", { userId: "u-1", allowanceId: pool.id, kind: "voice_call", minutes: 3, createdAt: utc("11-11T10:00:00") });
      fake.seed("usageEntry", { userId: "u-1", allowanceId: pool.id, kind: "voice_call", minutes: 7, createdAt: utc("11-09T10:00:00") }); // last month
      endTeam();
      await purgeOldCalls();
      expect(await carried("u-1", NOW)).toMatchObject({ usedElsewhere: 9, remaining: 1 }); // 10 - 4 + 3
    });

    it("the carry is computed from the usage ledger and never reads call rows", async () => {
      await setUp();
      await teamCall("u-1", utc("11-10T11:55:00"), 600);
      endTeam();
      const reads: string[] = [];
      const table = fake.db.trainerSession as unknown as Record<string, (...a: unknown[]) => unknown>;
      for (const m of ["findMany", "findUnique", "findUniqueOrThrow"]) {
        const real = table[m].bind(table);
        table[m] = (...a: unknown[]) => { reads.push(m); return real(...a); };
      }
      // resolveAllowance itself does not touch call rows; settleStale (in beginCall) does, so only resolve here.
      expect(await resolveAllowance(fake.db as never, "u-1", NOW)).toMatchObject({ usedElsewhere: 5 });
      expect(reads).toEqual([]);
    });
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
