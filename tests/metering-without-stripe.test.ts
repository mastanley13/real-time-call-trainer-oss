import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Voice metering and the Free cap with no Stripe key. Same fakes as free-cap.test.ts: the database and the session
// check are replaced; metering, plan resolution, the ledger and the routes run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import Briefing from "@/components/call/Briefing";
import MinutesLeft from "@/components/call/MinutesLeft";
import { CAP_REACHED_MESSAGE, VOICE_UNAVAILABLE_MESSAGE, usageSnapshotFromUsage } from "@/lib/billingUi";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { beginCall, ensureAllowance, heartbeat, endCall, resolveAllowance } from "@/lib/usage";
import { FREE_MINUTES, effectivePlan } from "@/lib/usagePlan";
import { GET as usageRoute } from "@/app/api/usage/route";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as simulate } from "@/app/api/simulate/turn/route";

const T0 = new Date("2026-10-15T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const MAR10 = new Date("2026-03-10T12:00:00Z");
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
const scenario = BUILT_IN_SCENARIOS[0];
const post = (url: string, body: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

let fake: ReturnType<typeof createFakePrisma>;

function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("USAGE_CAPS", "on");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("plan resolution", () => {
  it("no Stripe key: free, whatever a stored row says", () => {
    expect(effectivePlan("pro", false)).toBe("free");
    expect(effectivePlan("team", false)).toBe("free");
  });
  it("a key but no active subscription: free (the tier is free until the webhook sets it)", () => {
    expect(effectivePlan("free", true)).toBe("free");
    expect(effectivePlan(undefined, true)).toBe("free");
    expect(effectivePlan("pro", true)).toBe("pro");
  });
  it("resolveAllowance: a stored pro row is Free with 10 minutes when there is no Stripe key", async () => {
    addUser("u-1", { planTier: "pro" });
    const r = await resolveAllowance(fake.db as never, "u-1", at(0));
    expect(r).toMatchObject({ plan: "free", remaining: FREE_MINUTES });
  });
  it("resolveAllowance: with a Stripe key and an active Pro row it is Pro", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    addUser("u-1", { planTier: "pro" });
    expect(await resolveAllowance(fake.db as never, "u-1", at(0))).toMatchObject({ plan: "pro" });
  });
  it("resolveAllowance: with a Stripe key, a user with no active subscription is Free with 10 minutes", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    addUser("u-1");
    addUser("u-2", { subscriptionStatus: "canceled" });
    for (const id of ["u-1", "u-2"]) {
      expect(await resolveAllowance(fake.db as never, id, at(0))).toMatchObject({ plan: "free", remaining: FREE_MINUTES });
    }
  });
});

describe("USAGE_CAPS off with no Stripe key", () => {
  it("/api/usage is not metered and the voice session mints with no reservation", async () => {
    vi.stubEnv("USAGE_CAPS", "");
    addUser("u-1");
    expect(await (await usageRoute(new NextRequest("http://localhost/api/usage"))).json()).toEqual({ metered: false, billing: { enabled: false } });
    const res = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(res.status).toBe(200);
    expect((await res.json()).callId).toBeUndefined();
  });
});

describe("/api/usage with no Stripe key", () => {
  it("reports metered, plan free, cap 10 and billing off", async () => {
    addUser("u-1");
    const res = await usageRoute(new NextRequest("http://localhost/api/usage"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ metered: true, plan: "free", minutesCap: 10, remaining: 10, billing: { enabled: false } });
  });
  it("demo mode is not metered", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await usageRoute(new NextRequest("http://localhost/api/usage"));
    expect(await res.json()).toEqual({ metered: false, billing: { enabled: false } });
  });
  it("a lookup error is a 503 usage_unavailable, not a guess", async () => {
    addUser("u-1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    (fake.db as Record<string, unknown>).$transaction = async () => { throw new Error("db down"); };
    const res = await usageRoute(new NextRequest("http://localhost/api/usage"));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "usage_unavailable", message: VOICE_UNAVAILABLE_MESSAGE });
  });
});

