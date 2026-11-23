import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Free voice is 10 minutes a month. A voice start needs some of them left, and a running Free call is stopped at the Free
// minutes it reserved at its start plus FREE_END_GRACE_SECONDS, with a warning about a minute before. STR-715 (fc9bdb4)
// checked the cap only at the start and let a started Free call run up to 24 hours; that is reversed here, so the tests
// that pinned it now pin the mid-call cap and say why. Same fakes as usage-metering.test.ts:
// the database and the session check are replaced; metering, the ledger and the routes run for real.
const mocks = vi.hoisted(() => ({
  fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>,
  authId: "u-1",
  // When set, stands in for next/server after(); otherwise the real after() runs (and throws outside a request scope).
  after: null as null | ((task: () => unknown) => void),
}));
vi.mock("next/server", async (importOriginal) => {
  const real = await importOriginal<typeof import("next/server")>();
  return { ...real, after: (task: () => unknown) => (mocks.after ? mocks.after(task) : real.after(task as () => void)) };
});
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { FREE_ABANDON_REDUCED_MARKER, beginCall, checkCap, creditManual, endCall, ensureAllowance, freeAbandonClaimKey, heartbeat, resolveAllowance, usageSummary } from "@/lib/usage";
import { FREE_ABANDON_GRACE_SECONDS, FREE_ABANDON_REDUCED_PER_PERIOD, FREE_CAP_WARNING_SECONDS, FREE_END_GRACE_SECONDS, FREE_MINUTES, HEARTBEAT_TIMEOUT_SECONDS, MAX_CALL_SECONDS, callLimitSeconds, capFor, endGraceSeconds, exactCapStop, freeCapWarning, freeCapWarningReached } from "@/lib/usagePlan";
import { CAP_STOPPED_MESSAGE, FREE_CAP_STOPPED_MESSAGE, FREE_CAP_WARNING_MESSAGE, isCapMessage } from "@/lib/billingUi";
import { setPremiumEventSink, type PremiumEvent } from "@/lib/billingEvents";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { GET as elevenLabsToken } from "@/app/api/elevenlabs/token/route";
import { POST as heartbeatRoute } from "@/app/api/usage/heartbeat/route";
import { capReached } from "@/lib/usageResponses";
import { ghlPremiumSink, settleGhlEvents } from "@/lib/ghlWebhook";
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

/**
 * A voice call the way the real client runs it: heartbeats every 10 seconds until the server says stop or `endAt`, and on
 * a stop it hangs up at once (CallMeter stops heartbeating and the call ends through the hang-up path).
 */
async function callUntilStopped(userId: string, o: { endAt: number }) {
  const begun = await beginCall(userId, scn, at(0));
  if (!begun.ok) throw new Error(begun.error);
  const connected = await heartbeat(userId, begun.callId, "connected", at(0));
  const answers: Array<Awaited<ReturnType<typeof heartbeat>> & { t: number }> = [];
  let t = 10;
  for (; t < o.endAt; t += 10) {
    const a = await heartbeat(userId, begun.callId, "ok", at(t));
    answers.push({ ...a, t });
    if (a.found && a.stop) break;
  }
  const result = await endCall(userId, begun.callId, "user_hangup", at(Math.min(t, o.endAt)));
  const stop = answers.find((a) => a.found && a.stop);
  return { begun, callId: begun.callId, connected, answers, stop, result: result! };
}

