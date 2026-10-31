import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Same fakes as usage-metering.test.ts: only the database and the session check are replaced.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, chooseEngine, endCall, ensureAllowance, heartbeat, usageSummary } from "@/lib/usage";
import { elevenLabsAgentFor, realtimeModelFor } from "@/lib/serverConfig";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { GET as elevenLabsToken } from "@/app/api/elevenlabs/token/route";

const MAR10 = new Date("2026-03-10T12:00:00Z");
const scn = { id: "quote-follow-up", title: "Quote follow-up" };

let fake: ReturnType<typeof createFakePrisma>;
let base: Date;
let shift = 0;
/** Seconds after this test's start, on a clock each test owns so the per-IP and per-user limits never carry over. */
const at = (sec: number) => new Date(base.getTime() + sec * 1000);

function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const orgAllowance = (orgId = "org-1") => fake.rows("usageAllowance").find((a) => a.organizationId === orgId);
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;

async function begin(userId: string, sec = 0, opts?: { standardAvailable?: boolean }) {
  const r = await beginCall(userId, scn, at(sec), opts);
  if (!r.ok) throw new Error(r.error);
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
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- Premium voice: 60% limit, standard engine for the next session ---------------------------------

describe("Premium voice limit", () => {
  it("chooseEngine: premium needs the add-on and stays premium below 60% of the plan's minutes", () => {
    const a = (used: number, cap = 200, reserved = 0) => ({ minutesCap: cap, premiumMinutesUsed: used, premiumMinutesReserved: reserved });
    expect(chooseEngine({ premiumVoice: true, allowance: a(0) }, 60)).toEqual({ engine: "premium", premiumMinutes: 60 });
    expect(chooseEngine({ premiumVoice: true, allowance: a(119) }, 60)).toEqual({ engine: "premium", premiumMinutes: 1 });
    expect(chooseEngine({ premiumVoice: true, allowance: a(120) }, 60).engine).toBe("standard");
    expect(chooseEngine({ premiumVoice: true, allowance: a(900, 900) }, 60).engine).toBe("standard");
    expect(chooseEngine({ premiumVoice: false, allowance: a(0) }, 60).engine).toBe("standard");
  });

  it("chooseEngine: Premium minutes held by open calls count against the limit", () => {
    const a = (used: number, reserved: number) => ({ minutesCap: 200, premiumMinutesUsed: used, premiumMinutesReserved: reserved });
    expect(chooseEngine({ premiumVoice: true, allowance: a(50, 60) }, 60)).toEqual({ engine: "premium", premiumMinutes: 10 });
    expect(chooseEngine({ premiumVoice: true, allowance: a(60, 60) }, 60).engine).toBe("standard");
  });

  it("the model and agent each engine maps to", () => {
    vi.stubEnv("REALTIME_MODEL", "model-premium-test");
    vi.stubEnv("REALTIME_MODEL_STANDARD", "");
    expect(realtimeModelFor("premium")).toBe("model-premium-test");
    expect(realtimeModelFor("standard")).toBe("gpt-realtime-mini");
    vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
    expect(realtimeModelFor("standard")).toBe("model-standard-test");
    expect(elevenLabsAgentFor("standard", { ELEVENLABS_AGENT_ID: "main" })).toEqual({ agentId: "main", standardAvailable: false });
    expect(elevenLabsAgentFor("standard", { ELEVENLABS_AGENT_ID: "main", ELEVENLABS_AGENT_ID_STANDARD: "std" })).toEqual({ agentId: "std", standardAvailable: true });
    expect(elevenLabsAgentFor("premium", { ELEVENLABS_AGENT_ID: "main", ELEVENLABS_AGENT_ID_STANDARD: "std" }).agentId).toBe("main");
  });

  describe("OpenAI Realtime sessions", () => {
    let bodies: { expires_after: { seconds: number }; session: { model: string } }[];
    beforeEach(() => {
      bodies = [];
      vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
      vi.stubEnv("REALTIME_MODEL", "model-premium-test");
      vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
      }));
    });
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));

    it("a call holding the last Premium minute is stopped when it ends; the NEXT session is minted on the standard model", async () => {
      addUser("u-1", { planTier: "pro", premiumVoice: true });
      await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
      allowanceOf("u-1").premiumMinutesUsed = 119; // 120 of 200 minutes is the Premium limit

      const first = await (await mint()).json();
      expect(bodies[0].session.model).toBe("model-premium-test");
      expect(first.maxSeconds).toBe(60); // the whole call is the one Premium minute it holds
      await heartbeat("u-1", first.callId, "connected", at(0));
      expect(await heartbeat("u-1", first.callId, "ok", at(30))).toMatchObject({ found: true, stop: false });
      expect(await heartbeat("u-1", first.callId, "ok", at(60))).toMatchObject({ found: true, stop: true, reason: "cap_reached" });
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 1, premiumMinutesUsed: 120, premiumMinutesReserved: 0, minutesReserved: 0 });

      vi.setSystemTime(at(310));
      const second = await (await mint()).json();
      expect(bodies[1].session.model).toBe("model-standard-test");
      expect(second.model).toBe("model-standard-test");
      await heartbeat("u-1", second.callId, "connected", at(310));
      await endCall("u-1", second.callId, "user_hangup", at(310 + 180));
      // Standard minutes count against the plan but not against the Premium share.
      expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 4, premiumMinutesUsed: 120 });
      expect(session(first.callId).engineTier).toBe("premium");
      expect(session(second.callId).engineTier).toBe("standard");
    });

    it("a user without the add-on gets the standard model from the first session", async () => {
      addUser("u-1", { planTier: "pro", premiumVoice: false });
      await (await mint()).json();
      expect(bodies[0].session.model).toBe("model-standard-test");
    });

    it("a Team pool with the add-on counts premium minutes across members", async () => {
      fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3, premiumVoice: true });
      addUser("u-1");
      addUser("u-2");
      const first = await begin("u-1");
      expect(first.engine).toBe("premium");
      await heartbeat("u-1", first.callId, "connected", at(0));
      await endCall("u-1", first.callId, "user_hangup", at(60 * 40)); // 40 premium minutes
      expect(orgAllowance()).toMatchObject({ minutesUsed: 40, premiumMinutesUsed: 40 });
      orgAllowance()!.premiumMinutesUsed = 540; // 60% of 900
      expect((await begin("u-2", 3000)).engine).toBe("standard");
    });

    it("without metering (no database) the configured model runs as before", async () => {
      vi.stubEnv("DATABASE_URL", "");
      const body = await (await mint()).json();
      expect(bodies[0].session.model).toBe("model-premium-test");
      expect(body.callId).toBeUndefined();
    });
  });

  describe("ElevenLabs tokens", () => {
    let urls: string[];
    beforeEach(() => {
      urls = [];
      vi.stubEnv("ELEVENLABS_API_KEY", "xi-test-not-real");
      vi.stubEnv("ELEVENLABS_AGENT_ID", "agent-main");
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        urls.push(url);
        return new Response(JSON.stringify({ token: "tok_test" }), { status: 200 });
      }));
    });
    const mint = () => elevenLabsToken(new NextRequest("http://localhost/api/elevenlabs/token?scenarioId=quote-follow-up"));

    it("switches to the standard agent once the Premium share is used, and records the engine", async () => {
      vi.stubEnv("ELEVENLABS_AGENT_ID_STANDARD", "agent-std");
      addUser("u-1", { planTier: "pro", premiumVoice: true });
      const a = await (await mint()).json();
      expect(urls[0]).toContain("agent_id=agent-main");
      expect(session(a.callId).engineTier).toBe("premium");
      await endCall("u-1", a.callId, "failed_connect", at(5));

      allowanceOf("u-1").premiumMinutesUsed = 120;
      const b = await (await mint()).json();
      expect(urls[1]).toContain("agent_id=agent-std");
      expect(session(b.callId).engineTier).toBe("standard");
    });

    it("with no standard agent configured, a Premium-entitled call runs on the main agent as premium", async () => {
      addUser("u-1", { planTier: "pro", premiumVoice: true });
      const a = await (await mint()).json();
      expect(urls[0]).toContain("agent_id=agent-main");
      expect(session(a.callId).engineTier).toBe("premium");
    });

    it("with no standard agent configured, a user without Premium is refused instead of getting the Premium agent", async () => {
      addUser("u-1", { planTier: "pro", premiumVoice: false });
      const res = await mint();
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("standard_voice_not_configured");
      expect(urls).toHaveLength(0);
      expect(fake.rows("trainerSession")).toHaveLength(0);
      expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 0, premiumMinutesReserved: 0 });
    });

    it("with no standard agent configured, an exhausted Premium share is refused too, not overridden", async () => {
      addUser("u-1", { planTier: "pro", premiumVoice: true });
      await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
      allowanceOf("u-1").premiumMinutesUsed = 120;
      expect((await mint()).status).toBe(503);
      expect(urls).toHaveLength(0);
    });
  });
});

