import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// The database and the session check are the only fakes; metering, the ledger and the routes run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, creditManual, endCall, ensureAllowance, heartbeat, resolveAllowance, usageSummary } from "@/lib/usage";
import { CONNECT_WINDOW_SECONDS } from "@/lib/usagePlan";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as endRoute } from "@/app/api/usage/end/route";
import { POST as heartbeatRoute } from "@/app/api/usage/heartbeat/route";
import { POST as creditRoute } from "@/app/api/usage/credit/route";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as sdpPOST } from "@/app/api/realtime/sdp/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";

const T0 = new Date("2026-10-15T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
const MAR10 = new Date("2026-03-10T12:00:00Z");

let fake: ReturnType<typeof createFakePrisma>;

function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const entries = (callId: string) => fake.rows("usageEntry").filter((e) => e.trainerSessionId === callId);
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;

/**
 * One voice call on a controlled clock: starts at `start` seconds, connects at `connectAt` (default: at once; null =
 * never), sends a healthy heartbeat every 10 seconds, and ends `endAt` seconds after the start (or earlier if the
 * server says stop). `beats: false` sends only the connect heartbeat. Returns the end result.
 */
async function runCall(userId: string, o: { connectAt?: number | null; endAt: number; reason?: "user_hangup" | "network_drop" | "provider_error" | "server_error" | "failed_connect"; start?: number; beats?: boolean }) {
  const start = o.start ?? 0;
  const end = start + o.endAt;
  const begun = await beginCall(userId, scn, at(start));
  if (!begun.ok) throw new Error(begun.error);
  const connectAt = o.connectAt === undefined ? start : o.connectAt;
  if (connectAt !== null) {
    await heartbeat(userId, begun.callId, "connected", at(connectAt));
    for (let t = connectAt + 10; o.beats !== false && t < end; t += 10) {
      const r = await heartbeat(userId, begun.callId, "ok", at(t));
      if (r.found && r.stop) break;
    }
  }
  const result = await endCall(userId, begun.callId, o.reason ?? "user_hangup", at(end));
  return { callId: begun.callId, result: result! };
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("billing a call", () => {
  it("1: never connects (WebRTC fails): 0 minutes, failed_connect, no ledger rows", async () => {
    addUser("u-1");
    const { callId, result } = await runCall("u-1", { connectAt: null, endAt: 5, reason: "failed_connect" });
    expect(result).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
    expect(entries(callId)).toHaveLength(0);
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
    expect(session(callId).endReason).toBe("failed_connect");
  });

  it("2: connects, network drop at 12s: 1 billed, 1 credited, net 0", async () => {
    addUser("u-1");
    const { callId, result } = await runCall("u-1", { endAt: 12, reason: "network_drop", beats: false });
    expect(result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0, creditedMinutes: 1 });
    expect(entries(callId).map((e) => [e.kind, e.minutes])).toEqual([["voice_call", 1], ["credit_drop", -1]]);
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
  });

  it("3: a drop at exactly 30s is credited; 4: at 31s it is billed", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 30, reason: "network_drop", beats: false })).result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0 });
    expect((await runCall("u-1", { endAt: 31, reason: "network_drop", start: 100, beats: false })).result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    expect(allowanceOf("u-1").minutesUsed).toBe(1);
  });

  it("5, 24: a user hang-up at 10s or 25s is billed 1 minute with no credit", async () => {
    addUser("u-1");
    for (const [i, sec] of [10, 25].entries()) {
      const { callId, result } = await runCall("u-1", { endAt: sec, start: i * 1000 });
      expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1, creditedMinutes: 0 });
      expect(entries(callId).map((e) => e.kind)).toEqual(["voice_call"]);
    }
  });

  it("6, 7, 8: 60s bills 1, 61s bills 2, 3m10s bills 4", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 60 })).result.billedMinutes).toBe(1);
    expect((await runCall("u-1", { endAt: 61, start: 1000 })).result.billedMinutes).toBe(2);
    expect((await runCall("u-1", { endAt: 190, start: 2000 })).result.billedMinutes).toBe(4);
    expect(allowanceOf("u-1").minutesUsed).toBe(7);
  });

  it("9: a drop at 2m that reconnects in 5s continues one call: 4 minutes, one entry", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    for (let t = 10; t <= 110; t += 10) await heartbeat("u-1", begun.callId, "ok", at(t));
    await heartbeat("u-1", begun.callId, "recovering", at(120));
    expect(session(begun.callId).degradedAt).not.toBeNull();
    await heartbeat("u-1", begun.callId, "ok", at(125));
    expect(session(begun.callId).degradedAt).toBeNull();
    for (let t = 135; t < 210; t += 10) await heartbeat("u-1", begun.callId, "ok", at(t));
    const result = await endCall("u-1", begun.callId, "user_hangup", at(210));
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 4 });
    expect(entries(begun.callId)).toHaveLength(1);
  });

  it("10: a drop whose reconnect fails ends when the drop started, even though the client gives up at 30s", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    await heartbeat("u-1", begun.callId, "ok", at(10));
    await heartbeat("u-1", begun.callId, "recovering", at(20));
    // The client reports 10 seconds after the drop began (rule 3). The call ended when the drop started.
    // The server heard heartbeats after connect, so it is billed, not credited.
    const result = await endCall("u-1", begun.callId, "network_drop", at(31));
    expect(session(begun.callId).billableSeconds).toBe(20);
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
  });

  it("a heartbeat-seen call reporting network_drop at 20s is billed; the same drop with no heartbeat is credited", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 20, reason: "network_drop" })).result).toMatchObject({ outcome: "billed", billedMinutes: 1, creditedMinutes: 0 });
    expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: 1000, beats: false })).result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0 });
  });

  it("the 4th credited drop within 24 hours is billed; a day later credits resume", async () => {
    addUser("u-1");
    for (let i = 0; i < 3; i++) {
      expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: i * 100, beats: false })).result.outcome).toBe("dropped_credited");
    }
    expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: 400, beats: false })).result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    // Billed calls do not count toward the cap, and the first credits age out after 24 hours.
    expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: 24 * 3600 + 50, beats: false })).result.outcome).toBe("dropped_credited");
  });

  it("subsecond drops use the daily credit cap too, and past it they bill a minute", async () => {
    addUser("u-1");
    for (let i = 0; i < 3; i++) {
      const { callId, result } = await runCall("u-1", { endAt: 0, reason: "network_drop", start: i * 100, beats: false });
      expect(result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0 });
      expect(session(callId).billableSeconds).toBe(0);
    }
    const { callId, result } = await runCall("u-1", { endAt: 0, reason: "provider_error", start: 400, beats: false });
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    expect(session(callId).billedMinutes).toBe(1);
    expect(allowanceOf("u-1").minutesUsed).toBe(1);
  });

  it("B1: a never-connected abuse loop uses the same 3 per 24 hours, then bills a minute per call", async () => {
    addUser("u-1");
    for (let i = 0; i < 3; i++) {
      const { callId, result } = await runCall("u-1", { connectAt: null, endAt: 5, reason: "user_hangup", start: i * 100 });
      expect(result).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
      expect(session(callId).endReason).toBe("failed_connect");
    }
    const { callId, result } = await runCall("u-1", { connectAt: null, endAt: 5, reason: "failed_connect", start: 400 });
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    expect(session(callId).billedMinutes).toBe(1);
    expect(entries(callId).map((e) => [e.kind, e.minutes])).toEqual([["voice_call", 1]]);
    expect(allowanceOf("u-1").minutesUsed).toBe(1);
    // Never-connected calls and credited drops share one count.
    expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: 500, beats: false })).result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    // The first three age out after 24 hours.
    expect((await runCall("u-1", { connectAt: null, endAt: 5, start: 24 * 3600 + 50 })).result).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
  });

  it("B1: over the cap, a never-connected call never bills more than the allowance has left", async () => {
    addUser("u-1");
    for (let i = 0; i < 3; i++) await runCall("u-1", { connectAt: null, endAt: 5, start: i * 100 });
    fake.rows("usageAllowance").find((a) => a.userId === "u-1")!.minutesUsed = 9; // Free: 10 a month
    const { result } = await runCall("u-1", { connectAt: null, endAt: 5, start: 400 });
    expect(result.billedMinutes).toBe(1);
    expect(allowanceOf("u-1").minutesUsed).toBe(10);
  });

  it("B1: a server-side mint failure is never billed, even past the cap, but its row counts toward the cap", async () => {
    addUser("u-1");
    for (let i = 0; i < 5; i++) {
      const begun = await beginCall("u-1", scn, at(i * 100));
      if (!begun.ok) throw new Error(begun.error);
      expect(await endCall("u-1", begun.callId, "failed_connect", at(i * 100 + 1), { serverMintFailure: true })).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
      expect(session(begun.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    }
    // Five uncharged rows are past the cap of 3, so the next client-reported never-connected call bills a minute.
    expect((await runCall("u-1", { connectAt: null, endAt: 5, start: 1000 })).result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
  });

  it("B1: a server mint failure that surfaces after the 60s connect cutoff is still 0 billed, failed_connect", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const result = await endCall("u-1", begun.callId, "failed_connect", at(61), { serverMintFailure: true });
    expect(result).toMatchObject({ outcome: "failed_connect", endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    expect(session(begun.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(entries(begun.callId)).toHaveLength(0);
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
    // The same end reported by a client is a call that ran: the flag is what waives it.
    const second = await beginCall("u-1", scn, at(100));
    if (!second.ok) throw new Error(second.error);
    expect((await endCall("u-1", second.callId, "failed_connect", at(161)))!.billedMinutes).toBe(1);
  });

  it("B1: only the server can waive the charge: the end route ignores a serverMintFailure field", async () => {
    addUser("u-1");
    for (let i = 0; i < 3; i++) await runCall("u-1", { connectAt: null, endAt: 5, start: i * 100 });
    const begun = await beginCall("u-1", scn, at(400));
    if (!begun.ok) throw new Error(begun.error);
    const post = (body: unknown) => endRoute(new NextRequest("http://localhost/api/usage/end", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    vi.useFakeTimers();
    vi.setSystemTime(at(405));
    const res = await post({ callId: begun.callId, reason: "failed_connect", serverMintFailure: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: "billed", billedMinutes: 1 });
  });

  it("/api/usage/end rejects a server-only or unknown reason with 400 and settles nothing", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error(begun.error);
    const post = (reason: unknown) => endRoute(new NextRequest("http://localhost/api/usage/end", { method: "POST", body: JSON.stringify({ callId: begun.callId, reason }), headers: { "content-type": "application/json" } }));
    for (const reason of ["mint_failed", "cap_reached", "max_duration", "heartbeat_timeout", "serverMintFailure", "", 7, null]) {
      expect((await post(reason)).status).toBe(400);
    }
    expect(session(begun.callId)).toMatchObject({ endedAt: null, endReason: null, billedMinutes: 0 });
    expect(entries(begun.callId)).toHaveLength(0);
    expect(allowanceOf("u-1").minutesReserved).toBeGreaterThan(0); // still held: nothing was settled
  });

  it("B1: an honest user (a few calls, one honest drop, one failed connect) is never blocked or charged for the failures", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 120, start: 0 })).result.billedMinutes).toBe(2);
    expect((await runCall("u-1", { endAt: 12, reason: "network_drop", start: 1000, beats: false })).result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0 });
    expect((await runCall("u-1", { connectAt: null, endAt: 5, reason: "failed_connect", start: 2000 })).result).toMatchObject({ billedMinutes: 0 });
    expect((await runCall("u-1", { endAt: 61, start: 3000 })).result.billedMinutes).toBe(2);
  });

  it("the 21st voice mint in 24 hours is refused; a mint 24 hours after the first is allowed", async () => {
    addUser("u-1");
    for (let i = 0; i < 20; i++) {
      const begun = await beginCall("u-1", scn, at(i * 10));
      if (!begun.ok) throw new Error(begun.error);
      await endCall("u-1", begun.callId, "failed_connect", at(i * 10 + 1), { serverMintFailure: true }); // free of charge, so only the mint cap is in play
    }
    expect(await beginCall("u-1", scn, at(500))).toEqual({ ok: false, error: "daily_session_limit" });
    expect(fake.rows("trainerSession")).toHaveLength(20);
    // Another user is unaffected.
    addUser("u-2");
    expect((await beginCall("u-2", scn, at(500))).ok).toBe(true);
    // The first mint (at 0 s) is 24 hours old at exactly 24 h: the window is rolling, so one slot opens.
    expect((await beginCall("u-1", scn, at(24 * 3600 + 1))).ok).toBe(true);
  });

  it("the mint route answers 429 daily_session_limit with the user-facing message", async () => {
    addUser("u-1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    for (let i = 0; i < 20; i++) {
      const begun = await beginCall("u-1", scn, at(i));
      if (!begun.ok) throw new Error(begun.error);
      await endCall("u-1", begun.callId, "failed_connect", at(i), { serverMintFailure: true });
    }
    const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "daily_session_limit", message: "You've reached today's limit of 20 practice calls. Try again tomorrow, or switch to Text to practice now." });
  });

  it("a heartbeat-seen subsecond drop is billed a minute", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    await heartbeat("u-1", begun.callId, "ok", at(0.5));
    expect(await endCall("u-1", begun.callId, "network_drop", at(0.9))).toMatchObject({ outcome: "billed", billedMinutes: 1 });
  });

  it("a drop settlement locks the user row before counting; other endings take no lock (each mint takes one)", async () => {
    addUser("u-1");
    await runCall("u-1", { endAt: 20, reason: "user_hangup", beats: false });
    expect(fake.rawQueries).toHaveLength(1); // the mint's lock only
    const { callId } = await runCall("u-1", { endAt: 20, reason: "network_drop", start: 100, beats: false });
    expect(fake.rawQueries).toHaveLength(3); // + the second mint's lock + the drop's lock
    for (const q of fake.rawQueries) {
      expect(q.sql).toContain("FOR UPDATE");
      expect(q.values).toEqual(["u-1"]);
    }
    expect(session(callId).billedMinutes).toBe(0);
  });

  it("a mint locks the user row before it counts the day's sessions, so concurrent mints cannot overshoot the cap", async () => {
    addUser("u-1");
    const countCalls: number[] = [];
    const ts = fake.db.trainerSession as unknown as { count: (args: unknown) => Promise<number> };
    const real = ts.count;
    ts.count = async (args) => { countCalls.push(fake.rawQueries.length); return real(args); };
    const begun = await beginCall("u-1", scn, at(0));
    expect(begun.ok).toBe(true);
    // The mint's own count ran after its FOR UPDATE.
    expect(countCalls[0]).toBeGreaterThanOrEqual(1);
    expect(fake.rawQueries[0].sql).toContain("FOR UPDATE");
    expect(fake.rawQueries[0].values).toEqual(["u-1"]);
  });

  it("a heartbeat that commits between the end's read and its write turns the credit into a bill", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    fake.interleave("trainerSession", "updateMany", async () => { await heartbeat("u-1", begun.callId, "ok", at(10)); }, (a) => a.where.endedAt === null);
    const result = await endCall("u-1", begun.callId, "network_drop", at(20));
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1, creditedMinutes: 0 });
    expect(session(begun.callId)).toMatchObject({ billedMinutes: 1 });
    expect(allowanceOf("u-1").minutesUsed).toBe(1);
  });

  it("failed_connect shares the daily cap: free under it, one minute once drops have used it up", async () => {
    addUser("u-1");
    for (let i = 0; i < 4; i++) {
      expect((await runCall("u-1", { endAt: 20, reason: "network_drop", start: i * 100, beats: false })).result.outcome).toBe(i < 3 ? "dropped_credited" : "billed");
    }
    const { callId, result } = await runCall("u-1", { connectAt: null, endAt: 5, reason: "failed_connect", start: 500 });
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
    expect(entries(callId).map((e) => e.kind)).toEqual(["voice_call"]);
  });

  it("19: a provider error at 45s is billed", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 45, reason: "provider_error" })).result).toMatchObject({ outcome: "billed", billedMinutes: 1 });
  });

  it("25: a server error at 25s is credited", async () => {
    addUser("u-1");
    expect((await runCall("u-1", { endAt: 25, reason: "server_error", beats: false })).result).toMatchObject({ outcome: "dropped_credited", billedMinutes: 0 });
  });

  it("a client that stops heartbeating is not billed less for it: the call runs to the server's end time", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    await heartbeat("u-1", begun.callId, "ok", at(10));
    // Nothing for 10 minutes, then a hang-up: the provider connection may have been open the whole time.
    const result = await endCall("u-1", begun.callId, "user_hangup", at(600));
    expect(session(begun.callId).billableSeconds).toBe(600);
    expect(result?.billedMinutes).toBe(10);
  });

  it("an abandoned call is settled the next time its owner asks for usage, billed until then", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    await heartbeat("u-1", begun.callId, "ok", at(70));
    await usageSummary("u-1", at(500));
    expect(session(begun.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 9 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 9, minutesReserved: 0 });
  });
});

