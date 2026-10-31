import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Same fakes as usage-hardening.test.ts: only the database and the session check are replaced.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, endCall, heartbeat, settleStale } from "@/lib/usage";
import { maxMinutesAfter, splitAcrossBoundary, VOICE_BLOCK_SECONDS, OVERRUN_GRACE_SECONDS } from "@/lib/usagePlan";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";

const MAR10 = new Date("2026-03-10T12:00:00Z");
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
const utc = (s: string) => new Date(`2026-${s}Z`);

let fake: ReturnType<typeof createFakePrisma>;
let base: Date;
let shift = 0;
const at = (sec: number) => new Date(base.getTime() + sec * 1000);

function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const orgAllowance = () => fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;
const userRow = (id: string) => fake.rows("user").find((u) => u.id === id)!;

async function begin(userId: string, when: Date) {
  const r = await beginCall(userId, scn, when);
  if (!r.ok) throw new Error(r.error);
  await heartbeat(userId, r.callId, "connected", when);
  return r;
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  base = new Date(new Date("2026-10-15T12:00:00Z").getTime() + ++shift * 2 * 3_600_000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(base);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("period split helpers", () => {
  const start = 1_000_000_000_000;
  it("splitAcrossBoundary keeps the total and rounds the earlier part up on its own", () => {
    expect(splitAcrossBoundary({ startMs: start, billableSeconds: 240, boundaryMs: start + 60_000, grossMinutes: 4 })).toEqual({ oldMinutes: 1, newMinutes: 3, oldSeconds: 60 });
    expect(splitAcrossBoundary({ startMs: start, billableSeconds: 61, boundaryMs: start + 1000, grossMinutes: 2 })).toEqual({ oldMinutes: 1, newMinutes: 1, oldSeconds: 1 });
    expect(splitAcrossBoundary({ startMs: start, billableSeconds: 120, boundaryMs: start - 5000, grossMinutes: 2 })).toMatchObject({ oldMinutes: 0, newMinutes: 2 });
    expect(splitAcrossBoundary({ startMs: start, billableSeconds: 120, boundaryMs: start + 999_000, grossMinutes: 2 })).toMatchObject({ oldMinutes: 2, newMinutes: 0 });
  });
  it("maxMinutesAfter is what an open call can still use after the boundary", () => {
    expect(maxMinutesAfter({ startMs: start, reservedMinutes: 20, boundaryMs: start + 60_000 })).toBe(19);
    expect(maxMinutesAfter({ startMs: start, reservedMinutes: 20, boundaryMs: start + 20 * 60_000 })).toBe(0);
    expect(maxMinutesAfter({ startMs: start, reservedMinutes: 20, boundaryMs: start - 60_000 })).toBe(20);
  });
});

describe("Premium minutes are reserved at mint", () => {
  it("concurrent calls cannot all pick Premium: the share is held by the calls that already have it", async () => {
    addUser("u-1", { planTier: "pro", premiumVoice: true }); // 200 minutes, Premium limit 120
    const a = await beginCall("u-1", scn, at(0));
    const b = await beginCall("u-1", scn, at(1));
    const c = await beginCall("u-1", scn, at(2));
    if (!a.ok || !b.ok || !c.ok) throw new Error("begin failed");
    expect([a.engine, b.engine, c.engine]).toEqual(["premium", "premium", "standard"]);
    expect(session(a.callId).premiumReservedMinutes).toBe(60);
    expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 180, premiumMinutesReserved: 120 });
  });

  it("a call that holds only part of the Premium share is not ended at the limit; the rest books as standard", async () => {
    addUser("u-1", { planTier: "pro", premiumVoice: true });
    const a = await beginCall("u-1", scn, at(0)); // 60 premium
    const b = await beginCall("u-1", scn, at(1)); // 60 premium
    const c = await beginCall("u-1", scn, at(2)); // standard
    if (!a.ok || !b.ok || !c.ok) throw new Error("begin failed");
    await heartbeat("u-1", a.callId, "connected", at(0));
    // a ends after 10 minutes: 10 premium minutes used, the other 50 it held go back.
    await endCall("u-1", a.callId, "user_hangup", at(600));
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesUsed: 10, premiumMinutesReserved: 60 });
    // That freed Premium share is available to the next call, which holds all 50.
    const d = await beginCall("u-1", scn, at(700));
    if (!d.ok) throw new Error(d.error);
    expect(d.engine).toBe("premium");
    expect(session(d.callId).premiumReservedMinutes).toBe(50);
    // d runs 55 minutes: 50 book as Premium, 5 as standard. It was never stopped.
    await heartbeat("u-1", d.callId, "connected", at(700));
    const r = await heartbeat("u-1", d.callId, "ok", at(700 + 55 * 60));
    expect(r).toMatchObject({ found: true, stop: false });
    await endCall("u-1", d.callId, "user_hangup", at(700 + 55 * 60));
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesUsed: 60, premiumMinutesReserved: 60 });
    expect(allowanceOf("u-1").minutesUsed).toBe(65);
  });

  it("a failed mint releases its Premium share", async () => {
    addUser("u-1", { planTier: "pro", premiumVoice: true });
    const a = await beginCall("u-1", scn, at(0));
    if (!a.ok) throw new Error(a.error);
    await endCall("u-1", a.callId, "failed_connect", at(5));
    expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 0, premiumMinutesReserved: 0, premiumMinutesUsed: 0 });
  });
});