// ---- The server's clock, not the browser's -----------------------------------------------------------

describe("heartbeat trust: usage is settled from the server's mint time", () => {
  it("a client that never says 'connected' is billed from the mint time plus 60 seconds, not nothing", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    const result = await endCall("u-1", c.callId, "user_hangup", at(300));
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 4, billableSeconds: 240 });
    expect(allowanceOf("u-1").minutesUsed).toBe(4);
  });

  it("claiming failed_connect after a long call does not make it free", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    const result = await endCall("u-1", c.callId, "failed_connect", at(300));
    expect(result).toMatchObject({ outcome: "billed", billedMinutes: 4 });
  });

  it("a connect heartbeat sent late cannot move the start past the 60 second cutoff", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    await heartbeat("u-1", c.callId, "connected", at(600));
    const result = await endCall("u-1", c.callId, "user_hangup", at(660));
    expect(result?.billableSeconds).toBe(600); // from 60s, not from 600s
  });

  it("a real early failure is still free: failed within 60 seconds of the mint", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    const result = await endCall("u-1", c.callId, "failed_connect", at(20));
    expect(result).toMatchObject({ outcome: "failed_connect", billedMinutes: 0 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });

  it("one heartbeat and then silence is billed until the server noticed, up to the call's reservation", async () => {
    addUser("u-1", { planTier: "pro" });
    const c = await begin("u-1");
    await heartbeat("u-1", c.callId, "connected", at(0));
    // The browser went quiet but may still hold the provider connection. The next read by this user settles it.
    await usageSummary("u-1", at(7200));
    expect(session(c.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 60 });
    expect(allowanceOf("u-1").minutesUsed).toBe(60);
  });

  it("a call with no heartbeat at all is settled after the connect window and billed from the cutoff", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    await usageSummary("u-1", at(16 * 60));
    expect(session(c.callId)).toMatchObject({ endReason: "heartbeat_timeout", billedMinutes: 15 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 15, minutesReserved: 0 });
  });

  it("the maximum length is the minutes left at mint time, capped at 60", async () => {
    addUser("u-1", { planTier: "pro" });
    expect((await begin("u-1")).maxSeconds).toBe(3600);
    addUser("u-2", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-2" }, base);
    allowanceOf("u-2").minutesUsed = 198;
    expect((await begin("u-2")).maxSeconds).toBe(120);
  });

  it("the server stops a call at its maximum length, with or without a connected heartbeat", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
    allowanceOf("u-1").minutesUsed = 198;
    const c = await begin("u-1");
    await heartbeat("u-1", c.callId, "connected", at(0));
    expect(await heartbeat("u-1", c.callId, "ok", at(119))).toMatchObject({ stop: false, secondsLeft: 1 });
    const stopped = await heartbeat("u-1", c.callId, "ok", at(120));
    expect(stopped).toMatchObject({ stop: true, reason: "cap_reached" });
    expect(session(c.callId)).toMatchObject({ billedMinutes: 2, endReason: "cap_reached" });

    // A client that never reports 'connected' is on the same clock, starting 60 seconds after the mint.
    addUser("u-2", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-2" }, base);
    allowanceOf("u-2").minutesUsed = 198;
    const d = await begin("u-2");
    expect(await heartbeat("u-2", d.callId, "ok", at(60 + 119))).toMatchObject({ stop: false });
    expect(await heartbeat("u-2", d.callId, "ok", at(60 + 120))).toMatchObject({ stop: true, reason: "cap_reached" });
  });

  describe("provider session expiry", () => {
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    let bodies: { expires_after: { seconds: number } }[];
    beforeEach(() => {
      bodies = [];
      vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
      }));
    });

    it("passes the call's reserved length to the provider as the secret's lifetime, and returns it to the client", async () => {
      addUser("u-1", { planTier: "pro" });
      await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
      allowanceOf("u-1").minutesUsed = 198;
      const body = await (await mint()).json();
      expect(body.maxSeconds).toBe(120);
      expect(bodies[0].expires_after.seconds).toBe(120);
    });

    it("never asks for longer than the 10 minute default", async () => {
      addUser("u-1");
      const body = await (await mint()).json();
      expect(body.maxSeconds).toBe(1200);
      expect(bodies[0].expires_after.seconds).toBe(600);
    });
  });
});