const post =(url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
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
  mocks.after = null;
  // billing.ts registers the GHL premium sink on import; tests that check events set their own sink.
  setPremiumEventSink(null);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
  // No model keys: grading and the text caller use their rules-based fallbacks, with no network.
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  // Routes such as /api/realtime/session and /api/usage/credit call new Date() themselves. Freeze Date at T0
  // (inside the seeded October period) so a real calendar rollover on the 10th cannot open a new allowance.
  // Only Date is faked: timers and promises keep running. (Same fix as draft #78.)
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
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

describe("a running Free call is stopped at its Free minutes plus the end grace", () => {
  it("the grace and warning constants, and the pure limit and warning rules", () => {
    // 20 s: up to 10 s of heartbeat lag plus time to finish a sentence, and still under half a minute (see usagePlan.ts).
    expect(FREE_END_GRACE_SECONDS).toBeGreaterThanOrEqual(15);
    expect(FREE_END_GRACE_SECONDS).toBeLessThanOrEqual(30);
    expect(FREE_CAP_WARNING_SECONDS).toBe(60);
    expect(exactCapStop("free")).toBe(false);
    expect(exactCapStop("pro")).toBe(true);
    expect(exactCapStop("team")).toBe(true);
    expect(endGraceSeconds(false)).toBe(FREE_END_GRACE_SECONDS);
    expect(endGraceSeconds(true)).toBe(0);

    // Free: remaining minutes * 60 + grace. Paid: exactly the reservation, as before.
    expect(callLimitSeconds(10, false)).toBe(10 * 60 + FREE_END_GRACE_SECONDS);
    expect(callLimitSeconds(1, false)).toBe(60 + FREE_END_GRACE_SECONDS);
    expect(callLimitSeconds(10, true)).toBe(600);
    expect(callLimitSeconds(60, true)).toBe(3600);
    // Never past the call length limit, and never negative.
    expect(callLimitSeconds(MAX_CALL_SECONDS, false)).toBe(MAX_CALL_SECONDS);
    expect(callLimitSeconds(MAX_CALL_SECONDS, true)).toBe(MAX_CALL_SECONDS);
    expect(callLimitSeconds(-3, false)).toBe(FREE_END_GRACE_SECONDS);

    // Warned from 60 s of Free minutes left (secondsLeft counts the grace too) until the stop, inside the grace included.
    const g = FREE_END_GRACE_SECONDS;
    expect(freeCapWarning(g + 61)).toBe(false);
    expect(freeCapWarning(g + 60)).toBe(true);
    expect(freeCapWarning(g + 1)).toBe(true);
    expect(freeCapWarning(g)).toBe(true);
    expect(freeCapWarning(1)).toBe(true);
    expect(freeCapWarning(0)).toBe(false);
  });

  it("beginCall: a Free call's maxSeconds is its remaining minutes * 60 plus the grace, never 86400, and paid is unchanged", async () => {
    for (const [used, minutes] of [[0, 10], [4, 6], [9, 1]] as const) {
      fake = createFakePrisma();
      mocks.fake = fake;
      await freeUserWith(used);
      const begun = await beginCall("u-1", scn, at(0));
      expect(begun, `${used} of 10 used`).toMatchObject({ ok: true, remaining: minutes, maxSeconds: minutes * 60 + FREE_END_GRACE_SECONDS });
      if (!begun.ok) continue;
      expect(begun.maxSeconds).not.toBe(MAX_CALL_SECONDS);
      expect(begun.maxSeconds).toBeLessThanOrEqual(MAX_CALL_SECONDS);
      expect(session(begun.callId)).toMatchObject({ capEnforced: false, reservedMinutes: minutes });
    }
    // Pro: exactly the reservation, no grace, as before.
    fake = createFakePrisma();
    mocks.fake = fake;
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 196;
    const pro = await beginCall("u-1", scn, at(0));
    expect(pro).toMatchObject({ ok: true, maxSeconds: 240 });
    if (pro.ok) expect(session(pro.callId).capEnforced).toBe(true);
  });

  it("2: a call started at 9.5 of 10 used is stopped at its one reserved minute plus the grace, billed that minute, then graded and debriefed", async () => {
    await freeUserWith(9.5);
    const start = await resolveAllowance(fake.db as never, "u-1", at(0));
    expect(start).toMatchObject({ remaining: 0.5, available: 0.5 });
    const { begun, callId, connected, answers, stop, result } = await callUntilStopped("u-1", { endAt: 180 });

    // Reservations are whole minutes, so half a minute left holds (and may use) one minute, plus the end grace.
    expect(begun.maxSeconds).toBe(60 + FREE_END_GRACE_SECONDS);
    expect(stop).toMatchObject({ t: 60 + FREE_END_GRACE_SECONDS, found: true, stop: true, reason: "cap_reached", freeCap: true });
    // The warning came first, once: under a minute of Free minutes was left from the start, so the first heartbeat
    // (the "connected" one) carried it and no later one did.
    expect(connected).toMatchObject({ found: true, stop: false, capWarning: true });
    expect(answers.filter((a) => "capWarning" in a)).toEqual([]);
    // The grace is not billed: 80 s ran, 60 s and 1 minute are charged.
    expect(result).toMatchObject({ endReason: "cap_reached", billedMinutes: 1, creditedMinutes: 0, billableSeconds: 60 });
    expect(session(callId)).toMatchObject({ endReason: "cap_reached", billableSeconds: 60, billedMinutes: 1, abuseFlagged: false });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
    // Billing is in whole started minutes, so a call that starts on a half minute adds a whole one (as on Pro and Team).
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10.5, minutesReserved: 0 });
    expect(await usageSummary("u-1", at(200))).toMatchObject({ minutesCap: 10, remaining: 0 });

    // The debrief path is open: the cap-stopped call is graded and its transcript is saved against the metered call.
    const graded = await evaluate(post("/api/evaluate-call", { scenario, transcript }));
    expect(graded.status).toBe(200);
    const evaluation = await graded.json();
    expect(typeof evaluation.overallScore).toBe("number");
    const saved = await saveTranscript(post("/api/transcripts", { sessionId: "voice-1", callId, transcript, durationSeconds: 80, scenario: { id: scenario.id }, evaluation }));
    expect(saved.status).toBe(200);
    expect(session(callId).transcript).toHaveLength(transcript.length);
    expect(session(callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 1 });
  });

  it("a Free call is stopped at its cap plus the grace and never billed past the allowance (this reverses STR-715)", async () => {
    // STR-715 pinned "a Free call that runs far past the cap is never stopped or flagged, and all of it counts": a Free
    // call minted with maxSeconds 86400 could run a whole day (Funnel's finding) and push usage far past 10 minutes.
    // The Free cap now applies mid-call: the server stops the call at what it reserved plus the end grace, and billing
    // clamps it to the reservation, so usage ends at exactly the allowance.
    await freeUserWith(9);
    const { callId, answers, stop, result } = await callUntilStopped("u-1", { endAt: 40 * 60 });
    expect(stop).toMatchObject({ t: 80, reason: "cap_reached", freeCap: true });
    expect(answers.filter((a) => a.found && a.stop)).toHaveLength(1);
    expect(result).toMatchObject({ endReason: "cap_reached", billedMinutes: 1, billableSeconds: 60 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
    // A client that hangs up when told is not an overrun.
    expect(session(callId).abuseFlagged).toBe(false);
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
    // Every later heartbeat answers "ended", never a second cap_reached.
    expect(await heartbeat("u-1", callId, "ok", at(90))).toMatchObject({ found: true, stop: true, reason: "ended" });
    // The next voice start is refused: the allowance is used up.
    expect(await beginCall("u-1", scn, at(120))).toEqual({ ok: false, error: "cap_reached" });
  });

  it("a Free browser that keeps reporting long after the stop is flagged, like a paid one", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toMatchObject({ stop: true, reason: "cap_reached" });
    expect(await heartbeat("u-1", begun.callId, "ok", at(120))).toMatchObject({ stop: true, reason: "ended" });
    expect(session(begun.callId).abuseFlagged).toBe(false); // within the overrun grace
    await heartbeat("u-1", begun.callId, "ok", at(80 + 61 + 10));
    expect(session(begun.callId).abuseFlagged).toBe(true);
    expect(session(begun.callId).billedMinutes).toBe(1); // flagging never changes the bill
  });

  it("an end event that arrives after the cap, with the stop heartbeat missed, is still billed only the allowance", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    for (let t = 10; t <= 600; t += 10) await heartbeat("u-1", begun.callId, "ok", at(t));
    // The heartbeat at 610 and 620 never arrived (network); the rep hangs up at 625.
    const result = await endCall("u-1", begun.callId, "user_hangup", at(625));
    expect(result).toMatchObject({ endReason: "cap_reached", billedMinutes: 10, billableSeconds: 600 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: FREE_MINUTES, minutesReserved: 0 });
    expect(session(begun.callId).abuseFlagged).toBe(false);
  });

  it("heartbeat: no warning early, the warning from 60 s of Free minutes left, then one cap_reached stop at 10 minutes plus the grace", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const limit = 600 + FREE_END_GRACE_SECONDS;
    await heartbeat("u-1", begun.callId, "connected", at(0));
    const early = await heartbeat("u-1", begun.callId, "ok", at(530));
    expect(early).toEqual({ found: true, stop: false, secondsLeft: limit - 530 });
    // 540 s in: 60 s of Free minutes left (80 s with the grace).
    expect(await heartbeat("u-1", begun.callId, "ok", at(540))).toEqual({ found: true, stop: false, secondsLeft: limit - 540, capWarning: true });
    // Sent once: the later heartbeats, inside the window and inside the grace (allowance already at 0), carry no warning.
    for (const t of [550, 600, 610]) expect(await heartbeat("u-1", begun.callId, "ok", at(t))).toEqual({ found: true, stop: false, secondsLeft: limit - t });
    const stopped = await heartbeat("u-1", begun.callId, "ok", at(limit));
    expect(stopped).toMatchObject({ found: true, stop: true, reason: "cap_reached", freeCap: true });
    expect(session(begun.callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 10, billableSeconds: 600 });
    expect(await heartbeat("u-1", begun.callId, "ok", at(limit + 10))).toMatchObject({ stop: true, reason: "ended" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
  });

  it("a lost stop answer: every later heartbeat of a Free cap-stopped call still says freeCap (reason ended); paid and silent ones do not", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    // This answer never reaches the client.
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toMatchObject({ stop: true, reason: "cap_reached", freeCap: true });
    for (const t of [90, 100]) {
      expect(await heartbeat("u-1", begun.callId, "ok", at(t))).toEqual({ found: true, stop: true, reason: "ended", settlement: null, freeCap: true });
    }

    // A paid cap stop's later answers carry no freeCap (the paid client path is unchanged).
    addUser("u-2", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-2" }, at(0));
    allowanceOf("u-2").minutesUsed = 199;
    const pro = await beginCall("u-2", scn, at(0));
    if (!pro.ok) throw new Error(pro.error);
    await heartbeat("u-2", pro.callId, "connected", at(0));
    expect(await heartbeat("u-2", pro.callId, "ok", at(60))).toMatchObject({ reason: "cap_reached" });
    expect(await heartbeat("u-2", pro.callId, "ok", at(70))).toEqual({ found: true, stop: true, reason: "ended", settlement: null });

    // A Free call reaped as silent was not stopped at the cap, so it carries no freeCap either.
    addUser("u-3");
    const quiet = await beginCall("u-3", scn, at(0));
    if (!quiet.ok) throw new Error(quiet.error);
    await heartbeat("u-3", quiet.callId, "connected", at(0));
    await usageSummary("u-3", at(300));
    expect(session(quiet.callId).endReason).toBe("heartbeat_timeout");
    expect(await heartbeat("u-3", quiet.callId, "ok", at(301))).toEqual({ found: true, stop: true, reason: "ended", settlement: null });
  });

  it("an overlapping heartbeat that read the call open while another one stopped it still answers freeCap", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    const before = { ...session(begun.callId) }; // what the overlapping heartbeat read: still open
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toMatchObject({ reason: "cap_reached", freeCap: true });
    const reads = vi.spyOn(fake.db.trainerSession as unknown as { findUnique: (...a: unknown[]) => unknown }, "findUnique");
    reads.mockImplementationOnce(async () => before);
    // Its write finds the row closed, so it answers "ended", and reads how the call ended to keep freeCap.
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toEqual({ found: true, stop: true, reason: "ended", settlement: null, freeCap: true });
    reads.mockRestore();
    expect(session(begun.callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 1 });
  });

  it("paid calls are unchanged: no warning, no grace, stopped exactly at the reservation", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 198;
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    expect(begun.maxSeconds).toBe(120);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    expect(await heartbeat("u-1", begun.callId, "ok", at(70))).toEqual({ found: true, stop: false, secondsLeft: 50 });
    expect(await heartbeat("u-1", begun.callId, "ok", at(119))).toEqual({ found: true, stop: false, secondsLeft: 1 });
    const stopped = await heartbeat("u-1", begun.callId, "ok", at(120));
    expect(stopped).toMatchObject({ found: true, stop: true, reason: "cap_reached" });
    expect(stopped).not.toHaveProperty("freeCap");
    expect(session(begun.callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 2 });
  });

  it("a plan change mid-call does not change the rule the call started under", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    expect(session(begun.callId).capEnforced).toBe(false);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    fake.rows("user")[0].planTier = "pro"; // upgraded while the call is running
    // Still the Free rule: past its 10 reserved minutes it keeps the end grace (a Pro call would have stopped at 600 s)...
    expect(await heartbeat("u-1", begun.callId, "ok", at(610))).toMatchObject({ found: true, stop: false, capWarning: true });
    // ...and it stops at the Free limit, billed the 10 minutes it reserved.
    expect(await heartbeat("u-1", begun.callId, "ok", at(620))).toMatchObject({ found: true, stop: true, reason: "cap_reached", freeCap: true });
    expect(session(begun.callId).billedMinutes).toBe(10);
  });

  it("a Free call minted before this change (capEnforced false, 24 hour deadline) is stopped by its next heartbeat, billed its reservation and not flagged", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    // The deploy lands 30 minutes into the call: its first heartbeat after it stops the call.
    const r = await heartbeat("u-1", begun.callId, "ok", at(30 * 60));
    expect(r).toMatchObject({ found: true, stop: true, reason: "cap_reached", freeCap: true });
    // The client hangs up when told: the end event and a straggling heartbeat seconds later are not an overrun.
    await endCall("u-1", begun.callId, "user_hangup", at(30 * 60 + 2));
    await heartbeat("u-1", begun.callId, "ok", at(30 * 60 + 10));
    expect(session(begun.callId)).toMatchObject({ billedMinutes: 10, abuseFlagged: false });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
    // Still reporting more than a minute after the server's stop is an overrun, as for a paid call.
    await heartbeat("u-1", begun.callId, "ok", at(30 * 60 + 75));
    expect(session(begun.callId).abuseFlagged).toBe(true);
  });

  it("a Free client whose stop heartbeat arrives late and then hangs up at once is not flagged or blocked", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    // Heartbeats were lost on the network until 10 minutes in; that one gets the stop and the client ends the call.
    expect(await heartbeat("u-1", begun.callId, "ok", at(600))).toMatchObject({ stop: true, reason: "cap_reached" });
    await endCall("u-1", begun.callId, "user_hangup", at(601));
    expect(session(begun.callId)).toMatchObject({ billedMinutes: 1, abuseFlagged: false });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
  });
});