describe("idempotency", () => {
  it("11: duplicate and concurrent end events bill once", async () => {
    addUser("u-1");
    const { callId } = await runCall("u-1", { endAt: 61 });
    await Promise.all([endCall("u-1", callId, "user_hangup", at(70)), endCall("u-1", callId, "network_drop", at(80)), endCall("u-1", callId, "user_hangup", at(90))]);
    const again = await endCall("u-1", callId, "user_hangup", at(100));
    expect(again).toMatchObject({ billedMinutes: 2, outcome: "billed" });
    expect(entries(callId)).toHaveLength(1);
    expect(allowanceOf("u-1").minutesUsed).toBe(2);
  });

  it("a repeated end of a credited call returns the same credited result", async () => {
    addUser("u-1");
    const { callId } = await runCall("u-1", { endAt: 12, reason: "network_drop", beats: false });
    expect(await endCall("u-1", callId, "network_drop", at(50))).toMatchObject({ outcome: "dropped_credited", creditedMinutes: 1, billedMinutes: 0 });
    expect(entries(callId)).toHaveLength(2);
  });

  it("another user cannot end or bill someone else's call", async () => {
    addUser("u-1");
    addUser("u-2");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    expect(await endCall("u-2", begun.callId, "user_hangup", at(5))).toBeNull();
    expect((await heartbeat("u-2", begun.callId, "connected", at(1))).found).toBe(false);
  });
});