// ---- Concurrent calls and shared allowances ----------------------------------------------------------

describe("reservations", () => {
  it("a second call cannot take minutes the first call holds, and gets them back when it ends", async () => {
    addUser("u-1");
    const a = await begin("u-1");
    expect(a.maxSeconds).toBe(1200);
    expect(allowanceOf("u-1").minutesReserved).toBe(20);
    expect(await beginCall("u-1", scn, at(1))).toEqual({ ok: false, error: "minutes_reserved" });

    await heartbeat("u-1", a.callId, "connected", at(0));
    await endCall("u-1", a.callId, "user_hangup", at(100)); // 2 minutes
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 0 });
    expect((await begin("u-1", 110)).maxSeconds).toBe(18 * 60);
  });

  it("the realtime route answers 409 minutes_reserved, not cap_reached, while another call holds the minutes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    const sent = vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 }));
    vi.stubGlobal("fetch", sent);
    addUser("u-1");
    const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    expect((await mint()).status).toBe(200);
    const second = await mint();
    expect(second.status).toBe(409);
    expect((await second.json()).error).toBe("minutes_reserved");
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("two calls cannot both spend the last minutes: the second is refused and the first is clamped to its reservation", async () => {
    addUser("u-1", { planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
    allowanceOf("u-1").minutesUsed = 195;
    const a = await begin("u-1");
    expect(a.maxSeconds).toBe(300);
    expect(await beginCall("u-1", scn, at(1))).toEqual({ ok: false, error: "minutes_reserved" });
    await heartbeat("u-1", a.callId, "connected", at(0));
    const result = await endCall("u-1", a.callId, "user_hangup", at(900));
    expect(result).toMatchObject({ billedMinutes: 5, endReason: "cap_reached" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 200, minutesReserved: 0 });
  });

  it("Team members reserve from one pool: reservations plus use never exceed the cap", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3 });
    const ids = Array.from({ length: 16 }, (_, i) => `u-${i + 1}`);
    ids.forEach((id) => addUser(id));
    const calls: { id: string; callId: string }[] = [];
    const refused: string[] = [];
    for (const id of ids) {
      const r = await beginCall(id, scn, at(0));
      if (r.ok) calls.push({ id, callId: r.callId });
      else refused.push(r.error);
      const a = orgAllowance()!;
      expect((a.minutesUsed as number) + (a.minutesReserved as number)).toBeLessThanOrEqual(a.minutesCap as number);
    }
    // 900 pooled minutes, 60 held per call: 15 calls fit, the 16th is refused, and it is not "cap_reached".
    expect(calls).toHaveLength(15);
    expect(refused).toEqual(["minutes_reserved"]);
    expect(orgAllowance()).toMatchObject({ minutesReserved: 900, minutesUsed: 0 });

    for (const c of calls) {
      await heartbeat(c.id, c.callId, "connected", at(0));
      await endCall(c.id, c.callId, "user_hangup", at(60));
    }
    expect(orgAllowance()).toMatchObject({ minutesReserved: 0, minutesUsed: 15 });
  });

  it("a reservation that loses the compare-and-swap reads again and succeeds", async () => {
    addUser("u-1");
    const table = fake.db.usageAllowance as unknown as { updateMany: (args: unknown) => Promise<{ count: number }> };
    const real = table.updateMany.bind(table);
    let losses = 1;
    table.updateMany = vi.fn(async (args: unknown) => (losses-- > 0 ? { count: 0 } : real(args)));
    const r = await beginCall("u-1", scn, at(0));
    expect(r.ok).toBe(true);
    expect(table.updateMany).toHaveBeenCalledTimes(2);
    expect(allowanceOf("u-1").minutesReserved).toBe(20);
  });

  it("a reservation that keeps losing gives up with minutes_reserved and leaves no call row behind", async () => {
    addUser("u-1");
    const table = fake.db.usageAllowance as unknown as { updateMany: (args: unknown) => Promise<{ count: number }> };
    table.updateMany = vi.fn(async () => ({ count: 0 }));
    expect(await beginCall("u-1", scn, at(0))).toEqual({ ok: false, error: "minutes_reserved" });
    expect(fake.rows("trainerSession")).toHaveLength(0);
    expect(allowanceOf("u-1").minutesReserved).toBe(0);
  });
});