describe("the Free 1 minute warning goes out once per call", () => {
  const limit = 600 + FREE_END_GRACE_SECONDS;
  const warned = (answers: Array<Awaited<ReturnType<typeof heartbeat>>>) => answers.filter((a) => a.found && !a.stop && a.capWarning);

  it("a whole call heartbeating every 10 s gets the warning on the crossing heartbeat only", async () => {
    await freeUserWith(0);
    const { connected, answers, stop } = await callUntilStopped("u-1", { endAt: 40 * 60 });
    expect(connected).toEqual({ found: true, stop: false, secondsLeft: limit });
    expect(stop).toMatchObject({ t: limit, reason: "cap_reached", freeCap: true });
    // 540 s in is the first heartbeat inside the window (60 s of Free minutes left); nothing before or after it warns.
    expect(answers.filter((a) => "capWarning" in a).map((a) => a.t)).toEqual([540]);
    expect(answers.filter((a) => a.found && !a.stop && a.t > 540).length).toBeGreaterThan(0);
  });

  it("a call that starts inside the window warns once, on its first heartbeat", async () => {
    await freeUserWith(9); // 1 Free minute left: 60 s plus the grace, inside the window from the start
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const answers = [await heartbeat("u-1", begun.callId, "connected", at(0))];
    for (const t of [10, 20, 30, 40, 50, 60, 70]) answers.push(await heartbeat("u-1", begun.callId, "ok", at(t)));
    expect(answers[0]).toEqual({ found: true, stop: false, secondsLeft: 80, capWarning: true });
    expect(warned(answers)).toHaveLength(1);
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toMatchObject({ stop: true, reason: "cap_reached", freeCap: true });
  });

  // The races below run heartbeats concurrently (Promise.all) with the fake's row locks on, so overlapping heartbeats
  // really contend for the call row's FOR UPDATE lock the way they do in Postgres.
  async function lockedCall(used: number, ...times: number[]) {
    await freeUserWith(used);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    for (const t of times) await heartbeat("u-1", begun.callId, t === 0 ? "connected" : "ok", at(t));
    fake.enableRowLocks();
    return begun.callId;
  }
  const beatAt = (callId: string, t: number, state: "connected" | "ok" | "recovering" = "ok") => heartbeat("u-1", callId, state, at(t));

  it("each heartbeat locks the call row, and overlapping heartbeats give one warning", async () => {
    const callId = await lockedCall(0, 0, 530);
    const [a, b] = await Promise.all([beatAt(callId, 541), beatAt(callId, 545)]);
    expect([a, b]).toEqual([
      { found: true, stop: false, secondsLeft: limit - 541, capWarning: true },
      { found: true, stop: false, secondsLeft: limit - 545 },
    ]);
    expect(session(callId).lastHeartbeatAt).toEqual(at(545));
    expect(fake.rawQueries).toContainEqual({ sql: 'SELECT "id" FROM "TrainerSession" WHERE "id" = ? FOR UPDATE', values: [callId] });
    expect(await beatAt(callId, 560)).toEqual({ found: true, stop: false, secondsLeft: limit - 560 });
  });

  it("overlapping heartbeats with the same time give one warning", async () => {
    const callId = await lockedCall(0, 0, 530);
    const answers = await Promise.all([beatAt(callId, 545), beatAt(callId, 545), beatAt(callId, 545)]);
    expect(warned(answers)).toHaveLength(1);
    expect(answers.every((a) => a.found && !a.stop && a.secondsLeft === limit - 545)).toBe(true);
    expect(session(callId).lastHeartbeatAt).toEqual(at(545));
    expect(await beatAt(callId, 555)).toEqual({ found: true, stop: false, secondsLeft: limit - 555 });
  });

  it("an older heartbeat that arrives after a newer one does not move lastHeartbeatAt back, so no second warning", async () => {
    const callId = await lockedCall(0, 0, 530);
    expect(await beatAt(callId, 545)).toMatchObject({ capWarning: true });
    // Sent at 538 s (outside the window), delivered after the 545 s one: answered for its own time, no warning.
    expect(await beatAt(callId, 538, "recovering")).toEqual({ found: true, stop: false, secondsLeft: limit - 538 });
    expect(session(callId).lastHeartbeatAt).toEqual(at(545));
    // Had lastHeartbeatAt gone back to 538 s, this one would cross into the window again.
    expect(await beatAt(callId, 555)).toEqual({ found: true, stop: false, secondsLeft: limit - 555 });
    // Concurrently, in either order, too.
    const answers = await Promise.all([beatAt(callId, 570), beatAt(callId, 565)]);
    expect(warned(answers)).toEqual([]);
    expect(session(callId).lastHeartbeatAt).toEqual(at(570));
  });

  for (const order of [["ok", "connected"], ["connected", "ok"]] as const) {
    it(`a connected heartbeat concurrent with an ok one at the same time still records connectedAt (${order.join(" first, ")})`, async () => {
      const callId = await lockedCall(0);
      const answers = await Promise.all(order.map((state) => beatAt(callId, 5, state)));
      expect(answers).toEqual([{ found: true, stop: false, secondsLeft: limit }, { found: true, stop: false, secondsLeft: limit }]);
      expect(session(callId)).toMatchObject({ connectedAt: at(5), lastHeartbeatAt: at(5) });
      // The deadline runs from the recorded connection, not from the mint-time cutoff.
      expect(await beatAt(callId, 15)).toEqual({ found: true, stop: false, secondsLeft: limit - 10 });
      expect(await beatAt(callId, 5 + limit)).toMatchObject({ stop: true, reason: "cap_reached", freeCap: true });
    });
  }

  it("two connected heartbeats at once keep the first recorded connection time", async () => {
    const callId = await lockedCall(0);
    const [first, second] = await Promise.all([beatAt(callId, 3, "connected"), beatAt(callId, 5, "connected")]);
    expect(first).toEqual({ found: true, stop: false, secondsLeft: limit });
    expect(second).toEqual({ found: true, stop: false, secondsLeft: limit - 2 });
    expect(session(callId)).toMatchObject({ connectedAt: at(3), lastHeartbeatAt: at(5) });
  });

  it("sustained contention never drops the newest heartbeat, and the warning still goes out once", async () => {
    const callId = await lockedCall(0, 0, 100);
    // 40 heartbeats from 110 s to 500 s and 18 more from 505 s to 590 s (across the window at 540 s), all at once and
    // in a scrambled order.
    const times = [...Array.from({ length: 40 }, (_, i) => 110 + i * 10), ...Array.from({ length: 18 }, (_, i) => 505 + i * 5)]
      .sort((x, y) => ((x * 7919) % 101) - ((y * 7919) % 101));
    const answers = await Promise.all(times.map((t) => beatAt(callId, t)));
    expect(answers.map((a) => (a.found && !a.stop ? a.secondsLeft : null))).toEqual(times.map((t) => limit - t));
    expect(warned(answers)).toHaveLength(1);
    expect(session(callId).lastHeartbeatAt).toEqual(at(Math.max(...times)));
    // The silence timeout runs from the newest heartbeat: the call is not reaped before it.
    await usageSummary("u-1", at(Math.max(...times) + HEARTBEAT_TIMEOUT_SECONDS - 1));
    expect(session(callId).endedAt ?? null).toBeNull();
  });

  it("an older in-window heartbeat that arrives after a deadline heartbeat does not warn a second time", async () => {
    const callId = await lockedCall(0, 0, 530);
    // In the window (75 s left, 55 s of Free minutes): the one warning.
    expect(await beatAt(callId, 545)).toEqual({ found: true, stop: false, secondsLeft: limit - 545, capWarning: true });
    // The deadline heartbeat (625 s) records its time and stops the call after it commits; the older heartbeat (600 s,
    // in the window) takes the call row in between and sees the stored 625 s, which has reached the window too.
    const answers = await Promise.all([beatAt(callId, 625), beatAt(callId, 600)]);
    expect(warned(answers)).toEqual([]);
    expect(answers.filter((a) => a.found && a.stop && a.reason === "cap_reached")).toHaveLength(1);
    expect(session(callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 10, lastHeartbeatAt: at(625) });
  });

  it("a call never warned before gets no warning from an older heartbeat behind its deadline heartbeat", async () => {
    const callId = await lockedCall(0, 0, 530);
    const answers = await Promise.all([beatAt(callId, 625), beatAt(callId, 600)]);
    expect(warned(answers)).toEqual([]);
    expect(answers.filter((a) => a.found && a.stop && a.reason === "cap_reached")).toHaveLength(1);
  });

  it("an ok heartbeat before the call connected never warns; after connecting the crossing warns once", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    // Codex's sequence: an ok heartbeat at 540 s with no connectedAt yet, then "connected" at 550 s.
    const early = await heartbeat("u-1", begun.callId, "ok", at(540));
    expect(early).toMatchObject({ found: true, stop: false });
    expect(early).not.toHaveProperty("capWarning");
    expect(session(begun.callId).connectedAt ?? null).toBeNull();
    const connected = await heartbeat("u-1", begun.callId, "connected", at(550));
    expect(session(begun.callId).connectedAt).toEqual(at(550));
    // The billing start is min(connectedAt, mint + 60 s) = 60 s: recording connectedAt never moves it later.
    expect(connected).toEqual({ found: true, stop: false, secondsLeft: limit - (550 - 60) });
    const times = [550];
    const answers = [connected];
    for (let t = 560; t <= 1090; t += 10) { times.push(t); answers.push(await heartbeat("u-1", begun.callId, "ok", at(t))); }
    // The window opens at 80 s left (600 s on this timeline): one warning there, none after, through 1090 s.
    expect(warned(answers)).toEqual([{ found: true, stop: false, secondsLeft: 80, capWarning: true }]);
    expect(times.filter((_, i) => answers[i].found && !answers[i].stop && answers[i].capWarning)).toEqual([600]);
    expect(answers.filter((a) => a.found && a.stop && a.reason === "cap_reached")).toHaveLength(1);
  });

  it("a call inside the window from its start warns on the heartbeat that connects it, not before, and only once", async () => {
    await freeUserWith(9); // 1 Free minute: 80 s with the grace, inside the window from the start
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    // Before connecting (billing start would be the 60 s cutoff, 80 s left): no warning without connectedAt.
    expect(await heartbeat("u-1", begun.callId, "ok", at(30))).toEqual({ found: true, stop: false, secondsLeft: 80 });
    // Connecting at 40 s fixes the start at 40 s: still 80 s left, the warning goes out here.
    const answers = [await heartbeat("u-1", begun.callId, "connected", at(40))];
    expect(answers[0]).toEqual({ found: true, stop: false, secondsLeft: 80, capWarning: true });
    for (let t = 50; t <= 130; t += 10) answers.push(await heartbeat("u-1", begun.callId, "ok", at(t)));
    expect(warned(answers)).toHaveLength(1);
    expect(answers.find((a) => a.found && a.stop)).toMatchObject({ reason: "cap_reached", freeCap: true });
  });

  it("the window, once reached, stays reached, the deadline included", () => {
    // secondsLeft includes the 20 s end grace: the window opens at 80 s left.
    expect([81, 80, 1, 0, -5].map(freeCapWarningReached)).toEqual([false, true, true, true, true]);
    expect([81, 80, 1, 0, -5].map(freeCapWarning)).toEqual([false, true, true, false, false]);
  });

  it("overlapping heartbeats at the deadline stop the call once", async () => {
    const callId = await lockedCall(9, 0, 70);
    const answers = await Promise.all([beatAt(callId, 75), beatAt(callId, 80), beatAt(callId, 80)]);
    expect(answers.filter((a) => a.found && a.stop && a.reason === "cap_reached")).toHaveLength(1);
    expect(session(callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 1, billableSeconds: 60, lastHeartbeatAt: at(80) });
  });

  it("paid calls never warn, from the first heartbeat to the stop", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 199; // 1 Pro minute left: inside the Free window, were it a Free call
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const answers = [await heartbeat("u-1", begun.callId, "connected", at(0))];
    for (const t of [10, 20, 30, 40, 50]) answers.push(await heartbeat("u-1", begun.callId, "ok", at(t)));
    expect(answers.filter((a) => "capWarning" in a)).toEqual([]);
    expect(await heartbeat("u-1", begun.callId, "ok", at(60))).toEqual(expect.objectContaining({ stop: true, reason: "cap_reached" }));
  });
});