describe("caps", () => {
  it("12: a Free user with 0 minutes left is blocked before a call row exists", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 10;
    const r = await beginCall("u-1", scn, at(0));
    expect(r).toEqual({ ok: false, error: "cap_reached" });
    expect(fake.rows("trainerSession")).toHaveLength(0);
  });

  it("12: the realtime session route answers 402 cap_reached and never calls OpenAI", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, new Date());
    allowanceOf("u-1").minutesUsed = 10;
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("cap_reached");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("realtime session: mints with a callId when there is room, and settles the call if the mint fails", async () => {
    addUser("u-1");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const ok = await (await mint()).json();
    expect(typeof ok.callId).toBe("string");
    expect(session(ok.callId).userId).toBe("u-1");
    await endCall("u-1", ok.callId, "user_hangup"); // the first call holds all 10 minutes until it ends

    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    const bad = await mint();
    expect(bad.status).toBe(502);
    const failed = fake.rows("trainerSession").filter((s) => s.id !== ok.callId);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
  });

  it("after a successful mint, an SDP timeout does not release the reservation; a failed_connect end does", async () => {
    mocks.authId = "u-sdp";
    addUser("u-sdp");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_abc123456789", expires_at: 9999999999 }), { status: 200 })));
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const ok = await (await mint()).json();
    expect(typeof ok.callId).toBe("string");
    expect(session(ok.callId).endedAt).toBeNull();
    expect(allowanceOf("u-sdp").minutesReserved).toBeGreaterThan(0);

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const sdp = await sdpPOST(new NextRequest("http://localhost/api/realtime/sdp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientSecret: "ek_abc123456789", sdp: "v=0 offer sdp" }),
    }));
    const sdpText = await sdp.text();
    expect(sdp.status).toBe(502);
    expect(JSON.parse(sdpText).error).toBe("realtime_upstream_error");
    expect(sdpText).not.toContain("ek_abc123456789");
    expect(sdpText).not.toContain("sk-test-not-real");
    // SDP does not know the callId, so a failed connect leaves the mint holding the minutes.
    expect(session(ok.callId).endedAt).toBeNull();
    expect(allowanceOf("u-sdp").minutesReserved).toBeGreaterThan(0);

    const blocked = await mint();
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("minutes_reserved");

    const ended = await endCall("u-sdp", ok.callId, "failed_connect", new Date((session(ok.callId).createdAt as Date).getTime() + 5_000));
    expect(ended).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
    expect(session(ok.callId).endReason).toBe("failed_connect");
    expect(allowanceOf("u-sdp").minutesReserved).toBe(0);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_retry123456789", expires_at: 9999999999 }), { status: 200 })));
    const retry = await mint();
    expect(retry.status).toBe(200);
    const again = await retry.json();
    expect(again.callId).toBeTruthy();
    expect(again.callId).not.toBe(ok.callId);
  });

  it("a mint nobody ends stays reserved through the connect window, then stale-settles as a heartbeat timeout", async () => {
    mocks.authId = "u-stale";
    addUser("u-stale");
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const ok = await (await mint()).json();
    expect(typeof ok.callId).toBe("string");
    expect(session(ok.callId).endedAt).toBeNull();

    const created = session(ok.callId).createdAt as Date;
    await usageSummary("u-stale", new Date(created.getTime() + CONNECT_WINDOW_SECONDS * 1000));
    expect(session(ok.callId).endedAt).toBeNull();
    expect(allowanceOf("u-stale").minutesReserved).toBeGreaterThan(0);

    await usageSummary("u-stale", new Date(created.getTime() + (CONNECT_WINDOW_SECONDS + 1) * 1000));
    expect(session(ok.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 10 });
    expect(allowanceOf("u-stale")).toMatchObject({ minutesReserved: 0, minutesUsed: 10 });
  });

  it("13: a Pro user with 2 minutes left who talks 5 minutes is stopped at 2m and billed 2", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 198;
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    expect(begun.remaining).toBe(2);
    await heartbeat("u-1", begun.callId, "connected", at(0));
    let stopAt = -1;
    for (let t = 10; t <= 300; t += 10) {
      const r = await heartbeat("u-1", begun.callId, "ok", at(t));
      if (r.found && r.stop) { stopAt = t; expect(r.reason).toBe("cap_reached"); break; }
    }
    expect(stopAt).toBe(120);
    const result = await endCall("u-1", begun.callId, "user_hangup", at(300));
    expect(result).toMatchObject({ billedMinutes: 2, endReason: "cap_reached" });
    expect(allowanceOf("u-1").minutesUsed).toBe(200);
    expect((await beginCall("u-1", scn, at(400))).ok).toBe(false);
  });

  it("13: a client that never heartbeats past the cap still cannot be billed beyond what was left", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 198;
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    await heartbeat("u-1", begun.callId, "connected", at(0));
    for (let t = 10; t < 300; t += 10) {
      // Heartbeats that bypass the stop answer: a stubborn client keeps going.
      await heartbeat("u-1", begun.callId, "ok", at(t));
    }
    expect(allowanceOf("u-1").minutesUsed).toBeLessThanOrEqual(200);
  });

  it("14: team of 3 pools 900 minutes; after rep A uses 850, rep B gets 50", async () => {
    fake.seed("organization", { id: "org-1", code: "123", planTier: "team", seatCount: 3, createdAt: MAR10 });
    addUser("rep-a");
    addUser("rep-b");
    const pool = await ensureAllowance(fake.db as never, { organizationId: "org-1" }, at(0));
    expect(pool.minutesCap).toBe(900);
    fake.rows("usageAllowance")[0].minutesUsed = 845;
    await runCall("rep-a", { endAt: 300 });
    const b = await beginCall("rep-b", scn, at(1000));
    expect(b).toMatchObject({ ok: true, remaining: 50, pooled: true });
    expect(fake.rows("usageAllowance")).toHaveLength(1);
  });

  it("14: rep B is stopped when the shared pool runs out", async () => {
    fake.seed("organization", { id: "org-1", code: "123", planTier: "team", seatCount: 3, createdAt: MAR10 });
    addUser("rep-b");
    await ensureAllowance(fake.db as never, { organizationId: "org-1" }, at(0));
    fake.rows("usageAllowance")[0].minutesUsed = 850;
    const { result } = await runCall("rep-b", { endAt: 3600 });
    expect(result).toMatchObject({ billedMinutes: 50, endReason: "cap_reached" });
    expect(fake.rows("usageAllowance")[0].minutesUsed).toBe(900);
    expect((await beginCall("rep-b", scn, at(4000))).ok).toBe(false);
  });

  it("15: a seat added mid-period raises the pool cap by 300 immediately and keeps minutesUsed", async () => {
    const org = fake.seed("organization", { id: "org-1", code: "123", planTier: "team", seatCount: 3, createdAt: MAR10 });
    addUser("rep-a");
    await ensureAllowance(fake.db as never, { organizationId: "org-1" }, at(0));
    fake.rows("usageAllowance")[0].minutesUsed = 400;
    fake.rows("organization").find((o) => o.id === org.id)!.seatCount = 4;
    const r = await resolveAllowance(fake.db as never, "rep-a", at(60));
    expect(r?.allowance).toMatchObject({ minutesCap: 1200, minutesUsed: 400 });
    expect(r?.remaining).toBe(800);
  });
});