describe("voice at and under the cap with no Stripe key", () => {
  const mint = () => realtimeSession(post("/api/realtime/session", { scenario }));
  // The routes read the real clock, so freeze Date at T0 (the seeded allowance's month) and advance it with the calls.
  // Only Date is faked: timers and promises keep running.
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(T0); });
  afterEach(() => { vi.useRealTimers(); });
  const usedMinutes = async (used: number) => {
    addUser("u-1");
    await ensureAllowance(fake.db as never, { userId: "u-1" }, at(0));
    fake.rows("usageAllowance").find((a) => a.userId === "u-1")!.minutesUsed = used;
  };

  it("refuses the session at the cap and does not call OpenAI", async () => {
    await usedMinutes(10);
    const res = await mint();
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("cap_reached");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a call started under the cap is allowed to finish past it, and the next start is refused", async () => {
    await usedMinutes(9.5);
    const res = await mint();
    expect(res.status).toBe(200);
    const { callId } = await res.json();
    expect(callId).toBeTruthy();
    expect(Date.now()).toBe(T0.getTime());
    await heartbeat("u-1", callId, "connected", at(0));
    vi.setSystemTime(at(10 * 60));
    const beat = await heartbeat("u-1", callId, "ok", new Date());
    expect(beat).toMatchObject({ found: true, stop: false });
    await endCall("u-1", callId, "user_hangup", new Date());
    vi.setSystemTime(at(11 * 60));
    expect(await beginCall("u-1", scn, at(11 * 60))).toEqual({ ok: false, error: "cap_reached" });
  });
});

describe("a usage lookup error", () => {
  it("refuses the voice session and leaves text practice open", async () => {
    addUser("u-1");
    vi.spyOn(console, "error").mockImplementation(() => {});
    (fake.db as Record<string, unknown>).$transaction = async () => { throw new Error("db down"); };
    const res = await realtimeSession(post("/api/realtime/session", { scenario }));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "usage_unavailable", message: VOICE_UNAVAILABLE_MESSAGE });
    expect(fetch).not.toHaveBeenCalled();

    const turn = await simulate(post("/api/simulate/turn", { scenario, history: [{ role: "user", text: "Hi, thanks for taking my call. Do you have a few minutes?" }] }));
    expect(turn.status).toBe(200);
  });
});