describe("heartbeat lock order: the call-row lock is never held while another row is used", () => {
  const LOCK_CALL = 'raw:SELECT "id" FROM "TrainerSession" WHERE "id" = ? FOR UPDATE';
  /** Each transaction that took the call-row lock, with every operation it ran. */
  const lockTransactions = () => {
    const txs = new Set(fake.ops.filter((o) => o.op === LOCK_CALL).map((o) => o.tx));
    return [...txs].map((tx) => ({ tx, ops: fake.ops.filter((o) => o.tx === tx).map((o) => o.op) }));
  };
  const onlyTheCallRow = (ops: string[]) =>
    ops.filter((o) => !["begin", "commit", "rollback", LOCK_CALL].includes(o) && !o.startsWith("trainerSession.") && !/^(lock|wait):trainerSession:/.test(o));

  it("every heartbeat's lock transaction reads and writes only the call row, and the stop settles after it committed", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    for (const t of [10, 20, 30, 40, 50, 60, 70]) await heartbeat("u-1", begun.callId, "ok", at(t));
    const before = fake.ops.length;
    expect(await heartbeat("u-1", begun.callId, "ok", at(80))).toMatchObject({ stop: true, reason: "cap_reached", freeCap: true });
    // Well past the reservation: the overrun flag (user and audit writes) also runs outside the lock.
    expect(await heartbeat("u-1", begun.callId, "ok", at(80 + 61 + 10))).toMatchObject({ stop: true, reason: "ended" });
    expect(session(begun.callId).abuseFlagged).toBe(true);

    const locked = lockTransactions();
    expect(locked).toHaveLength(10);
    for (const { ops } of locked) expect(onlyTheCallRow(ops)).toEqual([]); // no allowance, user, ledger or audit access, no other lock

    // The stopping heartbeat: its lock transaction committed before the settlement touched the allowance and the ledger.
    const stop = fake.ops.slice(before);
    const lockTx = stop.find((o) => o.op === LOCK_CALL)!.tx;
    const committed = stop.findIndex((o) => o.tx === lockTx && o.op === "commit");
    const settled = stop.findIndex((o) => o.op === "usageAllowance.updateMany");
    expect(committed).toBeGreaterThanOrEqual(0);
    expect(settled).toBeGreaterThan(committed);
    expect(stop[settled].tx).not.toBe(lockTx);
    expect(stop.filter((o) => o.op === "usageEntry.create").every((o) => o.tx !== lockTx)).toBe(true);
    expect(session(begun.callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 1, billableSeconds: 60 });
  });

  it("a rollover that holds the allowance row and then waits for the call row does not deadlock with a stopping heartbeat", async () => {
    await freeUserWith(9);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    await heartbeat("u-1", begun.callId, "ok", at(70));
    fake.enableRowLocks();
    const allowanceId = allowanceOf("u-1").id;
    const tick = () => new Promise<void>((r) => setImmediate(r));

    // The moment the heartbeat holds the call row, the rollover (already holding the allowance) asks for it too; the
    // heartbeat goes on only after that request is waiting. This is the interleaving that deadlocked when the settlement
    // ran inside the locked transaction: heartbeat holds the call and wants the allowance, rollover the reverse.
    let heartbeatHasCallRow!: () => void;
    const callRowTaken = new Promise<void>((r) => { heartbeatHasCallRow = r; });
    const raw = fake.db.$queryRaw;
    fake.db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const out = await raw(strings, ...values);
      if (strings.join("?").includes('FROM "TrainerSession"')) { heartbeatHasCallRow(); await tick(); }
      return out;
    };

    // The rollover's lock order: the allowance row first, then the call row (where it writes the carry).
    let rolloverHasAllowance!: () => void;
    const allowanceTaken = new Promise<void>((r) => { rolloverHasAllowance = r; });
    const rollover = (fake.db.$transaction as (fn: (tx: typeof fake.db) => Promise<void>) => Promise<void>)(async (tx) => {
      await tx.usageAllowance.updateMany({ where: { id: allowanceId }, data: { version: { increment: 1 } } });
      rolloverHasAllowance();
      await callRowTaken;
      await tx.trainerSession.updateMany({ where: { id: begun.callId }, data: { carriedMinutes: 0 } });
    });
    await allowanceTaken;
    const stopping = heartbeat("u-1", begun.callId, "ok", at(80));

    await expect(rollover).resolves.toBeUndefined();
    expect(await stopping).toMatchObject({ found: true, stop: true, reason: "cap_reached", freeCap: true });
    expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(false);
    // The rollover did wait for the call row while the heartbeat held it, and the heartbeat's lock transaction never
    // waited for (or touched) the allowance: it committed and let the rollover through, and the stop settled after.
    const lockTx = lockTransactions().at(-1)!;
    const waited = fake.ops.findIndex((o) => o.op === `wait:trainerSession:${begun.callId}`);
    expect(waited).toBeGreaterThanOrEqual(0);
    expect(fake.ops.findIndex((o) => o.tx === lockTx.tx && o.op === "commit")).toBeGreaterThan(waited);
    expect(onlyTheCallRow(lockTx.ops)).toEqual([]);
    expect(session(begun.callId)).toMatchObject({ endReason: "cap_reached", billedMinutes: 1, billableSeconds: 60 });
  });
});