describe("period reset", () => {
  it("16: rollover resets minutesUsed to 0 and keeps the ledger", async () => {
    addUser("u-1");
    const { callId } = await runCall("u-1", { endAt: 190 });
    expect(allowanceOf("u-1").minutesUsed).toBe(4);
    // T0 is Oct 15; the anchor day is the 10th, so Nov 10 starts a new period.
    const next = new Date("2026-11-10T12:00:00Z");
    const r = await resolveAllowance(fake.db as never, "u-1", next);
    expect(r?.allowance.minutesUsed).toBe(0);
    expect(r?.allowance.periodStart.toISOString()).toBe("2026-11-10T12:00:00.000Z");
    expect(entries(callId)).toHaveLength(1);
  });

  it("21: signed up Mar 10 with 5 minutes left; when Apr 10 arrives the allowance is 10, not 15", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, new Date("2026-04-05T00:00:00Z"));
    allowanceOf("u-1").minutesUsed = 5;
    const before = await resolveAllowance(fake.db as never, "u-1", new Date("2026-04-09T00:00:00Z"));
    expect(before?.remaining).toBe(5);
    const after = await resolveAllowance(fake.db as never, "u-1", new Date("2026-04-10T12:00:00Z"));
    expect(after?.remaining).toBe(10);
  });

  it("22: a Jan 31 signup resets on Feb 28, then Mar 31", async () => {
    addUser("u-1", { usageAnchorAt: new Date("2026-01-31T08:00:00Z") });
    const used = async (when: string, n?: number) => {
      const r = await resolveAllowance(fake.db as never, "u-1", new Date(when));
      if (n !== undefined) allowanceOf("u-1").minutesUsed = n;
      return r!.allowance;
    };
    await used("2026-02-01T00:00:00Z", 9);
    expect((await used("2026-02-27T23:00:00Z")).minutesUsed).toBe(9);
    expect(await used("2026-02-28T08:00:00Z")).toMatchObject({ minutesUsed: 0 });
    await used("2026-03-01T00:00:00Z", 7);
    expect((await used("2026-03-30T23:00:00Z")).minutesUsed).toBe(7);
    expect((await used("2026-03-31T08:00:00Z")).minutesUsed).toBe(0);
  });

  it("23: upgrading to Pro mid-period keeps the anchor and raises the cap for the current period", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    allowanceOf("u-1").minutesUsed = 12;
    const anchorBefore = allowanceOf("u-1").anchorAt as Date;
    fake.rows("user")[0].planTier = "pro";
    const r = await resolveAllowance(fake.db as never, "u-1", at(3600));
    expect(r?.allowance).toMatchObject({ planTier: "pro", minutesCap: 200, minutesUsed: 12 });
    expect((r?.allowance.anchorAt as Date).getTime()).toBe(anchorBefore.getTime());
    expect(r?.remaining).toBe(188);
  });
});

