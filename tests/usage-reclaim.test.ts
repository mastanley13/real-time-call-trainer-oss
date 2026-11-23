import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePrisma } from "./fakePrisma";

// A voice call that was minted but never connected (no heartbeat, no connectedAt) used to hold its reservation for the
// whole 15 minute connect window, so a rep whose first connect failed got minutes_reserved on every retry. A NEW start
// now reclaims such a call once it is older than NEVER_CONNECTED_RECLAIM_SECONDS; usage reads keep the 15 minute window.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { beginCall, heartbeat, usageSummary } from "@/lib/usage";
import { CONNECT_WINDOW_SECONDS, NEVER_CONNECTED_RECLAIM_SECONDS } from "@/lib/usagePlan";

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
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;
const entries = (callId: string) => fake.rows("usageEntry").filter((e) => e.trainerSessionId === callId);

async function mint(userId: string, sec: number) {
  const r = await beginCall(userId, scn, at(sec));
  if (!r.ok) throw new Error(r.error);
  return r;
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a new start reclaims a call that never connected", () => {
  it("the window is 45 s", () => {
    expect(NEVER_CONNECTED_RECLAIM_SECONDS).toBe(45);
  });

  it("at 30 s after an unheartbeated mint, a new start still gets minutes_reserved and the first call is untouched", async () => {
    addUser("u-1"); // Free: the first call reserves every remaining minute
    const first = await mint("u-1", 0);
    expect(allowanceOf("u-1").minutesReserved).toBe(10);
    expect(await beginCall("u-1", scn, at(30))).toEqual({ ok: false, error: "minutes_reserved" });
    expect(session(first.callId)).toMatchObject({ endedAt: null, endReason: null });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 10 });
  });

  it("exactly at 45 s it is still left alone; past 45 s it is closed as failed_connect, 0 s, and the new call starts", async () => {
    addUser("u-1");
    const first = await mint("u-1", 0);
    expect(await beginCall("u-1", scn, at(45))).toEqual({ ok: false, error: "minutes_reserved" });
    const second = await mint("u-1", 46);
    expect(session(first.callId)).toMatchObject({ endReason: "failed_connect", billableSeconds: 0, billedMinutes: 0, connectedAt: null, lastHeartbeatAt: null });
    expect(session(first.callId).endedAt).toEqual(at(46));
    expect(entries(first.callId)).toHaveLength(0);
    // The first call's reservation was released and the second call holds all of it again.
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 10 });
    expect(session(second.callId)).toMatchObject({ endedAt: null, reservedMinutes: 10 });
  });

  it("a heartbeat for a reclaimed call gets the existing stop answer and records nothing", async () => {
    addUser("u-1");
    const first = await mint("u-1", 0);
    await mint("u-1", 50);
    expect(await heartbeat("u-1", first.callId, "connected", at(55))).toEqual({ found: true, stop: true, reason: "ended", settlement: null });
    expect(session(first.callId)).toMatchObject({ connectedAt: null, lastHeartbeatAt: null, endReason: "failed_connect", billedMinutes: 0 });
  });

  it("a call with a heartbeat at 25 s is never reclaimed by the new rule", async () => {
    addUser("u-1");
    const first = await mint("u-1", 0);
    await heartbeat("u-1", first.callId, "connected", at(25));
    expect(await beginCall("u-1", scn, at(46))).toEqual({ ok: false, error: "minutes_reserved" });
    expect(session(first.callId)).toMatchObject({ endedAt: null, connectedAt: at(25) });
    expect(allowanceOf("u-1").minutesReserved).toBe(10);
  });

  it("a heartbeat without connectedAt also keeps the call (any heartbeat proves it connected)", async () => {
    addUser("u-1", { planTier: "pro" });
    const first = await mint("u-1", 0);
    await heartbeat("u-1", first.callId, "ok", at(25));
    await mint("u-1", 50);
    expect(session(first.callId)).toMatchObject({ endedAt: null, connectedAt: null, lastHeartbeatAt: at(25) });
  });

  it("a usage read at 46 s does not close it: reads keep the 15 minute connect window", async () => {
    addUser("u-1");
    const first = await mint("u-1", 0);
    await usageSummary("u-1", at(46));
    await usageSummary("u-1", at(CONNECT_WINDOW_SECONDS));
    expect(session(first.callId)).toMatchObject({ endedAt: null, endReason: null });
    expect(allowanceOf("u-1").minutesReserved).toBe(10);
    // Only past the window does a read close it, as before.
    await usageSummary("u-1", at(CONNECT_WINDOW_SECONDS + 1));
    expect(session(first.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(allowanceOf("u-1").minutesReserved).toBe(0);
  });

  it("a first heartbeat that commits during the reclaim keeps the call open: nothing closed, nothing billed", async () => {
    addUser("u-1", { planTier: "pro" });
    const first = await mint("u-1", 0);
    // The reclaim read the row with no heartbeat; the first heartbeat commits just before its settlement write.
    fake.interleave("trainerSession", "updateMany", async () => { await heartbeat("u-1", first.callId, "connected", at(44)); },
      (args) => "endedAt" in args.data && args.where.id === first.callId);
    const second = await mint("u-1", 46);
    expect(session(first.callId)).toMatchObject({ endedAt: null, endReason: null, connectedAt: at(44), lastHeartbeatAt: at(44), billedMinutes: 0 });
    expect(entries(first.callId)).toHaveLength(0);
    // Both calls hold their reservations: 60 each on Pro.
    expect(session(second.callId)).toMatchObject({ endedAt: null, reservedMinutes: 60 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 120 });
  });

  it("the same race on Free: the call that connected keeps every minute, and the new start gets minutes_reserved", async () => {
    addUser("u-1");
    const first = await mint("u-1", 0);
    fake.interleave("trainerSession", "updateMany", async () => { await heartbeat("u-1", first.callId, "connected", at(44)); },
      (args) => "endedAt" in args.data && args.where.id === first.callId);
    expect(await beginCall("u-1", scn, at(46))).toEqual({ ok: false, error: "minutes_reserved" });
    expect(session(first.callId)).toMatchObject({ endedAt: null, connectedAt: at(44) });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 10 });
  });
});