describe("the call setup UI", () => {
  const caps = { demoMode: false, elevenlabs: false, voiceEngines: ["openai"], realtime: true, llm: false, database: true } as never;
  const render = (props: { mode: "voice" | "text"; usage?: ReturnType<typeof usageSnapshotFromUsage>; usageUnavailable?: boolean }) =>
    renderToStaticMarkup(createElement(Briefing, {
      scenario, capabilities: caps, engine: "openai", coachMode: "coached",
      onModeChange: () => {}, onEngineChange: () => {}, onCoachModeChange: () => {}, onStart: () => {}, ...props,
    }));

  it("fail closed: its own message, a way to text practice, and a Start button that points at the reason", () => {
    const out = render({ mode: "voice", usageUnavailable: true });
    expect(out).toContain("Voice is unavailable right now. Text practice still works.");
    expect(out).toContain("Switch to text practice");
    const start = out.match(/<button[^>]*btn-xl[^>]*>/)![0];
    expect(start).toContain("disabled");
    expect(start).toContain('aria-describedby="voice-unavailable"');
    expect(out).toContain('id="voice-unavailable"');
  });

  it("fail closed: the Voice readiness lamp is off, not a green Voice · OpenAI Realtime", () => {
    const out = render({ mode: "voice", usageUnavailable: true });
    expect(out).not.toContain("Voice · OpenAI Realtime");
    expect(out).toMatch(/lamp-off[^>]*><\/span><div[^>]*><p[^>]*>Voice <span[^>]*>\(off\)/);
    expect(render({ mode: "voice" })).toContain("Voice · OpenAI Realtime");
  });

  it("fail closed leaves Text mode open", () => {
    const out = render({ mode: "text", usageUnavailable: true });
    expect(out).not.toContain("Voice is unavailable");
    expect(out.match(/<button[^>]*btn-xl[^>]*>/)![0]).not.toContain("disabled");
  });

  it("out of minutes with billing off: 0 of 10, the reset date and an Upgrade link to /pricing", () => {
    const usage = usageSnapshotFromUsage({ metered: true, remaining: 0, minutesCap: 10, periodEnd: "2026-11-10T12:00:00.000Z", billing: { enabled: false } });
    const out = renderToStaticMarkup(createElement(MinutesLeft, { usage, mode: "voice" }));
    expect(out).toContain("0 of 10 voice minutes left");
    expect(out).toContain("Resets Nov 10.");
    expect(out).toContain('href="/pricing"');
    expect(out).toContain("Upgrade");
  });

  it("out of minutes with billing on: Upgrade goes to billing", () => {
    const usage = usageSnapshotFromUsage({ metered: true, remaining: 0, minutesCap: 10, periodEnd: "2026-11-10T12:00:00.000Z", billing: { enabled: true } });
    expect(renderToStaticMarkup(createElement(MinutesLeft, { usage, mode: "voice" }))).toContain('href="/settings/billing"');
  });

  it("out of minutes in voice mode: Start is disabled, linked to its reason, and Switch to text practice stays", () => {
    const usage = usageSnapshotFromUsage({ metered: true, remaining: 0, minutesCap: 10, periodEnd: "2026-11-10T12:00:00.000Z", billing: { enabled: false } });
    const out = render({ mode: "voice", usage });
    const start = out.match(/<button[^>]*btn-xl[^>]*>/)![0];
    expect(start).toContain("disabled");
    expect(start).toContain('aria-describedby="minutes-out"');
    expect(out).toContain('id="minutes-out"');
    expect(out).toContain("0 of 10 voice minutes left");
    expect(out).toContain("Switch to text practice");
  });

  it("out of minutes after a server refusal, billing off: the panel keeps the count, reset date and /pricing link", () => {
    const usage = usageSnapshotFromUsage({ metered: true, remaining: 0, minutesCap: 10, periodEnd: "2026-11-10T12:00:00.000Z", billing: { enabled: false } });
    const out = renderToStaticMarkup(createElement(Briefing, {
      scenario, capabilities: caps, engine: "openai", coachMode: "coached", mode: "voice", usage, error: CAP_REACHED_MESSAGE,
      onModeChange: () => {}, onEngineChange: () => {}, onCoachModeChange: () => {}, onStart: () => {},
    }));
    expect(out).toContain("0 of 10 voice minutes left");
    expect(out).toContain("Resets Nov 10.");
    expect(out).toContain('href="/pricing"');
    expect(out).not.toContain('href="/settings/billing"');
    expect(out).not.toContain(CAP_REACHED_MESSAGE);
    expect(out.match(/<button[^>]*btn-xl[^>]*>/)![0]).toContain('aria-describedby="minutes-out"');
  });

  it("out of minutes in Text mode: Start stays live", () => {
    const usage = usageSnapshotFromUsage({ metered: true, remaining: 0, minutesCap: 10 });
    expect(render({ mode: "text", usage }).match(/<button[^>]*btn-xl[^>]*>/)![0]).not.toContain("disabled");
  });

  it("a disabled Start for missing voice keys is described by its visible reason", () => {
    const out = renderToStaticMarkup(createElement(Briefing, {
      scenario, capabilities: { demoMode: false, elevenlabs: false, voiceEngines: [], llm: false, database: true } as never, engine: null, coachMode: "coached",
      mode: "voice", onModeChange: () => {}, onEngineChange: () => {}, onCoachModeChange: () => {}, onStart: () => {},
    }));
    expect(out.match(/<button[^>]*btn-xl[^>]*>/)![0]).toContain('aria-describedby="voice-blocked-reason"');
    expect(out).toContain('id="voice-blocked-reason"');
  });

  it("the new copy has no em or en dashes", () => {
    expect(VOICE_UNAVAILABLE_MESSAGE).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });
});
