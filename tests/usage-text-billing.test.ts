import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// SAL-1018: stale text sessions were settled as abandoned voice calls and billed at the full reservation. The database
// and the session check are the only fakes; metering, the ledger and the routes run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import {
  TEXT_BILLING_TICKET, beginCall, closeNeverConnectedCall, creditTextBillingRefund, endCall, ensureAllowance, heartbeat,
  planNeverConnectedClose, planTextBillingRefund, provedConnected, usageSummary,
} from "@/lib/usage";
import { CONNECT_WINDOW_SECONDS, DAILY_DROP_CREDIT_CAP } from "@/lib/usagePlan";
import { POST as saveTranscript } from "@/app/api/transcripts/route";

const T0 = new Date("2026-10-15T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const DAY = 24 * 3600;
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

/** A text save as the old POST /api/transcripts wrote it: no allowance, no metering fields, and no endedAt. */
function seedOldTextSession(userId: string, createdAt: Date) {
  return fake.seed("trainerSession", {
    userId, organizationId: "org-1", scenarioId: "quote-follow-up", durationSeconds: 32, createdAt,
    transcript: [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi there" }],
  });
}

async function mint(userId: string, sec = 0) {
  const r = await beginCall(userId, scn, at(sec));
  if (!r.ok) throw new Error(r.error);
  return r;
}

const save = (body: Record<string, unknown>) =>
  saveTranscript(new NextRequest("http://localhost/api/transcripts", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
const transcript = [{ role: "user", text: "Hello" }, { role: "assistant", text: "Hi there" }];

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

describe("provedConnected", () => {
  it("needs an allowance and a recorded connection, never age", () => {
    const t = new Date();
    expect(provedConnected({ allowanceId: "a", connectedAt: t, lastHeartbeatAt: t })).toBe(true);
    expect(provedConnected({ allowanceId: "a", connectedAt: null, lastHeartbeatAt: t })).toBe(true);
    expect(provedConnected({ allowanceId: "a", connectedAt: null, lastHeartbeatAt: null })).toBe(false);
    expect(provedConnected({ allowanceId: null, connectedAt: t, lastHeartbeatAt: t })).toBe(false);
  });
});

describe("stale text sessions are never billed", () => {
  it("the prod case: a 32 second text session left open for days is untouched by settleStale and bills nothing", async () => {
    addUser("u-1");
    const text = seedOldTextSession("u-1", at(-3 * DAY));
    await usageSummary("u-1", at(0));
    await mint("u-1", 0); // beginCall runs settleStale too
    expect(session(text.id)).toMatchObject({ endedAt: null, endReason: null, billedMinutes: 0, billableSeconds: 0, connectedAt: null, allowanceId: null });
    expect(entries(text.id)).toHaveLength(0);
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
  });

  it("ending or heartbeating a text row by id never charges the user's allowance", async () => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    const text = seedOldTextSession("u-1", at(-DAY));
    await heartbeat("u-1", text.id, "connected", at(0));
    await endCall("u-1", text.id, "user_hangup", at(600));
    expect(entries(text.id)).toHaveLength(0);
    expect(fake.rows("usageEntry")).toHaveLength(0);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
    expect(session(text.id)).toMatchObject({ endedAt: null, billedMinutes: 0 });
  });
});

describe("stale voice sessions", () => {
  it("never connected (no connectedAt, no heartbeat): closed as failed_connect, 0 billed, reservation released", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    expect(allowanceOf("u-1").minutesReserved).toBe(60);
    await usageSummary("u-1", at(3 * DAY));
    expect(session(c.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0, connectedAt: null });
    expect(session(c.callId).endedAt).toEqual(at(3 * DAY));
    expect(entries(c.callId)).toHaveLength(0);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  it("every never-connected close bills 0, stale or client-reported, however many came before", async () => {
    addUser("u-1");
    for (let i = 0; i < DAILY_DROP_CREDIT_CAP + 1; i++) {
      const c = await mint("u-1", i * 10);
      expect(await endCall("u-1", c.callId, "failed_connect", at(i * 10 + 2))).toMatchObject({ outcome: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    }
    const stale = await mint("u-1", 100);
    await usageSummary("u-1", at(100 + CONNECT_WINDOW_SECONDS + 1));
    expect(session(stale.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    const reported = await mint("u-1", 2000);
    expect(await endCall("u-1", reported.callId, "user_hangup", at(2400))).toMatchObject({ outcome: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    expect(fake.rows("usageEntry")).toHaveLength(0);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  it("inside the connect window a never-connected call stays open and keeps its reservation", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    await usageSummary("u-1", at(CONNECT_WINDOW_SECONDS));
    expect(session(c.callId).endedAt).toBeNull();
    expect(allowanceOf("u-1").minutesReserved).toBe(60);
  });

  it("a connected call that went silent is still billed from connectedAt until the server noticed", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    await heartbeat("u-1", c.callId, "connected", at(10));
    await heartbeat("u-1", c.callId, "ok", at(20));
    await usageSummary("u-1", at(300));
    expect(session(c.callId)).toMatchObject({ endReason: "heartbeat_timeout", billableSeconds: 290, billedMinutes: 5 });
    expect(entries(c.callId)).toMatchObject([{ kind: "voice_call", minutes: 5 }]);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 5, minutesReserved: 0 });
  });

  it("a connected call silent past its reservation is clamped to it, as before", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    await heartbeat("u-1", c.callId, "connected", at(0));
    await usageSummary("u-1", at(2 * 3600));
    expect(session(c.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 60 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 60, minutesReserved: 0 });
  });
});

describe("races between a heartbeat and a settlement", () => {
  const isHeartbeatWrite = (args: { data: Record<string, unknown> }) => "lastHeartbeatAt" in args.data && !("endedAt" in args.data);
  const isSettlementWrite = (args: { data: Record<string, unknown> }) => "endedAt" in args.data;

  it("a heartbeat that loses to closeNeverConnectedCall records nothing, no connection included, and says stop", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    const closeAt = at(CONNECT_WINDOW_SECONDS + 60);
    // The heartbeat read the row while it was open; the close commits between that read and the heartbeat's write.
    fake.interleave("trainerSession", "updateMany", async () => { await closeNeverConnectedCall(c.callId, closeAt); }, isHeartbeatWrite);
    const hb = await heartbeat("u-1", c.callId, "connected", at(30));
    expect(hb).toEqual({ found: true, stop: true, reason: "ended", settlement: null });
    expect(session(c.callId)).toMatchObject({ connectedAt: null, lastHeartbeatAt: null, endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 });
    expect(session(c.callId).endedAt).toEqual(closeAt);
    expect(entries(c.callId)).toHaveLength(0);
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  it("a heartbeat that loses to settleStale says stop and leaves the closed row and the allowance alone", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    fake.interleave("trainerSession", "updateMany", async () => { await usageSummary("u-1", at(CONNECT_WINDOW_SECONDS + 1)); }, isHeartbeatWrite);
    expect(await heartbeat("u-1", c.callId, "ok", at(20))).toMatchObject({ found: true, stop: true, reason: "ended" });
    expect(session(c.callId)).toMatchObject({ connectedAt: null, lastHeartbeatAt: null, endReason: "failed_connect" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  for (const state of ["connected", "ok"] as const) {
    it(`closeNeverConnectedCall refuses a call whose "${state}" heartbeat commits after the check: connected_since_check, nothing written`, async () => {
      addUser("u-1", { planTier: "pro" });
      const c = await mint("u-1", 0);
      const closeAt = at(CONNECT_WINDOW_SECONDS + 600);
      const beatAt = state === "connected" ? at(30) : at(CONNECT_WINDOW_SECONDS + 10); // both long silent by closeAt
      const reservedBefore = allowanceOf("u-1").minutesReserved;
      const versionBefore = allowanceOf("u-1").version;
      // The check passed on a row with no heartbeat; the heartbeat commits just before the close's settlement write.
      fake.interleave("trainerSession", "updateMany", async () => { await heartbeat("u-1", c.callId, state, beatAt); }, (args) => isSettlementWrite(args) && args.where.id === c.callId);
      expect(await closeNeverConnectedCall(c.callId, closeAt)).toEqual({ ok: false, callId: c.callId, error: "connected_since_check" });
      expect(session(c.callId)).toMatchObject({ endedAt: null, endReason: null, billedMinutes: 0, billableSeconds: 0, lastHeartbeatAt: beatAt, connectedAt: state === "connected" ? beatAt : null });
      expect(entries(c.callId)).toHaveLength(0);
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: reservedBefore, version: versionBefore });
      // The call is now a connected one: the ordinary stale path settles and bills it, and the repair keeps refusing it.
      expect(await closeNeverConnectedCall(c.callId, closeAt)).toMatchObject({ ok: false, error: state === "connected" ? "connected" : "heartbeat_seen" });
    });
  }

  it("two settlers on one call release its reservation once: the second finds it ended and writes nothing", async () => {
    addUser("u-1", { planTier: "pro" });
    const keep = await mint("u-1", 0); // a second open call, so a double release would show as a wrong count
    await heartbeat("u-1", keep.callId, "connected", at(CONNECT_WINDOW_SECONDS + 50));
    const c = await mint("u-1", 1);
    const reservedBoth = allowanceOf("u-1").minutesReserved as number;
    const own = session(c.callId).reservedMinutes as number;
    const closeAt = at(CONNECT_WINDOW_SECONDS + 60);
    // closeNeverConnectedCall read the open row; settleStale closes it first, just before its settlement write.
    fake.interleave("trainerSession", "updateMany", async () => { await usageSummary("u-1", closeAt); }, (args) => isSettlementWrite(args) && args.where.id === c.callId);
    expect(await closeNeverConnectedCall(c.callId, closeAt)).toMatchObject({ ok: false, error: "already_ended" });
    expect(session(c.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(allowanceOf("u-1").minutesReserved).toBe(reservedBoth - own);
    expect(session(keep.callId).endedAt).toBeNull();
  });
});

describe("POST /api/transcripts", () => {
  it("a text save is created closed (endedAt set) with no voice metering fields, and settleStale never touches it", async () => {
    addUser("u-1");
    vi.useFakeTimers();
    vi.setSystemTime(at(0));
    const res = await save({ sessionId: "text-1", transcript, durationSeconds: 32, scenario: { id: "quote-follow-up" } });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(session(id).endedAt).toEqual(at(0));
    expect(session(id)).toMatchObject({ allowanceId: null, allowancePeriodStart: null, connectedAt: null, lastHeartbeatAt: null, endReason: null, reservedMinutes: 0, billableSeconds: 0, billedMinutes: 0 });
    vi.useRealTimers();
    await usageSummary("u-1", at(5 * DAY));
    expect(session(id)).toMatchObject({ endReason: null, billedMinutes: 0 });
    expect(fake.rows("usageEntry")).toHaveLength(0);
  });

  it("saving a metered voice call's transcript does not set endedAt: the call is still settled by metering", async () => {
    addUser("u-1");
    const c = await mint("u-1", 0);
    await heartbeat("u-1", c.callId, "connected", at(0));
    const res = await save({ sessionId: "voice-1", callId: c.callId, transcript, durationSeconds: 30, scenario: { id: "quote-follow-up" } });
    expect(res.status).toBe(200);
    expect(fake.rows("trainerSession")).toHaveLength(1);
    expect(session(c.callId).endedAt).toBeNull();
  });
});

describe("SAL-1018 repair helpers", () => {
  /** The bug as it happened: a text session settled as heartbeat_timeout and billed 10 minutes on the user's allowance. */
  async function wronglyBilled(userId: string) {
    const allowance = await ensureAllowance(fake.db as never, { userId }, at(0));
    const text = seedOldTextSession(userId, at(-3 * DAY));
    Object.assign(text, { endedAt: at(0), endReason: "heartbeat_timeout", billableSeconds: 600, billedMinutes: 10 });
    const entry = fake.seed("usageEntry", { userId, allowanceId: allowance.id, trainerSessionId: text.id, kind: "voice_call", minutes: 10, createdAt: at(0) });
    allowanceOf(userId).minutesUsed = 10;
    return { text, entry };
  }

  it("credits a wrongly billed text entry back once, as credit_manual, with an audit note naming the entry and the ticket", async () => {
    addUser("u-1");
    const { text, entry } = await wronglyBilled("u-1");
    expect(await planTextBillingRefund(entry.id)).toMatchObject({ ok: true, userId: "u-1", minutes: 10, trainerSessionId: text.id });
    expect(allowanceOf("u-1").minutesUsed).toBe(10); // planning writes nothing

    const done = await creditTextBillingRefund(entry.id, at(60));
    expect(done).toMatchObject({ ok: true, minutes: 10 });
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
    const credit = fake.rows("usageEntry").find((e) => e.kind === "credit_manual")!;
    expect(credit).toMatchObject({ userId: "u-1", trainerSessionId: text.id, minutes: -10, allowanceId: allowanceOf("u-1").id });
    const audit = fake.rows("auditEvent").find((a) => a.resource === credit.id)!;
    expect(audit).toMatchObject({ action: "usage.credit_manual", metadata: { originalEntryId: entry.id, ticket: TEXT_BILLING_TICKET, minutes: 10 } });
    expect(String((audit.metadata as { reason: string }).reason)).toContain(entry.id);
    expect(String((audit.metadata as { reason: string }).reason)).toContain("SAL-1018");

    // Idempotent: a second run finds the credit and writes nothing.
    expect(await planTextBillingRefund(entry.id)).toMatchObject({ ok: false, error: "already_credited" });
    expect(await creditTextBillingRefund(entry.id, at(120))).toMatchObject({ ok: false, error: "already_credited" });
    expect(allowanceOf("u-1").minutesUsed).toBe(0);
    expect(fake.rows("usageEntry").filter((e) => e.kind === "credit_manual")).toHaveLength(1);
  });

  it("refuses an entry on a metered voice session, an entry that is not voice_call, and an unknown id", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    await heartbeat("u-1", c.callId, "connected", at(0));
    await endCall("u-1", c.callId, "user_hangup", at(120));
    const voice = entries(c.callId).find((e) => e.kind === "voice_call")!;
    expect(await creditTextBillingRefund(voice.id, at(200))).toMatchObject({ ok: false, error: "metered_session" });
    const manual = fake.seed("usageEntry", { userId: "u-1", allowanceId: allowanceOf("u-1").id, kind: "credit_manual", minutes: -1 });
    expect(await planTextBillingRefund(manual.id)).toMatchObject({ ok: false, error: "not_voice_call" });
    expect(await planTextBillingRefund("nope")).toMatchObject({ ok: false, error: "entry_not_found" });
    expect(allowanceOf("u-1").minutesUsed).toBe(2);
  });

  it("closes an open never-connected voice session as failed_connect, 0 billed, reservation released", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await mint("u-1", 0);
    const later = at(CONNECT_WINDOW_SECONDS + 60);
    expect(await planNeverConnectedClose(c.callId, later)).toMatchObject({ ok: true, userId: "u-1", reservedMinutes: 60 });
    expect(session(c.callId).endedAt).toBeNull(); // planning writes nothing
    const done = await closeNeverConnectedCall(c.callId, later);
    expect(done).toMatchObject({ ok: true, settlement: { endReason: "failed_connect", billedMinutes: 0, billableSeconds: 0 } });
    expect(session(c.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
    expect(await closeNeverConnectedCall(c.callId, later)).toMatchObject({ ok: false, error: "already_ended" });
  });

  it("refuses to close a text row, a connected call, a heartbeating call, or one still inside its connect window", async () => {
    addUser("u-1", { planTier: "pro" });
    const later = at(CONNECT_WINDOW_SECONDS + 60);
    const text = seedOldTextSession("u-1", at(-DAY));
    expect(await closeNeverConnectedCall(text.id, later)).toMatchObject({ ok: false, error: "unmetered_session" });

    const connected = await mint("u-1", 0);
    await heartbeat("u-1", connected.callId, "connected", at(0));
    expect(await planNeverConnectedClose(connected.callId, at(20))).toMatchObject({ ok: false, error: "connected" });

    const beating = await mint("u-1", 1);
    session(beating.callId).lastHeartbeatAt = at(5);
    expect(await planNeverConnectedClose(beating.callId, at(20))).toMatchObject({ ok: false, error: "heartbeat_seen" });

    const fresh = await mint("u-1", 2);
    expect(await closeNeverConnectedCall(fresh.callId, at(60))).toMatchObject({ ok: false, error: "still_connecting" });
    expect(session(fresh.callId).endedAt).toBeNull();
    expect(await closeNeverConnectedCall("nope", later)).toMatchObject({ ok: false, error: "session_not_found" });
  });
});