// ---- The allowance and period a call was minted against ---------------------------------------------

describe("a call is charged to the allowance and period it started in", () => {
  const utc = (s: string) => new Date(`2026-${s}Z`);

  it("a call that crosses the monthly reset charges only the part after it to the new period", async () => {
    addUser("u-1");
    // Anchor Mar 10 12:00, so the period turns over on Oct 10 at 12:00.
    const c = await beginCall("u-1", scn, utc("10-10T11:59:00"));
    if (!c.ok) throw new Error(c.error);
    await heartbeat("u-1", c.callId, "connected", utc("10-10T11:59:00"));
    const result = await endCall("u-1", c.callId, "user_hangup", utc("10-10T12:03:00"));
    // 4 minutes on the clock: 1 before the reset (ledger only, that period's counters are gone), 3 after.
    expect(result).toMatchObject({ billableSeconds: 240, billedMinutes: 4 });
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 3, minutesReserved: 0 });
    const entries = fake.rows("usageEntry").map((e) => `${e.kind}:${e.minutes}`).sort();
    expect(entries).toEqual(["voice_call:3", "voice_call_prior:1"]);
    expect((fake.rows("usageEntry").find((e) => e.kind === "voice_call_prior")!.createdAt as Date).getTime()).toBeLessThan(utc("10-10T12:00:00").getTime());
    expect((allowanceOf("u-1").periodStart as Date).toISOString()).toBe("2026-10-10T12:00:00.000Z");
  });

  it("an old-period call ending later never releases or overspends the new period's reservations", async () => {
    addUser("u-1");
    const a = await beginCall("u-1", scn, utc("10-10T11:59:00"));
    if (!a.ok) throw new Error(a.error);
    await heartbeat("u-1", a.callId, "connected", utc("10-10T11:59:00"));
    await heartbeat("u-1", a.callId, "ok", utc("10-10T12:00:50"));
    // The rollover reserves what the open call can still use in the new period (19 of its 20 minutes), so
    // the new call can only take the 1 minute that is left.
    const b = await beginCall("u-1", scn, utc("10-10T12:01:00"));
    if (!b.ok) throw new Error(b.error);
    expect(session(a.callId).carriedMinutes).toBe(19);
    expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 20 });
    expect(b.maxSeconds).toBe(60);
    await endCall("u-1", a.callId, "user_hangup", utc("10-10T12:01:30"));
    // 150 s: 1 minute before the reset, 2 after. The old call gives back its carry and the new call keeps its own.
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 1 });
    expect(allowanceOf("u-1").minutesUsed as number + (allowanceOf("u-1").minutesReserved as number)).toBeLessThanOrEqual(allowanceOf("u-1").minutesCap as number);
  });

  it("joining a Team mid-call: the call is still charged to the allowance it started on", async () => {
    addUser("u-1");
    const c = await begin("u-1");
    expect(c.pooled).toBe(false);
    await heartbeat("u-1", c.callId, "connected", at(0));
    const org = fake.rows("organization").find((o) => o.id === "org-1")!;
    org.planTier = "team";
    org.seatCount = 3;
    await endCall("u-1", c.callId, "user_hangup", at(120));
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 0 });
    expect(orgAllowance()?.minutesUsed ?? 0).toBe(0);
  });

  it("leaving a Team mid-call: the call is still charged to the pool it started on", async () => {
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, planTier: "team", seatCount: 3 });
    fake.seed("organization", { id: "org-2", code: "456", createdAt: MAR10 });
    addUser("u-1");
    const c = await begin("u-1");
    expect(c.pooled).toBe(true);
    await heartbeat("u-1", c.callId, "connected", at(0));
    fake.rows("user").find((u) => u.id === "u-1")!.organizationId = "org-2";
    await endCall("u-1", c.callId, "user_hangup", at(120));
    expect(orgAllowance("org-1")).toMatchObject({ minutesUsed: 2, minutesReserved: 0 });
    expect(fake.rows("usageAllowance").find((a) => a.userId === "u-1")?.minutesUsed ?? 0).toBe(0);
  });
});