describe("support credit and display", () => {
  it("20: a manual credit of 5 lowers minutesUsed by 5, adds a credit_manual entry and an audit event", async () => {
    addUser("u-1");
    await runCall("u-1", { endAt: 600 });
    expect(allowanceOf("u-1").minutesUsed).toBe(10);
    const r = await creditManual({ targetUserId: "u-1", minutes: 5, actorId: "admin-1", reason: "Dropped call ticket 123" }, at(1000));
    expect(r?.minutesUsed).toBe(5);
    const manual = fake.rows("usageEntry").filter((e) => e.kind === "credit_manual");
    expect(manual).toHaveLength(1);
    expect(manual[0].minutes).toBe(-5);
    expect(fake.rows("auditEvent")[0]).toMatchObject({ action: "usage.credit_manual", userId: "admin-1" });
  });

  it("the credit route is for platform admins only", async () => {
    addUser("u-1");
    fake.seed("user", { id: "admin-1", email: "a@example.test", isPlatformAdmin: true });
    const post = () => creditRoute(new NextRequest("http://localhost/api/usage/credit", { method: "POST", body: JSON.stringify({ userId: "u-1", minutes: 5, reason: "Goodwill" }), headers: { "content-type": "application/json" } }));
    mocks.authId = "u-1";
    expect((await post()).status).toBe(403);
    expect(fake.rows("usageEntry")).toHaveLength(0);
    mocks.authId = "admin-1";
    const res = await post();
    expect(res.status).toBe(200);
    expect(fake.rows("usageEntry")).toHaveLength(1);
  });

  it("usage shown to the user matches the ledger", async () => {
    addUser("u-1");
    await runCall("u-1", { endAt: 190 });
    await runCall("u-1", { endAt: 12, reason: "network_drop", start: 1000 });
    await creditManual({ targetUserId: "u-1", minutes: 1, actorId: "admin-1", reason: "Goodwill" }, at(2000));
    const s = await usageSummary("u-1", at(2100));
    const ledger = fake.rows("usageEntry").reduce((n, e) => n + (e.minutes as number), 0);
    expect(s?.minutesUsed).toBe(ledger);
    expect(s?.remaining).toBe(10 - ledger);
  });
});