describe("a call that crosses the monthly reset", () => {
  it("a call that fails within 30 seconds across the reset is still credited in full", async () => {
    addUser("u-1");
    const c = await begin("u-1", utc("10-10T11:59:45"));
    await endCall("u-1", c.callId, "network_drop", utc("10-10T12:00:10"));
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
    expect(session(c.callId)).toMatchObject({ billedMinutes: 0 });
  });

  it("a long call is split between the two periods in the ledger and only the new part counts now", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await begin("u-1", utc("10-10T11:30:00"));
    await endCall("u-1", c.callId, "user_hangup", utc("10-10T12:10:00"));
    expect(session(c.callId)).toMatchObject({ billableSeconds: 2400, billedMinutes: 40 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 10, minutesReserved: 0 });
    const kinds = Object.fromEntries(fake.rows("usageEntry").map((e) => [e.kind as string, e.minutes]));
    expect(kinds).toEqual({ voice_call: 10, voice_call_prior: 30 });
  });

  it("concurrent old-period calls cannot spend more than the new period's cap", async () => {
    // A Team pool of 900 minutes is downgraded to the 20 minute Free cap while three 60 minute calls are open.
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3 });
    for (const id of ["u-1", "u-2", "u-3"]) addUser(id);
    const calls = [];
    for (const id of ["u-1", "u-2", "u-3"]) calls.push(await begin(id, utc("10-10T11:59:00")));
    expect(orgAllowance()).toMatchObject({ minutesReserved: 180 });
    fake.rows("organization")[0].planTier = "free";

    const cap = () => (orgAllowance().minutesUsed as number) + (orgAllowance().minutesReserved as number);
    for (const [i, c] of calls.entries()) {
      await endCall(`u-${i + 1}`, c.callId, "user_hangup", utc("10-10T12:30:00"));
      expect(cap()).toBeLessThanOrEqual(20);
    }
    // The first call held the 20 minutes; the others were not charged anything in the new period.
    expect(orgAllowance()).toMatchObject({ minutesCap: 20, minutesUsed: 20, minutesReserved: 0 });
    expect(session(calls[0].callId).carriedMinutes).toBe(20);
    expect(session(calls[1].callId).carriedMinutes).toBe(0);
  });

  it("calls that fit inside the new cap are charged in full", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3 });
    addUser("u-1");
    addUser("u-2");
    const a = await begin("u-1", utc("10-10T11:59:00"));
    const b = await begin("u-2", utc("10-10T11:59:00"));
    await endCall("u-1", a.callId, "user_hangup", utc("10-10T12:30:00"));
    await endCall("u-2", b.callId, "user_hangup", utc("10-10T12:30:00"));
    // 31 minutes each: 1 before the reset, 30 after.
    expect(orgAllowance()).toMatchObject({ minutesUsed: 60, minutesReserved: 0 });
    expect(fake.rows("usageEntry").filter((e) => e.kind === "voice_call_prior").map((e) => e.minutes)).toEqual([1, 1]);
  });
});