describe("settling a silent Free call locks the user row first, in a voice start's order", () => {
  const tick = () => new Promise<void>((r) => setImmediate(r));
  /** Waits (a bounded number of turns) until some transaction is blocked on this row. */
  async function untilWaitingFor(key: string) {
    for (let i = 0; i < 200 && !fake.ops.some((o) => o.op === `wait:${key}`); i++) await tick();
  }
  type Script = (tx: typeof fake.db) => Promise<void>;
  const transaction = (fn: Script) => (fake.db.$transaction as (fn: Script) => Promise<void>)(fn);
  const lockUser = (tx: typeof fake.db) => tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${"u-1"} FOR UPDATE`;

  it("the lock model: allowance then user deadlocks with a voice start's user then allowance; user then allowance does not", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    const allowanceId = allowanceOf("u-1").id;
    const bumpAllowance = (tx: typeof fake.db) => tx.usageAllowance.updateMany({ where: { id: allowanceId }, data: { version: { increment: 1 } } });
    fake.enableRowLocks();

    /** A voice start (user row, then the allowance) against a settlement that locks in `order`. */
    async function race(order: "allowance-first" | "user-first") {
      let startHasUser!: () => void;
      const userTaken = new Promise<void>((r) => { startHasUser = r; });
      const start = transaction(async (tx) => {
        await lockUser(tx);
        startHasUser();
        await untilWaitingFor("user:u-1"); // the settlement is blocked on the user row
        await bumpAllowance(tx);
      });
      await userTaken;
      const settlement = transaction(async (tx) => {
        if (order === "allowance-first") { await bumpAllowance(tx); await lockUser(tx); } else { await lockUser(tx); await bumpAllowance(tx); }
      });
      return Promise.allSettled([start, settlement]);
    }

    // The previous order: the settlement held the allowance (its rollover) when it asked for the user row.
    const before = await race("allowance-first");
    expect(before.some((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "P2034")).toBe(true);
    expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(true);

    fake.ops.length = 0;
    const after = await race("user-first");
    expect(after.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(false);
  });

  it("a stale Free call reaped across a period boundary waits for a voice start's user row without holding the allowance", async () => {
    // The month resets on Nov 10 at 12:00 UTC. A Free call with 2 minutes reserved goes silent just before it, and is
    // reaped just after, so its settlement rolls the allowance over (locking it and the call row) inside chargeTarget.
    const nov10 = 26 * 24 * 3600;
    await freeUserWith(8);
    const begun = await beginCall("u-1", scn, at(nov10 - 100));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(nov10 - 100));
    for (const t of [90, 80, 70, 60]) await heartbeat("u-1", begun.callId, "ok", at(nov10 - t));
    const allowanceId = allowanceOf("u-1").id;
    fake.enableRowLocks();

    // A voice start in beginCall's order: the user row, then (once the settlement is blocked) the allowance.
    let startHasUser!: () => void;
    const userTaken = new Promise<void>((r) => { startHasUser = r; });
    const start = transaction(async (tx) => {
      await lockUser(tx);
      startHasUser();
      await untilWaitingFor("user:u-1");
      await tx.usageAllowance.updateMany({ where: { id: allowanceId }, data: { version: { increment: 1 } } });
    });
    await userTaken;
    const reap = usageSummary("u-1", at(nov10 + 60));

    const [started, read] = await Promise.allSettled([start, reap]);
    expect(started.status).toBe("fulfilled");
    expect(read.status).toBe("fulfilled");
    expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(false);
    // The settlement asked for the user row before it touched the allowance.
    const settleTx = fake.ops.find((o) => o.op === "wait:user:u-1")!.tx;
    const mine = fake.ops.filter((o) => o.tx === settleTx).map((o) => o.op);
    expect(mine.indexOf("wait:user:u-1")).toBeLessThan(mine.indexOf(`lock:usageAllowance:${allowanceId}`));
    // Reduced charge: last heartbeat 60 s before the reset plus 15 s, 55 s, 1 minute, in the period it ran in.
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 55, billedMinutes: 1 });
  });

  it("a paid call reaped across the boundary keeps main's lock order: no user row lock in its settlement", async () => {
    const nov10 = 26 * 24 * 3600;
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    const begun = await beginCall("u-1", scn, at(nov10 - 100));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("u-1", begun.callId, "connected", at(nov10 - 100));
    await heartbeat("u-1", begun.callId, "ok", at(nov10 - 60));
    const before = fake.rawQueries.length;
    await usageSummary("u-1", at(nov10 + 60));
    expect(fake.rawQueries.slice(before).filter((q) => q.sql.includes('FROM "User"'))).toEqual([]);
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 160, billedMinutes: 3 });
  });

  /**
   * One reap settles a batch whose first stale call takes the allowance lock without the user row (a never-connected
   * call, or a call on the exact paid rule), then a stale connected Free call, while a real beginCall holds the user row
   * and then reserves on the allowance. The reap must lock the user row before its first settlement.
   */
  async function mixedBatch(first: "never-connected" | "paid") {
    await freeUserWith(-170); // 180 Free minutes left: three open calls of 60 reserved minutes each
    const allowance = allowanceOf("u-1");
    let firstId: string;
    if (first === "never-connected") {
      const a = await beginCall("u-1", scn, at(0)); // never sends a heartbeat
      if (!a.ok) throw new Error(a.error);
      firstId = a.callId;
    } else {
      // A call on the exact (paid) rule on this allowance, as one minted on Pro before a downgrade to Free.
      firstId = fake.seed("trainerSession", {
        userId: "u-1", organizationId: "org-1", createdAt: at(0), transcript: [], allowanceId: allowance.id,
        allowancePeriodStart: allowance.periodStart, reservedMinutes: 60, capEnforced: true, connectedAt: at(0), lastHeartbeatAt: at(30),
      }).id as string;
      allowance.minutesReserved = (allowance.minutesReserved as number) + 60;
    }
    const free = await beginCall("u-1", scn, at(10));
    if (!free.ok) throw new Error(free.error);
    await heartbeat("u-1", free.callId, "connected", at(20)); // then silent
    fake.enableRowLocks();

    // Hold the voice start right after it took the user row, until the reap is blocked on that row (bounded).
    let startHasUser!: () => void;
    const userTaken = new Promise<void>((r) => { startHasUser = r; });
    const raw = fake.db.$queryRaw;
    let gated = false;
    fake.db.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const out = await raw(strings, ...values);
      if (!gated && strings.join("?").includes('FROM "User"')) {
        gated = true;
        startHasUser();
        for (let i = 0; i < 200 && !fake.ops.some((o) => o.op === "wait:user:u-1"); i++) await tick();
      }
      return out;
    };
    // At 40 s nothing is stale yet, so this start settles nothing: user row, then the allowance (its reservation).
    const start = beginCall("u-1", scn, at(40));
    await userTaken;
    // At 1000 s both earlier calls are stale; the batch settles the first one first.
    const reap = usageSummary("u-1", at(1000));
    const [started, read] = await Promise.allSettled([start, reap]);
    fake.db.$queryRaw = raw;
    return { allowanceId: allowance.id as string, firstId, freeId: free.callId, started, read };
  }

  for (const first of ["never-connected", "paid"] as const) {
    it(`a batch that settles a stale ${first} call before a stale connected Free call takes the user row first: no deadlock with beginCall`, async () => {
      const { allowanceId, firstId, freeId, started, read } = await mixedBatch(first);
      expect(started.status).toBe("fulfilled");
      expect(started.status === "fulfilled" && started.value).toMatchObject({ ok: true });
      expect(read.status).toBe("fulfilled");
      expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(false);
      // The reap waited for the user row before it locked the allowance for any settlement.
      const reapTx = fake.ops.find((o) => o.op === "wait:user:u-1")!.tx;
      const mine = fake.ops.filter((o) => o.tx === reapTx).map((o) => o.op);
      expect(mine.indexOf("wait:user:u-1")).toBeGreaterThanOrEqual(0);
      expect(mine.indexOf("wait:user:u-1")).toBeLessThan(mine.indexOf(`lock:usageAllowance:${allowanceId}`));
      // Billing as without the race. The first call: 0 for a never-connected one; through the reap for the paid rule
      // (1000 s, 17 minutes, as on main). The Free call: connected at 20 s, plus 15 s, 1 minute, with its marker.
      expect(session(firstId)).toMatchObject(first === "never-connected"
        ? { endReason: "failed_connect", billableSeconds: 0, billedMinutes: 0 }
        : { endReason: "heartbeat_timeout", billableSeconds: 1000, billedMinutes: 17 });
      expect(session(freeId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 15, billedMinutes: 1 });
      expect(fake.rows("auditEvent").filter((e) => e.action === FREE_ABANDON_REDUCED_MARKER)).toHaveLength(1);
      // The voice start's own call is still open, holding its reservation.
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: -170 + (first === "paid" ? 17 : 0) + 1, minutesReserved: 60 });
    });
  }

  it("a batch with no Free silent call takes no user row lock in settleStale, as before", async () => {
    await freeUserWith(-170);
    const a = await beginCall("u-1", scn, at(0)); // never connects
    if (!a.ok) throw new Error(a.error);
    const before = fake.rawQueries.length;
    await usageSummary("u-1", at(1000));
    expect(session(a.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(fake.rawQueries.slice(before).filter((q) => q.sql.includes('FROM "User"'))).toEqual([]);
  });
});

describe("fractional usage", () => {
  it("any minutes left let a Free call start, and a second start cannot take the same half minute", async () => {
    await freeUserWith(9.5);
    expect(checkCap({ remaining: 0.5 })).toEqual({ ok: true });
    expect(checkCap({ remaining: 0 })).toEqual({ ok: false, error: "cap_reached" });
    const first = await beginCall("u-1", scn, at(0));
    // It holds one whole minute, which is also how long it may run, plus the Free end grace.
    expect(first).toMatchObject({ ok: true, remaining: 0.5, maxSeconds: 60 + FREE_END_GRACE_SECONDS });
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

describe("a Free call that goes silent is billed to its last heartbeat plus a short grace, never past its reservation", () => {
  // A Free call that goes silent (tab closed, no end event) is reaped lazily by settleStale on the next voice start or
  // usage read, as heartbeat_timeout. It is billed through its last heartbeat plus FREE_ABANDON_GRACE_SECONDS, rounded up
  // to whole started minutes and clamped to its reservation, however late the reap. Before, it was billed through the
  // reap, up to the reservation: Funnel's retest call heartbeated for 125 s, was reaped 240 s later and billed 7 minutes.
  // The reduced charge applies to the first FREE_ABANDON_REDUCED_PER_PERIOD (3) abandoned Free calls of a billing period;
  // the 4th and later in the same period are billed their whole reservation whenever they are reaped, because a modified
  // client can stop heartbeating and keep talking. Paid calls and every other way a call ends are unchanged.
  /**
   * Starts a call at `start` seconds, heartbeats every 10 seconds and once more at `start + lastSec`, then says nothing
   * more. Starting a call reaps this user's earlier silent call (settleStale in beginCall).
   */
  async function silentAfterHeartbeat(userId: string, lastSec: number, start = 0) {
    const begun = await beginCall(userId, scn, at(start));
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat(userId, begun.callId, "connected", at(start));
    for (let t = 10; t < lastSec; t += 10) await heartbeat(userId, begun.callId, "ok", at(start + t));
    if (lastSec > 0) await heartbeat(userId, begun.callId, "ok", at(start + lastSec));
    expect(session(begun.callId).lastHeartbeatAt).toEqual(at(start + lastSec));
    return begun;
  }

  it("the grace covers one missed heartbeat and stays inside the silence timeout", () => {
    expect(FREE_ABANDON_GRACE_SECONDS).toBe(15);
    expect(FREE_ABANDON_GRACE_SECONDS).toBeLessThan(HEARTBEAT_TIMEOUT_SECONDS);
  });

  it("Funnel's case: 125 s of heartbeats, reaped 240 s later, bills 3 minutes, not 7", async () => {
    await freeUserWith(0);
    const begun = await silentAfterHeartbeat("u-1", 125);
    await usageSummary("u-1", at(125 + 240));
    // 125 s + 15 s = 140 s: 3 started minutes. Before this change it billed through the reap: 365 s, 7 minutes.
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(140), billableSeconds: 140, billedMinutes: 3, abuseFlagged: false });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 3, minutesReserved: 0 });
    expect(await usageSummary("u-1", at(125 + 241))).toMatchObject({ minutesUsed: 3, remaining: 7 });
  });

  it("50 s used, then silent and reaped the next day: billed to the last heartbeat plus the grace, not the reservation", async () => {
    await freeUserWith(0);
    const begun = await silentAfterHeartbeat("u-1", 50);
    const reaped = 24 * 3600;
    await usageSummary("u-1", at(reaped));
    // 50 s + 15 s = 65 s: 2 started minutes. Before this change: min(reap, 50 s + 10 minutes), clamped to 10 minutes.
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(65), billableSeconds: 65, billedMinutes: 2, abuseFlagged: false });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 0 });
    // The user who comes back keeps the rest of their Free minutes, and is not voice blocked.
    expect(await beginCall("u-1", scn, at(reaped + 5))).toMatchObject({ ok: true, remaining: 8 });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
  });

  it("reaped 31 s after its last heartbeat: billed to the last heartbeat plus the grace, not through the reap", async () => {
    await freeUserWith(0);
    const begun = await silentAfterHeartbeat("u-1", 50);
    await usageSummary("u-1", at(50 + 31)); // reaped as soon as it counts as silent
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(65), billableSeconds: 65, billedMinutes: 2 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 0 });
  });

  it("the grace boundary: a last heartbeat at 105 s bills 2 minutes, at 106 s or 119 s it bills 3", async () => {
    const cases: Array<[last: number, seconds: number, minutes: number]> = [[105, 120, 2], [106, 121, 3], [119, 134, 3]];
    for (const [last, seconds, minutes] of cases) {
      fake = createFakePrisma();
      mocks.fake = fake;
      await freeUserWith(0);
      const begun = await silentAfterHeartbeat("u-1", last);
      await usageSummary("u-1", at(3600));
      expect(last + FREE_ABANDON_GRACE_SECONDS).toBe(seconds);
      expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: seconds, billedMinutes: minutes });
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: minutes, minutesReserved: 0 });
    }
  });

  it("the reservation still caps it: 2 minutes left, last heartbeat at 125 s, bills the 2 minutes reserved", async () => {
    await freeUserWith(8);
    const begun = await silentAfterHeartbeat("u-1", 125); // inside the end grace of a 2 minute reservation
    expect(allowanceOf("u-1").minutesReserved).toBe(2);
    await usageSummary("u-1", at(3600));
    // 140 s would be 3 minutes; the reservation clamps it to 120 s and 2 minutes, and it keeps its own reason.
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 120, billedMinutes: 2, abuseFlagged: false });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
  });

  it("9.5 used, heartbeats for 70 seconds, then lost connection: billed the 1 minute reserved, and not flagged", async () => {
    await freeUserWith(9.5);
    const begun = await silentAfterHeartbeat("u-1", 70); // last heartbeat at 70 seconds, inside the end grace
    expect(allowanceOf("u-1").minutesReserved).toBe(1);

    await usageSummary("u-1", at(600)); // the server notices the silence and settles the call
    const s = session(begun.callId);
    expect(s).toMatchObject({ endReason: "heartbeat_timeout", abuseFlagged: false, billableSeconds: 60, billedMinutes: 1 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10.5, minutesReserved: 0 });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
  });

  it("a call that only sent its connect heartbeat bills the grace: 1 started minute", async () => {
    await freeUserWith(0);
    const begun = await silentAfterHeartbeat("u-1", 0);
    await usageSummary("u-1", at(3 * 3600));
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: FREE_ABANDON_GRACE_SECONDS, billedMinutes: 1 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 1, minutesReserved: 0 });
  });

  it("a paid call that goes silent is billed as before: through the reap, up to its reservation", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    const funnel = await silentAfterHeartbeat("u-1", 125);
    expect(session(funnel.callId).capEnforced).toBe(true);
    await usageSummary("u-1", at(125 + 240));
    // The same as before the Free change: the whole silent stretch until the reap.
    expect(session(funnel.callId)).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(365), billableSeconds: 365, billedMinutes: 7, abuseFlagged: false });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 7, minutesReserved: 0 });

    // Reaped the next day: clamped to its 60 minute reservation and flagged as outliving it, as before.
    addUser("u-2", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-2" }, at(0));
    const late = await silentAfterHeartbeat("u-2", 50);
    await usageSummary("u-2", at(24 * 3600));
    expect(session(late.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 3600, billedMinutes: 60, abuseFlagged: true });
    expect(allowanceOf("u-2")).toMatchObject({ minutesUsed: 60, minutesReserved: 0 });
  });

  /** The reduced-charge markers written so far (one per reduced settlement). */
  const markers = () => fake.rows("auditEvent").filter((e) => e.action === FREE_ABANDON_REDUCED_MARKER);
  /**
   * `n` silent calls, one an hour from `from`, each with its last heartbeat 50 s in. Starting each call reaps the one
   * before it; the last is left open. Returns the call ids.
   */
  async function silentCalls(n: number, from = 0) {
    const ids: string[] = [];
    for (let k = 0; k < n; k++) ids.push((await silentAfterHeartbeat("u-1", 50, from + k * 3600)).callId);
    return ids;
  }

  it("the limit is 3 reduced silent calls per period", () => {
    expect(FREE_ABANDON_REDUCED_PER_PERIOD).toBe(3);
  });

  it("calls 1 to 3 of a period are reduced and each writes a marker; the 4th, reaped 31 s after its last heartbeat, bills its whole reservation and writes none", async () => {
    await freeUserWith(-50); // 60 Free minutes left (a manual credit), so 4 calls fit
    const ids = await silentCalls(4);
    // Calls 1 to 3: 50 s + 15 s = 65 s, 2 minutes each, reaped by the next start.
    for (const id of ids.slice(0, 3)) expect(session(id)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 65, billedMinutes: 2 });
    const october = freeAbandonClaimKey(allowanceOf("u-1").id as string, allowanceOf("u-1").periodStart as Date);
    expect(markers()).toEqual(ids.slice(0, 3).map((id) => expect.objectContaining({ userId: "u-1", resource: october, metadata: { trainerSessionId: id } })));
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: -44, minutesReserved: 54 });
    // The 4th, reaped as soon as it counts as silent: its whole 54 minute reservation, not 65 s. The row keeps the reap.
    const reap = 3 * 3600 + 50 + HEARTBEAT_TIMEOUT_SECONDS + 1;
    await usageSummary("u-1", at(reap));
    expect(session(ids[3])).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(reap), billableSeconds: 54 * 60, billedMinutes: 54, abuseFlagged: false });
    expect(markers()).toHaveLength(3);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
    expect(fake.rows("user")[0].voiceBlockedUntil ?? null).toBeNull();
  });

  it("the 4th silent call of a period reaped the next day bills its whole reservation too", async () => {
    await freeUserWith(0); // 10 Free minutes: calls 1 to 3 bill 2 each, the 4th reserves the last 4
    const ids = await silentCalls(4);
    await usageSummary("u-1", at(24 * 3600));
    expect(session(ids[3])).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(24 * 3600), billableSeconds: 240, billedMinutes: 4, abuseFlagged: false });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
  });

  it("the next billing period gets 3 reduced silent calls again", async () => {
    await freeUserWith(0);
    const octKey = freeAbandonClaimKey(allowanceOf("u-1").id as string, allowanceOf("u-1").periodStart as Date);
    const october = await silentCalls(4);
    await usageSummary("u-1", at(3 * 3600 + 81));
    // 3 reduced (2 minutes each), then the 4th bills the 4 minutes it reserved.
    expect(october.map((id) => session(id).billedMinutes)).toEqual([2, 2, 2, 4]);
    // The month resets on the 10th at 12:00 UTC, 26 days after T0.
    const nov10 = 26 * 24 * 3600;
    expect(at(nov10).toISOString()).toBe("2026-11-10T12:00:00.000Z");
    const november = await silentCalls(4, nov10 + 60);
    await usageSummary("u-1", at(nov10 + 60 + 3 * 3600 + 81));
    expect(november.map((id) => session(id).billableSeconds)).toEqual([65, 65, 65, 240]);
    expect(november.map((id) => session(id).billedMinutes)).toEqual([2, 2, 2, 4]);
    const novKey = freeAbandonClaimKey(allowanceOf("u-1").id as string, at(nov10));
    expect(markers().map((m) => m.resource)).toEqual([octKey, octKey, octKey, novKey, novKey, novKey]);
  });

  it("the markers survive the retention purge and still count: after the rows of calls 1 to 3 are deleted, the 4th bills its whole reservation", async () => {
    await freeUserWith(-50);
    fake.rows("organization")[0].sessionRetentionDays = 1; // shorter than any billing period
    const ids = await silentCalls(3);
    await usageSummary("u-1", at(2 * 3600 + 81));
    expect(ids.map((id) => session(id).billedMinutes)).toEqual([2, 2, 2]);
    expect(markers()).toHaveLength(3);

    // Two days later the nightly purge deletes the call rows; the AuditEvent markers stay.
    vi.stubEnv("CRON_SECRET", "cron-test-secret-not-real");
    vi.setSystemTime(at(2 * 24 * 3600));
    const res = await purge(new NextRequest("https://trainer.example/api/cron/purge-expired", { headers: { authorization: "Bearer cron-test-secret-not-real" } }));
    expect(res.status).toBe(200);
    vi.setSystemTime(T0);
    for (const id of ids) expect(fake.rows("trainerSession").find((s) => s.id === id)).toBeUndefined();
    expect(fake.rows("trainerSession").filter((s) => s.endReason === "heartbeat_timeout")).toEqual([]);
    expect(markers()).toHaveLength(3);

    // A 4th silent call in the same period, reaped 31 s after its last heartbeat: its whole 54 minute reservation.
    const start = 2 * 24 * 3600 + 100;
    const fourth = await silentAfterHeartbeat("u-1", 125, start);
    await usageSummary("u-1", at(start + 125 + HEARTBEAT_TIMEOUT_SECONDS + 1));
    expect(session(fourth.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 54 * 60, billedMinutes: 54 });
    expect(markers()).toHaveLength(3); // a full-reservation settlement writes none

    // The next period starts with no markers: its first silent call is reduced again and writes one.
    const nov10 = 26 * 24 * 3600;
    const november = await silentAfterHeartbeat("u-1", 125, nov10 + 60);
    await usageSummary("u-1", at(nov10 + 60 + 365));
    expect(session(november.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 140, billedMinutes: 3 });
    expect(markers()).toHaveLength(4);
    expect(markers()[3].resource).toBe(freeAbandonClaimKey(allowanceOf("u-1").id as string, at(nov10)));
  });

  it("parallel reaps of 5 stale calls give exactly 3 reduced charges and 3 markers", async () => {
    await freeUserWith(-290); // 300 Free minutes left: 5 open calls of 60 reserved minutes each
    // Calls A to E start a second apart; their last heartbeats run backwards (A at 500 s, E at 100 s). Each reap below
    // sees a different set of stale calls, so the first call each one settles is a different call: E, D, C, B, A.
    const lastBeats = [500, 400, 300, 200, 100];
    const ids: string[] = [];
    for (let k = 0; k < 5; k++) {
      const begun = await beginCall("u-1", scn, at(k));
      if (!begun.ok) throw new Error(begun.error);
      ids.push(begun.callId);
    }
    for (let k = 0; k < 5; k++) await heartbeat("u-1", ids[k], "connected", at(lastBeats[k]));
    expect(allowanceOf("u-1").minutesReserved).toBe(300);
    fake.enableRowLocks();

    const reaps = await Promise.allSettled([...lastBeats].reverse().map((t) => usageSummary("u-1", at(t + HEARTBEAT_TIMEOUT_SECONDS + 1))));
    expect(reaps.map((r) => r.status)).toEqual(Array(5).fill("fulfilled"));
    expect(fake.ops.some((o) => o.op.startsWith("deadlock:"))).toBe(false);
    const billed = ids.map((id) => session(id).billedMinutes as number);
    expect(ids.every((id) => session(id).endReason === "heartbeat_timeout")).toBe(true);
    expect(billed.filter((m) => m < 60)).toHaveLength(3);
    expect(billed.filter((m) => m === 60)).toHaveLength(2);
    expect(markers()).toHaveLength(3);
    // The markers name exactly the 3 calls that were reduced.
    expect(markers().map((m) => (m.metadata as { trainerSessionId: string }).trainerSessionId).sort()).toEqual(ids.filter((_, k) => billed[k] < 60).sort());
  });

  it("a never-connected call or a hung-up call does not count toward the period's reduced silent calls", async () => {
    await freeUserWith(0);
    const never = await beginCall("u-1", scn, at(0));
    if (!never.ok) throw new Error(never.error);
    const { callId: hungUp } = await runCall("u-1", { start: 3600, endAt: 60 }); // reaps the never-connected one first
    expect(session(never.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(session(hungUp)).toMatchObject({ endReason: "user_hangup", billedMinutes: 1 });
    const abandoned = await silentAfterHeartbeat("u-1", 125, 7200);
    await usageSummary("u-1", at(7200 + 365));
    expect(session(abandoned.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 140, billedMinutes: 3 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 4, minutesReserved: 0 });
  });

  it("paid: every abandoned call in a period is billed through the reap, as before", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    const first = await silentAfterHeartbeat("u-1", 125);
    const second = await silentAfterHeartbeat("u-1", 125, 365); // reaps the first at 365 s
    await usageSummary("u-1", at(365 + 365));
    expect(session(first.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 365, billedMinutes: 7 });
    expect(session(second.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 365, billedMinutes: 7 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 14, minutesReserved: 0 });

    // A third one reaped 31 s after its last heartbeat is still billed only through the reap (the reap-timing weakness
    // main has for paid calls, left as is): 125 s + 31 s = 156 s, 3 minutes.
    const third = await silentAfterHeartbeat("u-1", 125, 3600);
    await usageSummary("u-1", at(3600 + 125 + HEARTBEAT_TIMEOUT_SECONDS + 1));
    expect(session(third.callId)).toMatchObject({ endReason: "heartbeat_timeout", endedAt: at(3600 + 156), billableSeconds: 156, billedMinutes: 3 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 17, minutesReserved: 0 });
  });

  it("a call that never sent a heartbeat is closed as failed_connect and bills nothing", async () => {
    await freeUserWith(0);
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await usageSummary("u-1", at(3 * 3600));
    expect(session(begun.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });
});

describe("voice_cap_hit: a used-up allowance is reported with ids only, and never holds up the answer", () => {
  // Each test below runs as its own user so the per-user mint limits (fixed, on a frozen clock) never carry over.
  // occurredAt is the frozen clock (T0) at queue time: every route here runs at T0 unless a test moves the clock.
  const capHit = (userId: string, reason: string, occurredAt = T0.toISOString()): PremiumEvent => ({ name: "voice_cap_hit", subject: "user", subjectId: userId, reason, occurredAt });
  /** The sink is scheduled after the response is built: let pending microtasks and one macrotask run first. */
  const flush = () => new Promise<void>((r) => setImmediate(r));
  const elToken = () => elevenLabsToken(new NextRequest("http://localhost/api/elevenlabs/token?scenarioId=quote-follow-up"));
  const beat = (callId: string, state: "connected" | "ok") => heartbeatRoute(post("/api/usage/heartbeat", { callId, state }));
  let events: PremiumEvent[];

  async function freeUser(id: string, used: number) {
    mocks.authId = id;
    addUser(id);
    await ensureAllowance(fake.db as never, { userId: id }, at(0));
    allowanceOf(id).minutesUsed = used;
  }

  beforeEach(() => {
    events = [];
    setPremiumEventSink((e) => { events.push(e); });
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test-not-real");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-main");
    vi.stubEnv("ELEVENLABS_AGENT_ID_STANDARD", "agent-std"); // Free calls run on the Standard engine
    // Test-only: this block mints more often than the per-IP hourly limits allow on a frozen clock. Production limits are unchanged.
    vi.stubEnv("RATE_LIMIT_TOKEN_MAX", "1000");
    vi.stubEnv("RATE_LIMIT_REALTIME_MAX", "1000");
  });
  afterEach(() => setPremiumEventSink(null));

  it("the realtime route emits one event with ids only when the allowance is used up, and none when a call starts", async () => {
    await freeUserWith(FREE_MINUTES);
    const res = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(res.status).toBe(402);
    await flush();
    expect(events).toEqual([capHit("u-1", "cap_reached")]);

    events.length = 0;
    allowanceOf("u-1").minutesUsed = 5;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    expect((await realtimeSession(post("/api/realtime/session", { scenario }))).status).toBe(200);
    await flush();
    expect(events).toEqual([]);
  });

  it("the ElevenLabs token route emits one event with ids only when the allowance is used up, and none when a call starts", async () => {
    await freeUser("u-el", FREE_MINUTES);
    const upstream = vi.fn(async () => new Response(JSON.stringify({ token: "el-conv-token" }), { status: 200 }));
    vi.stubGlobal("fetch", upstream);
    const res = await elToken();
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("cap_reached");
    expect(upstream).not.toHaveBeenCalled();
    await flush();
    expect(events).toEqual([capHit("u-el", "cap_reached")]);
    // Nothing else rides along: no email, plan, model, agent or call id.
    expect(Object.keys(events[0]).sort()).toEqual(["name", "occurredAt", "reason", "subject", "subjectId"]);

    events.length = 0;
    allowanceOf("u-el").minutesUsed = 5;
    expect((await elToken()).status).toBe(200);
    await flush();
    expect(events).toEqual([]);
  });

  it("a sink that never settles does not delay the 402 or change it", async () => {
    let called = 0;
    setPremiumEventSink(() => { called++; return new Promise<void>(() => {}); });
    await freeUser("u-slow-rt", FREE_MINUTES);
    let t = performance.now();
    const rt = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(performance.now() - t).toBeLessThan(1000);
    expect(rt.status).toBe(402);
    expect((await rt.json()).error).toBe("cap_reached");

    await freeUser("u-slow-el", FREE_MINUTES);
    t = performance.now();
    const el = await elToken();
    expect(performance.now() - t).toBeLessThan(1000);
    expect(el.status).toBe(402);
    expect((await el.json()).error).toBe("cap_reached");
    await flush();
    expect(called).toBe(2); // the sink was still told, just not waited for
  });

  it("a sink that throws, or rejects, does not change the 402", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const expected = await capReached().json();
    for (const [id, sink] of [
      ["u-throw", () => { throw new Error("sink down"); }],
      ["u-reject", async () => { throw new Error("sink down"); }],
    ] as const) {
      setPremiumEventSink(sink);
      await freeUser(id, FREE_MINUTES);
      const res = await elToken();
      expect(res.status).toBe(402);
      expect(await res.json()).toEqual(expected);
      await flush();
    }
    // The failure is logged by event name only.
    expect(errors).toHaveBeenCalledWith("[billing-events] premium sink failed for", "voice_cap_hit");
    errors.mockRestore();
  });

  describe("inside a request, the emit is handed to next/server after()", () => {
    /** Synchronous work the sink does before it returns: the response must not wait for it. */
    const busy = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* spin */ } };
    let scheduled: Array<() => unknown>;
    beforeEach(() => {
      scheduled = [];
      mocks.after = (task) => { scheduled.push(task); }; // deferred, as Next.js runs it after the response is sent
    });

    it("both mint routes schedule one task via after() and run no sink work before answering", async () => {
      await freeUser("u-after-rt", FREE_MINUTES);
      expect((await realtimeSession(post("/api/realtime/session", { scenario }))).status).toBe(402);
      await freeUser("u-after-el", FREE_MINUTES);
      expect((await elToken()).status).toBe(402);
      await flush();
      expect(scheduled).toHaveLength(2);
      expect(events).toEqual([]); // nothing ran yet
      for (const task of scheduled) await task();
      expect(events).toEqual([capHit("u-after-rt", "cap_reached"), capHit("u-after-el", "cap_reached")]);
    });

    it("a sink doing slow synchronous work does not delay the 402", async () => {
      let ran = 0;
      setPremiumEventSink(() => { busy(400); ran++; });
      await freeUser("u-busy", FREE_MINUTES);
      const t = performance.now();
      const res = await elToken();
      expect(performance.now() - t).toBeLessThan(200);
      expect(res.status).toBe(402);
      expect(ran).toBe(0);
      for (const task of scheduled) await task();
      expect(ran).toBe(1);
    });

    it("a throwing or rejecting sink is swallowed inside the after() task", async () => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      for (const [id, sink] of [
        ["u-after-throw", () => { throw new Error("sink down"); }],
        ["u-after-reject", async () => { throw new Error("sink down"); }],
      ] as const) {
        setPremiumEventSink(sink);
        await freeUser(id, FREE_MINUTES);
        expect((await elToken()).status).toBe(402);
      }
      expect(scheduled).toHaveLength(2);
      for (const task of scheduled) await expect(Promise.resolve(task())).resolves.toBeUndefined();
      expect(errors).toHaveBeenCalledWith("[billing-events] premium sink failed for", "voice_cap_hit");
      errors.mockRestore();
    });

    it("through the GHL sink: no lookup or POST before the 402, then one voice_cap_hit POST from the nested after()", async () => {
      vi.stubEnv("GHL_BILLING_EVENTS", "true");
      vi.stubEnv("GHL_WEBHOOK_URL", "https://hooks.example.test/hooks/cap-hit");
      const ghlPosts = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", ghlPosts);
      setPremiumEventSink(ghlPremiumSink);
      await freeUser("u-ghl", FREE_MINUTES);
      const lookups = vi.spyOn(fake.db.user as unknown as { findUnique: (...a: unknown[]) => unknown }, "findUnique");

      expect((await elToken()).status).toBe(402);
      const lookupsByRoute = lookups.mock.calls.length;
      await flush();
      expect(ghlPosts).not.toHaveBeenCalled();
      expect(scheduled).toHaveLength(1); // the outer after(): the sink has not run yet

      await scheduled[0]();
      expect(lookups.mock.calls.length).toBeGreaterThan(lookupsByRoute); // the contact lookup ran only now
      expect(scheduled).toHaveLength(2); // emitGhlEvent handed its work to a nested after()
      await settleGhlEvents();
      expect(ghlPosts).toHaveBeenCalledTimes(1);
      const body = JSON.parse((ghlPosts.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body).toMatchObject({ event: "voice_cap_hit", userId: "u-ghl", email: "u-ghl@example.test", plan: "free", reason: "cap_reached", tags: ["app-calltrainer"] });
      // The claim marker for the organization's day is written once, before the POST.
      expect(fake.rows("auditEvent").filter((a) => a.action === "ghl.voice_cap_hit_sent")).toEqual([expect.objectContaining({ userId: "u-ghl", resource: "voice_cap_hit:org-1:2026-10-15" })]);
    });

    it("a cap hit queued just before UTC midnight and sent just after keeps its own time and day", async () => {
      vi.stubEnv("GHL_BILLING_EVENTS", "true");
      vi.stubEnv("GHL_WEBHOOK_URL", "https://hooks.example.test/hooks/cap-hit");
      const ghlPosts = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", ghlPosts);
      setPremiumEventSink(ghlPremiumSink);
      await freeUser("u-midnight", FREE_MINUTES);

      vi.setSystemTime(new Date("2026-10-15T23:59:59.900Z"));
      expect((await elToken()).status).toBe(402); // queued here
      vi.setSystemTime(new Date("2026-10-16T00:00:00.100Z"));
      for (const task of [...scheduled]) if (typeof task === "function") await task(); // sent after midnight
      await settleGhlEvents();

      expect(ghlPosts).toHaveBeenCalledTimes(1);
      const body = JSON.parse((ghlPosts.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
      expect(body).toMatchObject({
        event: "voice_cap_hit",
        occurredAt: "2026-10-15T23:59:59.900Z",
        eventId: "voice_cap_hit:org-1:2026-10-15",
      });
    });

    it("through the GHL sink with GHL events off, nothing is looked up or posted", async () => {
      const ghlPosts = vi.fn(async () => new Response("ok", { status: 200 }));
      vi.stubGlobal("fetch", ghlPosts);
      setPremiumEventSink(ghlPremiumSink);
      await freeUser("u-ghl-off", FREE_MINUTES);
      expect((await elToken()).status).toBe(402);
      for (const task of scheduled) await task();
      await settleGhlEvents();
      expect(scheduled).toHaveLength(1); // emitGhlEvent returned before scheduling anything
      expect(ghlPosts).not.toHaveBeenCalled();
    });

    it("the heartbeat cap stop is scheduled via after() too", async () => {
      mocks.authId = "u-after-pro";
      addUser("u-after-pro", { planTier: "pro" });
      await ensureAllowance(fake.db as never, { userId: "u-after-pro" }, at(0));
      allowanceOf("u-after-pro").minutesUsed = 199.5;
      const begun = await beginCall("u-after-pro", scn, at(0));
      if (!begun.ok) throw new Error(begun.error);
      await beat(begun.callId, "connected");
      vi.setSystemTime(at(70));
      expect(await (await beat(begun.callId, "ok")).json()).toMatchObject({ stop: true, reason: "cap_reached" });
      expect(scheduled).toHaveLength(1);
      await scheduled[0]();
      expect(events).toEqual([capHit("u-after-pro", "cap_reached_in_call", at(70).toISOString())]);
    });
  });

  it("outside a request scope (after() unavailable), slow synchronous sink work still runs only after the 402", async () => {
    mocks.after = () => { throw new Error("`after` was called outside a request scope"); };
    let ran = 0;
    setPremiumEventSink(() => { const end = performance.now() + 400; while (performance.now() < end) { /* spin */ } ran++; });
    await freeUser("u-fallback", FREE_MINUTES);
    const t = performance.now();
    const res = await elToken();
    expect(performance.now() - t).toBeLessThan(200);
    expect(res.status).toBe(402);
    expect(ran).toBe(0);
    await flush();
    expect(ran).toBe(1);
  });

  it("the heartbeat that stops a call at its cap emits cap_reached_in_call once, and the heartbeats before and after emit nothing", async () => {
    mocks.authId = "u-pro";
    addUser("u-pro", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-pro" }, at(0));
    allowanceOf("u-pro").minutesUsed = 199.5;
    const begun = await beginCall("u-pro", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    expect(begun.maxSeconds).toBe(60);

    expect(await (await beat(begun.callId, "connected")).json()).toMatchObject({ stop: false });
    vi.setSystemTime(at(30));
    expect(await (await beat(begun.callId, "ok")).json()).toMatchObject({ stop: false });
    await flush();
    expect(events).toEqual([]);

    vi.setSystemTime(at(70));
    expect(await (await beat(begun.callId, "ok")).json()).toMatchObject({ stop: true, reason: "cap_reached" });
    vi.setSystemTime(at(80));
    expect(await (await beat(begun.callId, "ok")).json()).toMatchObject({ stop: true, reason: "ended" });
    vi.setSystemTime(at(90));
    await beat(begun.callId, "ok");
    await flush();
    // Stamped at the stopping heartbeat (70 s), not at the later "ended" heartbeats or when the sink ran.
    expect(events).toEqual([capHit("u-pro", "cap_reached_in_call", at(70).toISOString())]);
  });

  it("a Free call stopped at its cap emits cap_reached_in_call once, with the Free stop wording and the warning before it", async () => {
    // STR-715 had "a Free call stopped by the call length limit is not a cap hit": Free calls never stopped on the cap.
    // They do now, through the same heartbeat stop as paid calls, so the in-call cap hit from #106 fires for Free too.
    await freeUser("u-free-stop", 0);
    const begun = await beginCall("u-free-stop", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const limit = 600 + FREE_END_GRACE_SECONDS;
    expect(begun.maxSeconds).toBe(limit);

    expect(await (await beat(begun.callId, "connected")).json()).toEqual({ stop: false, secondsLeft: limit });
    vi.setSystemTime(at(300));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: false, secondsLeft: limit - 300 });
    vi.setSystemTime(at(550));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: false, secondsLeft: limit - 550, capWarning: true, message: FREE_CAP_WARNING_MESSAGE });
    // The route sends the warning once: the next heartbeat in the window answers without it.
    vi.setSystemTime(at(560));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: false, secondsLeft: limit - 560 });
    await flush();
    expect(events).toEqual([]); // the warning is not a cap hit

    vi.setSystemTime(at(limit));
    const stopped = await (await beat(begun.callId, "ok")).json();
    expect(stopped).toEqual({ stop: true, reason: "cap_reached", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true });
    expect(isCapMessage(stopped.message)).toBe(true); // the call screen adds the Upgrade link
    // If that answer is lost, the next ones still tell the client it was a Free cap stop, with the Free wording.
    vi.setSystemTime(at(limit + 10));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: true, reason: "ended", message: FREE_CAP_STOPPED_MESSAGE, freeCap: true });
    vi.setSystemTime(at(limit + 20));
    await beat(begun.callId, "ok");
    await flush();
    expect(events).toEqual([capHit("u-free-stop", "cap_reached_in_call", at(limit).toISOString())]);
  });

  it("a paid cap stop keeps the paid wording and never carries the Free warning", async () => {
    mocks.authId = "u-pro-copy";
    addUser("u-pro-copy", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-pro-copy" }, at(0));
    allowanceOf("u-pro-copy").minutesUsed = 199;
    const begun = await beginCall("u-pro-copy", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    await beat(begun.callId, "connected");
    vi.setSystemTime(at(30));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: false, secondsLeft: 30 });
    vi.setSystemTime(at(60));
    expect(await (await beat(begun.callId, "ok")).json()).toEqual({ stop: true, reason: "cap_reached", message: CAP_STOPPED_MESSAGE });
    await flush();
    expect(events).toEqual([capHit("u-pro-copy", "cap_reached_in_call", at(60).toISOString())]);
  });

  it("no event when metering is off: the mint is not capped and the heartbeat is not served", async () => {
    vi.stubEnv("DATABASE_URL", "");
    await freeUser("u-off", 12);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    expect((await realtimeSession(post("/api/realtime/session", { scenario }))).status).toBe(200);
    const hb = await beat("any-call", "ok");
    expect(hb.status).toBe(404);
    expect((await hb.json()).error).toBe("metering_off");
    await flush();
    expect(events).toEqual([]);
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
    expect(body.maxSeconds).toBe(60 + FREE_END_GRACE_SECONDS);
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