describe("what is not metered, and what a client cannot change", () => {
  const save = (body: Record<string, unknown>) =>
    saveTranscript(new NextRequest("http://localhost/api/transcripts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  const transcript = [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi there" }];

  it("17: a 20 minute text session writes no usage", async () => {
    addUser("u-1");
    const res = await save({ sessionId: "text-1", transcript, durationSeconds: 1200, scenario: { id: "quote-follow-up" } });
    expect(res.status).toBe(200);
    expect(fake.rows("usageEntry")).toHaveLength(0);
    expect(fake.rows("usageAllowance")).toHaveLength(0);
    expect(fake.rows("trainerSession")[0]).toMatchObject({ durationSeconds: 1200, billedMinutes: 0, billableSeconds: 0, connectedAt: null });
  });

  it("saving a voice call's transcript fills its metered row instead of adding a second one", async () => {
    addUser("u-1");
    const { callId } = await runCall("u-1", { endAt: 61 });
    const res = await save({ sessionId: "voice-1", callId, transcript, durationSeconds: 61, scenario: { id: "quote-follow-up" } });
    expect(res.status).toBe(200);
    expect(fake.rows("trainerSession")).toHaveLength(1);
    expect(session(callId)).toMatchObject({ billedMinutes: 2, realtimeSessionId: "voice-1" });
    expect(session(callId).transcript).toHaveLength(2);
  });

  it("18: a client that sends a fake long duration or its own timestamps is billed by the server's clock", async () => {
    addUser("u-1");
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const begun = await beginCall("u-1", scn);
    if (!begun.ok) throw new Error();
    const post = (route: typeof endRoute, body: Record<string, unknown>) =>
      route(new NextRequest("http://localhost/api/usage/x", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
    expect((await post(heartbeatRoute, { callId: begun.callId, state: "connected", connectedAt: "2020-01-01T00:00:00Z" })).status).toBe(200);
    for (let t = 10; t <= 50; t += 10) {
      vi.setSystemTime(at(t));
      await post(heartbeatRoute, { callId: begun.callId, state: "ok", durationSeconds: 99999 });
    }
    vi.setSystemTime(at(61));
    const res = await post(endRoute, { callId: begun.callId, reason: "user_hangup", durationSeconds: 99999, billableSeconds: 99999, connectedAt: "2020-01-01T00:00:00Z", endedAt: "2020-01-01T00:00:01Z" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ billedMinutes: 2, billableSeconds: 61 });
    expect(allowanceOf("u-1").minutesUsed).toBe(2);
  });

  it("a client cannot report a server-only end reason", async () => {
    addUser("u-1");
    const begun = await beginCall("u-1", scn, at(0));
    if (!begun.ok) throw new Error();
    const res = await endRoute(new NextRequest("http://localhost/api/usage/end", { method: "POST", body: JSON.stringify({ callId: begun.callId, reason: "heartbeat_timeout" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(400);
  });

  it("metering routes are off in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await endRoute(new NextRequest("http://localhost/api/usage/end", { method: "POST", body: JSON.stringify({ callId: "x", reason: "user_hangup" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(404);
  });
});