describe("calls that outlive their reservation", () => {
  const RESERVED = 3600; // a Pro user's 200 minutes reserve 60

  async function flaggedCall() {
    addUser("u-1", { planTier: "pro" });
    const c = await begin("u-1", at(0));
    const stop = await heartbeat("u-1", c.callId, "ok", at(RESERVED));
    expect(stop).toMatchObject({ found: true, stop: true, reason: "cap_reached" });
    return c;
  }

  it("a client that stops when told is not flagged", async () => {
    const c = await flaggedCall();
    await heartbeat("u-1", c.callId, "ok", at(RESERVED + 10));
    expect(session(c.callId).abuseFlagged).toBe(false);
    expect(userRow("u-1").voiceBlockedUntil).toBeNull();
  });

  it("a client still heartbeating after the stop is flagged, blocked for 10 minutes, and audited once", async () => {
    const c = await flaggedCall();
    const flaggedAt = at(RESERVED + OVERRUN_GRACE_SECONDS + 1);
    await heartbeat("u-1", c.callId, "ok", flaggedAt);
    await heartbeat("u-1", c.callId, "ok", at(RESERVED + OVERRUN_GRACE_SECONDS + 11));
    expect(session(c.callId).abuseFlagged).toBe(true);
    expect((userRow("u-1").voiceBlockedUntil as Date).getTime()).toBe(flaggedAt.getTime() + VOICE_BLOCK_SECONDS * 1000);
    expect(fake.rows("auditEvent").filter((e) => e.action === "usage.abuse_flagged")).toHaveLength(1);
    // The charge is still capped at the reservation.
    expect(allowanceOf("u-1").minutesUsed).toBe(60);
  });

  it("the next mint is refused for 10 minutes, then allowed", async () => {
    const c = await flaggedCall();
    const flaggedAt = at(RESERVED + OVERRUN_GRACE_SECONDS + 1);
    await heartbeat("u-1", c.callId, "ok", flaggedAt);
    const blocked = await beginCall("u-1", scn, new Date(flaggedAt.getTime() + 60_000));
    expect(blocked).toEqual({ ok: false, error: "voice_blocked", retryAfterSeconds: VOICE_BLOCK_SECONDS - 60 });
    expect((await beginCall("u-1", scn, new Date(flaggedAt.getTime() + VOICE_BLOCK_SECONDS * 1000 + 1))).ok).toBe(true);
  });

  it("the mint routes answer 429 with Retry-After while the block lasts, and mint nothing", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    const sent = vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 }));
    vi.stubGlobal("fetch", sent);
    addUser("u-1", { planTier: "pro" });
    userRow("u-1").voiceBlockedUntil = new Date(base.getTime() + 5 * 60_000);
    const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("voice_blocked");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(sent).not.toHaveBeenCalled();
    expect(fake.rows("trainerSession")).toHaveLength(0);
  });

  it("an end event reported long after the reservation ran out is flagged; one on time is not", async () => {
    addUser("u-1", { planTier: "pro" });
    const late = await begin("u-1", at(0));
    await endCall("u-1", late.callId, "user_hangup", at(RESERVED + 300));
    expect(session(late.callId)).toMatchObject({ abuseFlagged: true, billedMinutes: 60 });

    addUser("u-2", { planTier: "pro" });
    const ok = await begin("u-2", at(0));
    await endCall("u-2", ok.callId, "user_hangup", at(RESERVED - 30));
    expect(session(ok.callId).abuseFlagged).toBe(false);
    expect(userRow("u-2").voiceBlockedUntil).toBeNull();
  });

  it("a silent client settled by the server is not treated as abuse", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await begin("u-1", at(0));
    await fake.db.$transaction(async (tx) => settleStale(tx as never, "u-1", at(RESERVED * 2)));
    expect(session(c.callId)).toMatchObject({ abuseFlagged: false });
    expect(userRow("u-1").voiceBlockedUntil).toBeNull();
  });
});