describe("two tabs start at once", () => {
  it("the second start reclaims the first only once it is past 45 s with no heartbeat", async () => {
    addUser("u-1");
    const tabA = await mint("u-1", 0);
    // Tab B a moment later: tab A may still be connecting, so it keeps its minutes.
    expect(await beginCall("u-1", scn, at(5))).toEqual({ ok: false, error: "minutes_reserved" });
    expect(session(tabA.callId).endedAt).toBeNull();
    // Tab B again after tab A sat unconnected for over 45 s: tab A is reclaimed, tab B starts.
    const tabB = await mint("u-1", 60);
    expect(session(tabA.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    // If tab A connects after all, its first heartbeat is told to stop; tab B is unaffected.
    expect(await heartbeat("u-1", tabA.callId, "connected", at(70))).toMatchObject({ stop: true, reason: "ended" });
    expect(await heartbeat("u-1", tabB.callId, "connected", at(70))).toMatchObject({ stop: false });
  });

  it("with minutes for both (Pro), both start and neither touches the other while the first is under 45 s", async () => {
    addUser("u-1", { planTier: "pro" });
    const tabA = await mint("u-1", 0);
    const tabB = await mint("u-1", 2);
    expect(session(tabA.callId).endedAt).toBeNull();
    expect(session(tabB.callId).endedAt).toBeNull();
    expect(allowanceOf("u-1").minutesReserved).toBe(120);
  });

  it("starts are serialized: beginCall locks the user row before it settles or reclaims anything", async () => {
    addUser("u-1");
    const from = fake.calls.length;
    await mint("u-1", 0);
    const calls = fake.calls.slice(from);
    expect(calls[0]).toBe('raw:SELECT "id" FROM "User" WHERE "id" = ? FOR UPDATE');
  });
});
