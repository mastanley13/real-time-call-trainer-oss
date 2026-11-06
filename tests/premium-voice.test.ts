import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Only the database, the session check and Stripe's HTTP calls are replaced. Nothing reaches Stripe or OpenAI.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, endCall, ensureAllowance, heartbeat, premiumMintInfo, resolveAllowance, usageSummary } from "@/lib/usage";
import { PREMIUM_STATUSES, premiumBlock, premiumEntitled, premiumMinutesCapFor, premiumMinutesLeft, premiumSeatsForUnits } from "@/lib/premiumVoice";
import { addonQuantitySync, addonSyncRequest, invoiceSubscriptionId, parseLiveSubscription, periodEndOf, PRICE_ENV, resetPriceCache } from "@/lib/billing";
import { setPremiumEventSink, type PremiumEvent } from "@/lib/billingEvents";
import { PREMIUM_DOM_EVENT, resetPremiumUpsellSeen, trackPremiumUpsell } from "@/lib/premiumEventTypes";
import { stripeApi, StripeApiError } from "@/lib/stripe";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { GET as getTranscript } from "@/app/api/transcripts/[id]/route";
import { GET as getVoice } from "@/app/api/transcripts/[id]/voice/route";

const MAR10 = new Date("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
const WHSEC = "whsec_test_placeholder";
const JWT = "test-only-not-a-secret-0123456789abcdef";

let fake: ReturnType<typeof createFakePrisma>;
let base: Date;
let shift = 0;
const at = (sec: number) => new Date(base.getTime() + sec * 1000);
const future = () => new Date(base.getTime() + 20 * DAY);

/** An entitled Pro add-on: active subscription, quantity 1, period end in the future. Override any field. */
const proPremium = (extra: Record<string, unknown> = {}) => ({
  planTier: "pro", premiumVoice: true, premiumVoiceQuantity: 1, stripeSubscriptionId: "sub_test_pro", stripeCustomerId: "cus_test_pro",
  subscriptionStatus: "active", subscriptionPeriodEnd: future(), ...extra,
});

function addOrg(extra: Record<string, unknown> = {}) {
  return fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10, ...extra });
}
function addUser(id: string, extra: Record<string, unknown> = {}) {
  if (!fake.rows("organization").some((o) => o.id === "org-1")) addOrg();
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const orgAllowance = () => fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;
const user = (id = "u-1") => fake.rows("user").find((u) => u.id === id)!;
const org = () => fake.rows("organization").find((o) => o.id === "org-1")!;

async function begin(userId: string, sec = 0, opts?: Parameters<typeof beginCall>[3]) {
  const r = await beginCall(userId, scn, at(sec), opts);
  if (!r.ok) throw new Error(r.error);
  return r;
}

let events: PremiumEvent[];
beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  base = new Date(new Date("2026-10-15T12:00:00Z").getTime() + ++shift * 2 * 3_600_000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(base);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("JWT_SECRET", JWT);
  // Paid Premium at mint needs the sale flag; the off-sale cases stub it back to "" themselves.
  vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
  events = [];
  setPremiumEventSink((e) => { events.push(e); });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setPremiumEventSink(null);
});

// ---- Pure entitlement ------------------------------------------------------------------------------------

describe("Premium entitlement (pure)", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  const row = (o: Record<string, unknown> = {}) => ({
    premiumVoice: true, premiumVoiceQuantity: 1, subscriptionStatus: "active", stripeSubscriptionId: "sub_test_1",
    subscriptionPeriodEnd: new Date(now.getTime() + DAY), ...o,
  });

  it("only active qualifies: paid Premium is never part of a Stripe trial (Triage B2)", () => {
    expect(PREMIUM_STATUSES).toEqual(["active"]);
    expect(premiumEntitled(row({ subscriptionStatus: "active" }), now)).toBe(true);
    expect(premiumEntitled(row({ subscriptionStatus: "trialing" }), now)).toBe(false);
    for (const s of ["trialing", "past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", null, "weird"]) {
      expect(premiumBlock(row({ subscriptionStatus: s }), now), String(s)).toBe("status");
    }
  });

  it("needs the add-on with quantity above 0, a linked subscription and a period end that has not passed", () => {
    expect(premiumBlock(row({ premiumVoice: false }), now)).toBe("no_addon");
    expect(premiumBlock(row({ premiumVoiceQuantity: 0 }), now)).toBe("no_addon");
    expect(premiumBlock(row({ stripeSubscriptionId: null }), now)).toBe("no_subscription");
    expect(premiumBlock(row({ subscriptionPeriodEnd: null }), now)).toBe("expired");
    expect(premiumBlock(row({ subscriptionPeriodEnd: now }), now)).toBe("expired");
    expect(premiumBlock(row({ subscriptionPeriodEnd: new Date(now.getTime() - 1) }), now)).toBe("expired");
    expect(premiumBlock(row({ premiumSuspendedAt: new Date(now.getTime() - DAY) }), now)).toBe("suspended");
  });

  it("cancel at period end keeps Premium until current_period_end, then not", () => {
    const end = new Date(now.getTime() + 3 * DAY);
    // Stripe keeps a cancel-at-period-end subscription active until then.
    expect(premiumEntitled(row({ subscriptionPeriodEnd: end }), new Date(end.getTime() - 1000))).toBe(true);
    expect(premiumEntitled(row({ subscriptionPeriodEnd: end }), new Date(end.getTime() + 1000))).toBe(false);
  });

  it("minutes: Pro 40, Team 40 x min(add-on quantity, seats), Free 0, nothing when not entitled", () => {
    expect(premiumMinutesCapFor("pro", row(), now, 1, 200)).toBe(40);
    expect(premiumMinutesCapFor("team", row({ premiumVoiceQuantity: 5 }), now, 5, 1500)).toBe(200);
    expect(premiumMinutesCapFor("team", row({ premiumVoiceQuantity: 5 }), now, 3, 900)).toBe(120);
    expect(premiumMinutesCapFor("team", row({ premiumVoiceQuantity: 3 }), now, 6, 1800)).toBe(120);
    expect(premiumMinutesCapFor("free", row(), now)).toBe(0);
    expect(premiumMinutesCapFor("pro", row({ subscriptionStatus: "past_due" }), now)).toBe(0);
  });

  it("left is whole minutes, never negative", () => {
    expect(premiumMinutesLeft({ premiumMinutesCap: 40, premiumMinutesUsed: 10, premiumMinutesReserved: 5 })).toBe(25);
    expect(premiumMinutesLeft({ premiumMinutesCap: 40, premiumMinutesUsed: 50, premiumMinutesReserved: 0 })).toBe(0);
  });

  it("premiumMintInfo: next call Standard when this call holds the last minutes; fallback reasons", () => {
    const r = (cap: number, used: number, flags: { premiumVoice: boolean; premiumConfigured: boolean }) => ({ ...flags, allowance: { premiumMinutesCap: cap, premiumMinutesUsed: used, premiumMinutesReserved: 0 } });
    expect(premiumMintInfo(r(40, 0, { premiumVoice: true, premiumConfigured: true }), "premium", 40, false)).toMatchObject({ source: "paid", leftAfter: 0, nextCallStandard: true });
    expect(premiumMintInfo(r(40, 0, { premiumVoice: true, premiumConfigured: true }), "premium", 20, false)).toMatchObject({ leftAfter: 20, nextCallStandard: false });
    expect(premiumMintInfo(r(40, 40, { premiumVoice: true, premiumConfigured: true }), "standard", 0, false)).toMatchObject({ source: null, fallback: "minutes_used" });
    expect(premiumMintInfo(r(0, 0, { premiumVoice: false, premiumConfigured: true }), "standard", 0, false)).toMatchObject({ fallback: "not_entitled" });
    expect(premiumMintInfo({ ...r(0, 0, { premiumVoice: false, premiumConfigured: true }), premiumSaleOpen: false }, "standard", 0, false)).toMatchObject({ fallback: "not_on_sale" });
    expect(premiumMintInfo(r(0, 0, { premiumVoice: false, premiumConfigured: false }), "standard", 0, false)).toMatchObject({ fallback: null });
    expect(premiumMintInfo(r(0, 0, { premiumVoice: false, premiumConfigured: false }), "premium", 0, true)).toMatchObject({ source: "comped", nextCallStandard: false });
  });

  it("reads the period end from the subscription, or the latest item period end on newer API versions", () => {
    const items = (ends: (number | null)[]) => ({ data: ends.map((e) => ({ current_period_end: e, price: { id: "p" } })) });
    expect(periodEndOf({ current_period_end: 1_900_000_000, items: items([]) })?.getTime()).toBe(1_900_000_000_000);
    expect(periodEndOf({ current_period_end: null, items: items([1_800_000_000, 1_900_000_000]) })?.getTime()).toBe(1_900_000_000_000);
    expect(periodEndOf({ current_period_end: null, items: items([null]) })).toBeNull();
  });

  it("finds an invoice's subscription in either API shape", () => {
    expect(invoiceSubscriptionId({ subscription: "sub_test_a" })).toBe("sub_test_a");
    expect(invoiceSubscriptionId({ parent: { subscription_details: { subscription: "sub_test_b" } } })).toBe("sub_test_b");
    expect(invoiceSubscriptionId({ subscription: { id: "sub_test_c" } })).toBe("sub_test_c");
    expect(invoiceSubscriptionId({})).toBeNull();
  });
});

// ---- Mint check from the database ----------------------------------------------------------------------

describe("mint check: the next call is Standard whenever Premium is not entitled", () => {
  it("active: Premium; each other status, an expired period and a zero quantity: Standard with a fallback reason", async () => {
    const cases: [string, Record<string, unknown>, "premium" | "standard"][] = [
      ["active", {}, "premium"],
      // A Stripe trial keeps the base plan but never paid Premium: the mint is Standard.
      ["trialing", { subscriptionStatus: "trialing" }, "standard"],
      ["past_due inside the base plan's grace", { subscriptionStatus: "past_due", pastDueSince: new Date(base.getTime() - DAY) }, "standard"],
      ["unpaid", { subscriptionStatus: "unpaid" }, "standard"],
      ["canceled", { subscriptionStatus: "canceled" }, "standard"],
      ["incomplete", { subscriptionStatus: "incomplete" }, "standard"],
      ["incomplete_expired", { subscriptionStatus: "incomplete_expired" }, "standard"],
      ["period end passed (webhook not here yet)", { subscriptionPeriodEnd: new Date(base.getTime() - 1000) }, "standard"],
      ["add-on quantity 0", { premiumVoiceQuantity: 0 }, "standard"],
    ];
    for (const [name, extra, want] of cases) {
      fake = createFakePrisma();
      mocks.fake = fake;
      addUser("u-1", proPremium(extra));
      const r = await begin("u-1");
      expect(r.engine, name).toBe(want);
      expect(session(r.callId).engineTier, name).toBe(want);
      // The effective tier is durable from the moment the row exists (ElevenLabs calls get it this way too).
      expect(session(r.callId).voiceTier, name).toBe(want);
      if (want === "standard") {
        expect(r.premium.fallback, name).toBe("not_entitled");
        expect(session(r.callId).premiumReservedMinutes, name).toBe(0);
      }
    }
  });

  it("PREMIUM_VOICE_ON_SALE off: an active, entitled add-on gets no Premium minutes at mint (fallback not_on_sale)", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    addUser("u-1", proPremium());
    const r = await begin("u-1");
    expect(r).toMatchObject({ engine: "standard", maxSeconds: 3600 });
    expect(r.premium).toMatchObject({ source: null, cap: 0, fallback: "not_on_sale" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesCap: 200, premiumMinutesCap: 0 });
    // Comped is independent of the flag: the route mints the Premium model; billing stays on the standard engine.
    const c = await begin("u-1", 5, { compedPremium: true });
    expect(c).toMatchObject({ engine: "standard", maxSeconds: 3600 });
    expect(c.premium).toMatchObject({ source: "comped", fallback: null });
    // Billed on standard, but the durable effective tier says premium.
    expect(session(c.callId)).toMatchObject({ engineTier: "standard", voiceTier: "premium" });
  });

  it("the past_due base plan keeps its grace (still Pro minutes) while Premium is off", async () => {
    addUser("u-1", proPremium({ subscriptionStatus: "past_due", pastDueSince: new Date(base.getTime() - DAY) }));
    const r = await resolveAllowance(fake.db as never, "u-1", base);
    expect(r).toMatchObject({ plan: "pro", premiumVoice: false, premiumConfigured: true });
    expect(r!.allowance).toMatchObject({ minutesCap: 200, premiumMinutesCap: 0 });
  });

  it("a Stripe trial keeps the base plan (Pro minutes, Pro plan) but no paid Premium, and the mint model is Standard", async () => {
    addUser("u-1", proPremium({ subscriptionStatus: "trialing" }));
    const r = await resolveAllowance(fake.db as never, "u-1", base);
    expect(r).toMatchObject({ plan: "pro", premiumVoice: false, premiumConfigured: true });
    expect(r!.allowance).toMatchObject({ minutesCap: 200, premiumMinutesCap: 0 });
    const b = await begin("u-1");
    expect(b).toMatchObject({ engine: "standard" });
    expect(b.premium).toMatchObject({ source: null, fallback: "not_entitled" });
  });

  it("a status change in the database applies to the next call, never the running one", async () => {
    addUser("u-1", proPremium());
    const a = await begin("u-1");
    expect(a.engine).toBe("premium");
    user().subscriptionStatus = "past_due";
    const b = await begin("u-1", 5);
    expect(b.engine).toBe("standard");
    // The running call keeps its engine and its Premium hold.
    expect(session(a.callId)).toMatchObject({ engineTier: "premium", premiumReservedMinutes: 40, endedAt: null });
    await heartbeat("u-1", a.callId, "connected", at(0));
    await endCall("u-1", a.callId, "user_hangup", at(120));
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesUsed: 2 });
  });
});

// ---- Caps, clamp and the one minute rule ------------------------------------------------------------------

describe("cap clamp and the under one minute fallback", () => {
  it("maxSeconds is min(the normal call allowance, the Premium minutes left)", async () => {
    addUser("u-1", proPremium());
    await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
    allowanceOf("u-1").premiumMinutesUsed = 15; // 25 Premium left, 60 minute call allowance
    expect((await begin("u-1")).maxSeconds).toBe(25 * 60);

    addUser("u-2", proPremium({ stripeSubscriptionId: "sub_test_pro_2", stripeCustomerId: "cus_test_pro_2" }));
    await ensureAllowance(fake.db as never, { userId: "u-2" }, base);
    allowanceOf("u-2").minutesUsed = 190; // 10 plan minutes left, 40 Premium left
    const r = await begin("u-2");
    expect(r).toMatchObject({ engine: "premium", maxSeconds: 10 * 60 });
  });

  it("Premium minutes come out of the plan pool: Pro still has 200 in total", async () => {
    addUser("u-1", proPremium());
    const r = await begin("u-1");
    await heartbeat("u-1", r.callId, "connected", at(0));
    await endCall("u-1", r.callId, "user_hangup", at(40 * 60));
    expect(allowanceOf("u-1")).toMatchObject({ minutesCap: 200, minutesUsed: 40, premiumMinutesUsed: 40, premiumMinutesCap: 40 });
    const s = await usageSummary("u-1", at(40 * 60 + 5));
    expect(s).toMatchObject({ minutesCap: 200, remaining: 160, premiumVoice: { enabled: true, minutesCap: 40, minutesUsed: 40, remaining: 0, units: 1 } });
  });

  it("with less than one whole Premium minute left the call starts on Standard, and never switches mid-call", async () => {
    addUser("u-1", proPremium());
    await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
    allowanceOf("u-1").premiumMinutesUsed = 40;
    const r = await begin("u-1");
    expect(r).toMatchObject({ engine: "standard", maxSeconds: 3600 });
    expect(r.premium).toMatchObject({ fallback: "minutes_used", nextCallStandard: false });
  });

  it("the daily mint cap and voice block still apply to Premium calls", async () => {
    addUser("u-1", proPremium({ voiceBlockedUntil: new Date(base.getTime() + 60_000) }));
    expect(await beginCall("u-1", scn, at(0))).toMatchObject({ ok: false, error: "voice_blocked" });
  });

  it("Team pool: 40 x min(add-on quantity, seats), shared by every member", async () => {
    addOrg({ planTier: "team", seatCount: 3, premiumVoice: true, premiumVoiceQuantity: 5, stripeSubscriptionId: "sub_test_team", subscriptionStatus: "active", subscriptionPeriodEnd: future() });
    addUser("u-1");
    addUser("u-2");
    const a = await begin("u-1");
    expect(orgAllowance()).toMatchObject({ minutesCap: 900, premiumMinutesCap: 120 });
    const b = await begin("u-2", 1);
    const c = await begin("u-2", 2);
    expect([a.engine, b.engine, c.engine]).toEqual(["premium", "premium", "standard"]);
    expect(orgAllowance()).toMatchObject({ premiumMinutesReserved: 120 });
  });
});

describe("concurrent mints cannot overspend Premium minutes", () => {
  it("a reservation that loses the compare-and-swap to another Premium mint re-reads and starts on Standard", async () => {
    addUser("u-1", proPremium());
    await ensureAllowance(fake.db as never, { userId: "u-1" }, base);
    const id = allowanceOf("u-1").id;
    // Another mint for the same pool commits its 40 Premium minutes between this mint's read and its write.
    fake.interleave("usageAllowance", "updateMany", async () => {
      await fake.db.usageAllowance.updateMany({ where: { id }, data: { minutesReserved: { increment: 40 }, premiumMinutesReserved: { increment: 40 }, version: { increment: 1 } } });
    }, (args) => "premiumMinutesReserved" in args.data);
    const r = await begin("u-1");
    expect(r.engine).toBe("standard");
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesReserved: 40 });
    expect((allowanceOf("u-1").premiumMinutesReserved as number)).toBeLessThanOrEqual(allowanceOf("u-1").premiumMinutesCap as number);
  });

  it("many members starting at once never hold more than the Premium pool", async () => {
    addOrg({ planTier: "team", seatCount: 3, premiumVoice: true, premiumVoiceQuantity: 3, stripeSubscriptionId: "sub_test_team", subscriptionStatus: "active", subscriptionPeriodEnd: future() });
    const ids = Array.from({ length: 8 }, (_, i) => `u-${i + 1}`);
    ids.forEach((id) => addUser(id));
    let premium = 0;
    for (const id of ids) {
      const r = await beginCall(id, scn, at(0));
      if (r.ok && r.engine === "premium") premium += 1;
      const a = orgAllowance();
      expect((a.premiumMinutesUsed as number) + (a.premiumMinutesReserved as number)).toBeLessThanOrEqual(a.premiumMinutesCap as number);
    }
    expect(premium).toBe(2); // 60 + 60 of 120
  });
});

// ---- Comped override ---------------------------------------------------------------------------------------

describe("comped overrides billing", () => {
  const mint = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
  let models: string[];
  beforeEach(() => {
    models = [];
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubEnv("REALTIME_MODEL", "");
    vi.stubEnv("REALTIME_MODEL_PREMIUM", "model-premium-test");
    vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(init.body as string).session.model);
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
    }));
  });

  it("a comped Premium org mints Premium even when billing says past_due, and uses no paid Premium minutes", async () => {
    // fakePrisma ignores `select`, so the org's voice fields ride on the user row for orgVoiceTierForUser.
    addUser("u-1", { ...proPremium({ subscriptionStatus: "past_due", pastDueSince: new Date(base.getTime() - DAY) }), organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const body = await (await mint()).json();
    expect(models[0]).toBe("model-premium-test");
    expect(body).toMatchObject({ voiceTier: "premium", nextCallStandard: false });
    expect(session(body.callId)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0 });
    // Comped is not a paid fallback.
    expect(events.some((e) => e.name === "premium_fallback_to_standard")).toBe(false);
  });

  it.each(["", "false", "TRUE", "1"])("PREMIUM_VOICE_ON_SALE=%j: a fully entitled paid add-on mints the Standard model", async (flag) => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", flag);
    addUser("u-1", proPremium());
    const body = await (await mint()).json();
    expect(models[0]).toBe("model-standard-test");
    expect(body).toMatchObject({ voiceTier: "standard", nextCallStandard: false });
    expect(session(body.callId)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0 });
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesCap: 0, premiumMinutesReserved: 0 });
    expect(events).toEqual([{ name: "premium_fallback_to_standard", subject: "user", subjectId: "u-1", reason: "not_on_sale" }]);
  });

  it("PREMIUM_VOICE_ON_SALE off: comped Premium is unchanged (Premium model, no paid minutes, normal reservation)", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    addUser("u-1", { planTier: "pro", organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const body = await (await mint()).json();
    expect(models[0]).toBe("model-premium-test");
    expect(body).toMatchObject({ voiceTier: "premium", maxSeconds: 3600 });
    expect(session(body.callId)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0 });
    expect(events.some((e) => e.name === "premium_fallback_to_standard")).toBe(false);
  });

  it("PREMIUM_VOICE_ON_SALE turned on again: the same paid account mints Premium on its next call", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    addUser("u-1", proPremium());
    const off = await (await mint()).json();
    await endCall("u-1", off.callId, "failed_connect", at(5));
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    vi.setSystemTime(at(10));
    const on = await (await mint()).json();
    expect(models).toEqual(["model-standard-test", "model-premium-test"]);
    expect(on.voiceTier).toBe("premium");
  });

  it("a paid fallback emits premium_fallback_to_standard with its reason, never a model id", async () => {
    addUser("u-1", proPremium({ subscriptionStatus: "unpaid" }));
    const body = await (await mint()).json();
    expect(models[0]).toBe("model-standard-test");
    expect(events).toEqual([{ name: "premium_fallback_to_standard", subject: "user", subjectId: "u-1", reason: "not_entitled" }]);
    expect(JSON.stringify(events)).not.toMatch(/model/);
    expect(body.voiceTier).toBe("standard");
  });
});

// ---- Webhook downgrade paths -----------------------------------------------------------------------------

const PREMIUM_META = { ct_plan: "addon", ct_addon: "premium_voice", ct_version: "1" };
const PRO_META = { ct_plan: "pro", ct_addon: "none", ct_version: "1" };
const price = (id: string, meta: Record<string, string>, interval = "month") => ({ id, type: "recurring", unit_amount: 2000, currency: "usd", recurring: { usage_type: "licensed", interval }, product: { metadata: meta } });
const liveSub = (status: string, opts: { premium?: number; periodEnd?: number; cancelAtPeriodEnd?: boolean } = {}) => ({
  id: "sub_test_pro", customer: "cus_test_pro", status, metadata: { userId: "u-1" },
  current_period_end: opts.periodEnd ?? Math.floor(future().getTime() / 1000),
  cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
  items: { data: [
    { id: "si_test_base", quantity: 1, price: price("price_test_pro_m", PRO_META) },
    ...(opts.premium ? [{ id: "si_test_prem", quantity: opts.premium, price: price("price_test_prem_m", PREMIUM_META) }] : []),
  ] },
});

describe("webhook downgrade paths (signed events, Stripe read mocked)", () => {
  let live: unknown;
  let seq = 0;
  beforeEach(() => {
    for (const slot of ["pro", "team", "premium"] as const) for (const i of ["month", "year"] as const) vi.stubEnv(PRICE_ENV[slot][i], `price_test_${slot === "premium" ? "prem" : slot}_${i === "month" ? "m" : "y"}`);
    resetPriceCache();
    live = liveSub("active", { premium: 1 });
    vi.spyOn(stripeApi, "retrieveSubscription").mockImplementation(async () => {
      if (!live) throw new StripeApiError(404);
      return live;
    });
    // Each invoice as Stripe has it now; unknown ids are still owed ("open"). Read before a failure is acted on.
    invoices.clear();
    vi.spyOn(stripeApi, "retrieveInvoice").mockImplementation(async (id: string) => ({ id, status: invoices.get(id) ?? "open" }));
    addUser("u-1", proPremium());
  });
  const invoices = new Map<string, string>();
  const deliver = (type: string, object: Record<string, unknown>) => {
    const raw = JSON.stringify({ id: `evt_test_pv_${++seq}`, type, livemode: false, data: { object } });
    const t = Math.floor(Date.now() / 1000);
    const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
    return webhook(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }));
  };

  it("subscription.updated records the add-on quantity and period end; Premium mints", async () => {
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ planTier: "pro", premiumVoice: true, premiumVoiceQuantity: 1, subscriptionStatus: "active" });
    expect((user().subscriptionPeriodEnd as Date).getTime()).toBe(Math.floor(future().getTime() / 1000) * 1000);
    expect((await begin("u-1")).engine).toBe("premium");
  });

  it.each(["past_due", "unpaid", "incomplete", "canceled"])("subscription.updated to %s: the next mint is Standard", async (status) => {
    live = liveSub(status, { premium: 1 });
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user().subscriptionStatus).toBe(status);
    const r = await begin("u-1");
    expect(r.engine).toBe("standard");
  });

  it("past_due keeps the base plan (grace unchanged) while Premium drops", async () => {
    live = liveSub("past_due", { premium: 1 });
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ planTier: "pro", subscriptionStatus: "past_due" });
    expect(allowanceOf("u-1")).toMatchObject({ minutesCap: 200, premiumMinutesCap: 0 });
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_removed", reason: "status_past_due" }));
  });

  it("subscription.deleted: Free, add-on cleared, next mint Standard", async () => {
    await deliver("customer.subscription.deleted", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ planTier: "free", premiumVoice: false, premiumVoiceQuantity: 0, subscriptionPeriodEnd: null });
    expect((await begin("u-1")).engine).toBe("standard");
  });

  it("invoice.payment_failed persists a suspension: the next call is Standard even before Stripe reports past_due; paying THAT invoice restores it", async () => {
    live = liveSub("active", { premium: 1 }); // Stripe still says active
    await deliver("invoice.payment_failed", { id: "in_test_1", customer: "cus_test_pro", subscription: "sub_test_pro" });
    // The add-on itself is untouched; the suspension is what blocks Premium.
    expect(user()).toMatchObject({ premiumVoice: true, premiumVoiceQuantity: 1, planTier: "pro", premiumSuspendedInvoiceId: "in_test_1" });
    expect(user().premiumSuspendedAt).toBeInstanceOf(Date);
    const first = await begin("u-1");
    expect(first.engine).toBe("standard");
    expect(first.premium.fallback).toBe("not_entitled");
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_removed", reason: "payment_failed" }));
    await endCall("u-1", first.callId, "failed_connect", at(5));
    await deliver("invoice.paid", { id: "in_test_1", status: "paid", customer: "cus_test_pro", parent: { subscription_details: { subscription: "sub_test_pro" } } });
    expect(user()).toMatchObject({ premiumVoice: true, premiumSuspendedAt: null, premiumSuspendedInvoiceId: null });
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_added", reason: "payment_recovered" }));
    expect((await begin("u-1", 10)).engine).toBe("premium");
  });

  it("failed payment, then an unrelated subscription update reporting active: the next mint stays Standard", async () => {
    live = liveSub("active", { premium: 1 });
    await deliver("invoice.payment_failed", { id: "in_test_9", customer: "cus_test_pro", subscription: "sub_test_pro" });
    // Something else changes on the subscription; Stripe reports it active with the add-on on.
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ subscriptionStatus: "active", premiumVoice: true, premiumSuspendedInvoiceId: "in_test_9" });
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesCap: 0 });
    const r = await begin("u-1");
    expect(r.engine).toBe("standard");
    // No premium_added was reported for that update.
    expect(events.filter((e) => e.name === "premium_added")).toEqual([]);
  });

  it("invoice.paid clears the suspension only for the failed invoice, only when paid, and only while Stripe reports good standing", async () => {
    live = liveSub("active", { premium: 1 });
    await deliver("invoice.payment_failed", { id: "in_test_bad", customer: "cus_test_pro", subscription: "sub_test_pro" });
    // Another invoice is paid: the failed one is still open.
    await deliver("invoice.paid", { id: "in_test_other", status: "paid", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user().premiumSuspendedInvoiceId).toBe("in_test_bad");
    // The right invoice, but Stripe still reports past_due.
    live = liveSub("past_due", { premium: 1 });
    await deliver("invoice.paid", { id: "in_test_bad", status: "paid", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user().premiumSuspendedInvoiceId).toBe("in_test_bad");
    // The right invoice, but not actually paid.
    live = liveSub("active", { premium: 1 });
    await deliver("invoice.paid", { id: "in_test_bad", status: "open", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user().premiumSuspendedInvoiceId).toBe("in_test_bad");
    expect((await begin("u-1")).engine).toBe("standard");
    // Verified recovery.
    await deliver("invoice.paid", { id: "in_test_bad", status: "paid", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user()).toMatchObject({ premiumSuspendedAt: null, premiumSuspendedInvoiceId: null });
  });

  it("out of order: invoice.paid, THEN the earlier invoice.payment_failed for it: no suspension, the next mint is Premium", async () => {
    live = liveSub("active", { premium: 1 });
    invoices.set("in_test_late", "paid");
    await deliver("invoice.paid", { id: "in_test_late", status: "paid", customer: "cus_test_pro", subscription: "sub_test_pro" });
    // Stripe delivers the failure from the first attempt afterwards; the event body still says open.
    await deliver("invoice.payment_failed", { id: "in_test_late", status: "open", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(stripeApi.retrieveInvoice).toHaveBeenCalledWith("in_test_late");
    expect(user()).toMatchObject({ premiumSuspendedAt: null, premiumSuspendedInvoiceId: null, premiumVoice: true });
    expect(events.filter((e) => e.name === "premium_removed")).toEqual([]);
    expect((await begin("u-1")).engine).toBe("premium");
  });

  it("a stale failure for a voided invoice, or one Stripe no longer has, suspends nothing", async () => {
    live = liveSub("active", { premium: 1 });
    invoices.set("in_test_void", "void");
    await deliver("invoice.payment_failed", { id: "in_test_void", customer: "cus_test_pro", subscription: "sub_test_pro" });
    vi.mocked(stripeApi.retrieveInvoice).mockRejectedValueOnce(new StripeApiError(404));
    await deliver("invoice.payment_failed", { id: "in_test_missing", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user().premiumSuspendedAt).toBeNull();
  });

  it("an invoice read that fails answers 500 without writing, so Stripe retries the failure later", async () => {
    live = liveSub("active", { premium: 1 });
    vi.mocked(stripeApi.retrieveInvoice).mockRejectedValueOnce(new StripeApiError(503));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await deliver("invoice.payment_failed", { id: "in_test_flaky", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(res.status).toBe(500);
    expect(user().premiumSuspendedAt).toBeNull();
    expect(fake.rows("stripeEvent")).toHaveLength(0);
  });

  it("a genuinely owed failure still suspends, and only paying it (not an unrelated active update) recovers", async () => {
    live = liveSub("active", { premium: 1 });
    await deliver("invoice.payment_failed", { id: "in_test_owed", customer: "cus_test_pro", subscription: "sub_test_pro" });
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect((await begin("u-1")).engine).toBe("standard");
    invoices.set("in_test_owed", "paid");
    await deliver("invoice.paid", { id: "in_test_owed", status: "paid", customer: "cus_test_pro", subscription: "sub_test_pro" });
    // A late duplicate of the failure for the now-paid invoice does not re-suspend.
    await deliver("invoice.payment_failed", { id: "in_test_owed", status: "open", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user().premiumSuspendedAt).toBeNull();
    expect((await begin("u-1", 10)).engine).toBe("premium");
  });

  it("a suspension ends with its subscription: a new subscription after cancellation is not blocked by it", async () => {
    live = liveSub("active", { premium: 1 });
    await deliver("invoice.payment_failed", { id: "in_test_old", customer: "cus_test_pro", subscription: "sub_test_pro" });
    await deliver("customer.subscription.deleted", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ planTier: "free", premiumSuspendedAt: null, premiumSuspendedInvoiceId: null });
  });

  it("cancel at period end keeps Premium until the period end, then the next mint is Standard", async () => {
    const end = new Date(base.getTime() + 2 * DAY);
    live = liveSub("active", { premium: 1, cancelAtPeriodEnd: true, periodEnd: Math.floor(end.getTime() / 1000) });
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    const before = await begin("u-1");
    expect(before.engine).toBe("premium");
    // End that call normally. Left open, the stale-call sweep two days later would settle it as an overrun and block voice.
    await heartbeat("u-1", before.callId, "connected", at(0));
    await endCall("u-1", before.callId, "user_hangup", at(120));
    expect(user().voiceBlockedUntil ?? null).toBeNull();
    vi.setSystemTime(new Date(end.getTime() + 60_000));
    const r = await beginCall("u-1", scn, new Date(end.getTime() + 60_000));
    if (!r.ok) throw new Error(r.error);
    expect(r.engine).toBe("standard");
  });

  it("a removal at renewal: once the add-on leaves the subscription, Premium and the scheduled date clear", async () => {
    user().premiumVoiceRemoveAt = future();
    live = liveSub("active", {});
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ premiumVoice: false, premiumVoiceQuantity: 0, premiumVoiceRemoveAt: null, planTier: "pro" });
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_removed", reason: "ended" }));
  });

  it("Stripe never clears comped: a Team downgrade leaves voiceModelComped and voiceModelTier alone, and comped still mints Premium", async () => {
    Object.assign(org(), {
      planTier: "team", seatCount: 3, premiumVoice: true, premiumVoiceQuantity: 3, stripeSubscriptionId: "sub_test_team", stripeCustomerId: "cus_test_team",
      subscriptionStatus: "active", subscriptionPeriodEnd: future(), voiceModelComped: true, voiceModelTier: "premium",
    });
    await deliver("customer.subscription.deleted", { id: "sub_test_team", customer: "cus_test_team" });
    expect(org()).toMatchObject({ planTier: "free", premiumVoice: false, voiceModelComped: true, voiceModelTier: "premium" });
    // The mint route reads comped from the database (the route passes compedPremium); paid Premium is gone.
    const r = await begin("u-1", 0, { compedPremium: true });
    expect(r).toMatchObject({ engine: "standard" });
    expect(r.premium.source).toBe("comped");
  });

  describe("portal seat changes: the add-on quantity is brought back in step with the seats", () => {
    const TEAM_META = { ct_plan: "team", ct_addon: "none", ct_seat_min: "3", ct_version: "1" };
    const teamLive = (seats: number, premium: number, extra: Record<string, unknown> = {}) => ({
      id: "sub_test_team", customer: "cus_test_team", status: "active", metadata: { organizationId: "org-1" },
      current_period_end: Math.floor(future().getTime() / 1000), cancel_at_period_end: false, schedule: null,
      items: { data: [
        { id: "si_test_team", quantity: seats, price: price("price_test_team_m", TEAM_META) },
        { id: "si_test_prem", quantity: premium, price: price("price_test_prem_m", PREMIUM_META) },
      ] },
      ...extra,
    });
    let update: MockInstance<typeof stripeApi.updateSubscription>;
    let create: MockInstance<typeof stripeApi.createSubscriptionSchedule>;
    let updateSched: MockInstance<typeof stripeApi.updateSubscriptionSchedule>;
    /** A stand-in for the one Stripe schedule this subscription can have. No network. */
    let sched: { id: string; status: string; end_behavior: string; phases: { start_date: number; end_date: number; items: { price: string; quantity: number }[] }[] } | null;
    const periodStart = () => Math.floor(base.getTime() / 1000) - 10 * 86400;
    beforeEach(() => {
      Object.assign(org(), {
        planTier: "team", seatCount: 4, premiumVoice: true, premiumVoiceQuantity: 4, stripeSubscriptionId: "sub_test_team",
        stripeCustomerId: "cus_test_team", subscriptionStatus: "active", subscriptionPeriodEnd: future(),
      });
      update = vi.spyOn(stripeApi, "updateSubscription").mockResolvedValue({});
      sched = null;
      // The allowlisted prices (resolvePriceIds reads each one, with its product metadata).
      vi.spyOn(stripeApi, "retrievePrice").mockImplementation(async (id: string) => {
        const [, , kind, iv] = id.split("_");
        const meta = kind === "pro" ? PRO_META : kind === "team" ? TEAM_META : PREMIUM_META;
        return { ...price(id, meta, iv === "y" ? "year" : "month"), active: true, livemode: false };
      });
      create = vi.spyOn(stripeApi, "createSubscriptionSchedule").mockImplementation(async () => {
        const l = live as ReturnType<typeof teamLive>;
        sched = { id: "sub_sched_test_portal", status: "active", end_behavior: "release", phases: [{ start_date: periodStart(), end_date: l.current_period_end, items: l.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity })) }] };
        live = { ...l, schedule: sched.id };
        return structuredClone(sched);
      });
      vi.spyOn(stripeApi, "retrieveSubscriptionSchedule").mockImplementation(async () => {
        if (!sched) throw new StripeApiError(404);
        return structuredClone(sched);
      });
      updateSched = vi.spyOn(stripeApi, "updateSubscriptionSchedule").mockImplementation(async (_id, params) => {
        const p = params as unknown as { end_behavior: string; phases: { items: { price: string; quantity: number }[]; start_date?: number; end_date?: number }[] };
        if (!sched) throw new StripeApiError(400);
        const end = sched.phases[0].end_date;
        sched = { ...sched, end_behavior: p.end_behavior, phases: [
          { start_date: p.phases[0].start_date ?? periodStart(), end_date: end, items: p.phases[0].items },
          { start_date: end, end_date: end + 30 * 86400, items: p.phases[1].items },
        ] };
        return structuredClone(sched);
      });
      vi.spyOn(stripeApi, "releaseSubscriptionSchedule").mockImplementation(async () => {
        sched = null;
        live = { ...(live as ReturnType<typeof teamLive>), schedule: null };
        return {};
      });
    });
    const seatChange = () => deliver("customer.subscription.updated", { id: "sub_test_team", customer: "cus_test_team" });

    it("pure: quantity = seats (Pro 1); nothing when in step, scheduled, ending, or not in good standing", () => {
      const parse = (o: unknown) => parseLiveSubscription(o);
      expect(addonQuantitySync(parse(teamLive(6, 4)))).toEqual({ subscriptionId: "sub_test_team", itemId: "si_test_prem", from: 4, quantity: 6, direction: "up" });
      expect(addonQuantitySync(parse(teamLive(3, 4)))).toEqual({ subscriptionId: "sub_test_team", itemId: "si_test_prem", from: 4, quantity: 3, direction: "down" });
      expect(addonQuantitySync(parse(teamLive(4, 4)))).toBeNull();
      expect(addonQuantitySync(parse(teamLive(6, 4, { schedule: "sub_sched_test_1" })))).toBeNull();
      // A decrease is never skipped because a schedule is attached: it goes to the renewal step (resume or read-only check).
      expect(addonQuantitySync(parse(teamLive(3, 4, { schedule: "sub_sched_test_1" })))).toMatchObject({ quantity: 3, direction: "down" });
      expect(addonQuantitySync(parse(teamLive(6, 4, { cancel_at_period_end: true })))).toBeNull();
      expect(addonQuantitySync(parse(teamLive(6, 4, { status: "past_due" })))).toBeNull();
      // Paid Premium is active-only, so a trialing subscription gets no add-on sync either (Triage B2).
      expect(addonQuantitySync(parse(teamLive(6, 4, { status: "trialing" })))).toBeNull();
      expect(addonQuantitySync(parse(liveSub("active", { premium: 2 })))).toMatchObject({ quantity: 1, direction: "down" });
      const up = { subscriptionId: "sub_test_team", itemId: "si_test_prem", from: 4, quantity: 6, direction: "up" as const };
      expect(addonSyncRequest(up, "evt_a")).toEqual({
        id: "sub_test_team", params: { items: [{ id: "si_test_prem", quantity: 6 }], proration_behavior: "create_prorations" }, idempotencyKey: "addon-sync:sub_test_team:si_test_prem:4-6:evt_a",
      });
      // Same transition, same trigger: same key (a retry). Another trigger or another transition: another key.
      expect(addonSyncRequest(up, "evt_a").idempotencyKey).toBe(addonSyncRequest(up, "evt_a").idempotencyKey);
      expect(addonSyncRequest(up, "evt_b").idempotencyKey).not.toBe(addonSyncRequest(up, "evt_a").idempotencyKey);
      expect(addonSyncRequest({ ...up, from: 3 }, "evt_a").idempotencyKey).not.toBe(addonSyncRequest(up, "evt_a").idempotencyKey);
    });

    it("3 -> 4 -> 3 -> 4 in the portal: increases are distinct Stripe requests; the decrease waits for renewal", async () => {
      const keys = () => update.mock.calls.map((c) => c[2]);
      const quantities = () => update.mock.calls.map((c) => (c[1] as { items: { quantity: number }[] }).items[0].quantity);
      Object.assign(org(), { seatCount: 3, premiumVoiceQuantity: 3 });
      live = teamLive(4, 3); await seatChange(); // up to 4, now
      live = teamLive(4, 4); await seatChange(); // landed, in step: nothing written
      live = teamLive(3, 4); await seatChange(); // down to 3: scheduled for renewal, not written now
      expect(create).toHaveBeenCalledTimes(1);
      // Renewal: the schedule's next phase lands (seats and add-on at 3) in a new period.
      const nextEnd = Math.floor(future().getTime() / 1000) + 30 * 86400;
      live = teamLive(3, 3, { current_period_end: nextEnd }); await seatChange();
      live = teamLive(4, 3, { current_period_end: nextEnd }); await seatChange(); // up to 4 again
      expect(quantities()).toEqual([4, 4]);
      expect(new Set(keys()).size).toBe(2);
      // The two 3 -> 4 transitions come from different events, so their keys differ.
      expect(keys()[0]).toMatch(/^addon-sync:sub_test_team:si_test_prem:3-4:evt_test_pv_\d+$/);
      expect(keys()[1]).toMatch(/^addon-sync:sub_test_team:si_test_prem:3-4:evt_test_pv_\d+$/);
      expect(keys()[0]).not.toBe(keys()[1]);
    });

    it("more seats in the portal: the pool stays at what is paid until the add-on follows, then grows", async () => {
      live = teamLive(6, 4);
      await seatChange();
      // Never more Premium than paid for: min(add-on 4, seats 6) = 4 units.
      expect(org()).toMatchObject({ seatCount: 6, premiumVoiceQuantity: 4 });
      expect(orgAllowance()).toMatchObject({ minutesCap: 1800, premiumMinutesCap: 160 });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]).toEqual(["sub_test_team", { items: [{ id: "si_test_prem", quantity: 6 }], proration_behavior: "create_prorations" }, expect.stringMatching(/^addon-sync:sub_test_team:si_test_prem:4-6:evt_test_pv_\d+$/)]);
      // Stripe reports the synced add-on: the pool grows to 6 units and nothing more is written.
      live = teamLive(6, 6);
      await seatChange();
      expect(orgAllowance()).toMatchObject({ premiumMinutesCap: 240 });
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("fewer seats in the portal: the paid Premium pool is kept until renewal and the add-on drop is scheduled for it", async () => {
      live = teamLive(3, 4);
      await seatChange();
      // Nothing is written to the subscription now; the add-on drop is the next phase of the app's own schedule.
      expect(update).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
      expect(create.mock.calls[0][0]).toEqual({ from_subscription: "sub_test_team" });
      expect(updateSched).toHaveBeenCalledTimes(1);
      const phases = (updateSched.mock.calls[0][1] as unknown as { phases: { items: unknown[] }[] }).phases;
      expect(phases[0].items).toEqual([{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 4 }]);
      expect(phases[1].items).toEqual([{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 3 }]);
      // This period: base minutes follow the seats Stripe now bills, Premium keeps the 4 units already paid for.
      expect(org()).toMatchObject({ seatCount: 3, premiumVoiceQuantity: 4, seatCountAtRenewal: 3 });
      expect(orgAllowance()).toMatchObject({ minutesCap: 900, premiumMinutesCap: 160 });
    });

    it("just before renewal the pool is unchanged; after renewal the target applies; repeats never postpone or inflate", async () => {
      live = teamLive(3, 4);
      await seatChange();
      // Repeated deliveries in the same period (the schedule is attached now): nothing new, nothing more.
      await seatChange();
      await seatChange();
      expect(create).toHaveBeenCalledTimes(1);
      expect(updateSched).toHaveBeenCalledTimes(1);
      expect(org().seatCountAtRenewal).toBe(3);
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      // One minute before the period ends, a member still starts Premium from the full paid pool.
      const justBefore = new Date(future().getTime() - 60_000);
      vi.setSystemTime(justBefore);
      const r = await beginCall("u-1", scn, justBefore);
      if (!r.ok) throw new Error(r.error);
      expect(r.engine).toBe("premium");
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      await endCall("u-1", r.callId, "failed_connect", new Date(justBefore.getTime() + 1000));
      // Renewal: Stripe reports the next period with the schedule's phase applied.
      const nextEnd = Math.floor(future().getTime() / 1000) + 30 * 86400;
      vi.setSystemTime(new Date(future().getTime() + 60_000));
      live = teamLive(3, 3, { current_period_end: nextEnd });
      await seatChange();
      expect(org()).toMatchObject({ seatCount: 3, premiumVoiceQuantity: 3, seatCountAtRenewal: null });
      expect(orgAllowance().premiumMinutesCap).toBe(120);
      // A late or repeated delivery after the renewal reads Stripe's current state: still 3 units, no new mark.
      await seatChange();
      expect(org().seatCountAtRenewal).toBeNull();
      expect(orgAllowance().premiumMinutesCap).toBe(120);
      expect(update).not.toHaveBeenCalled();
      expect(create).toHaveBeenCalledTimes(1);
    });

    it("pure: a pending decrease keeps the add-on quantity paid this period, never more; none pending is min(add-on, seats)", () => {
      expect(premiumSeatsForUnits(3, 3, 4)).toBe(4);
      expect(premiumSeatsForUnits(3, null, 4)).toBe(3);
      // An in-app decrease (base seats still 6 until renewal) is unchanged by the rule.
      expect(premiumSeatsForUnits(6, 4, 6)).toBe(6);
    });

    const needsSupport = () => fake.rows("auditEvent").filter((e) => e.action === "billing.addon_decrease_needs_support");

    it("terms a schedule would drop: NOTHING is lowered now; the paid pool and pending target are kept; the webhook fails for support", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      live = teamLive(3, 4, { discounts: ["di_test_1"] });
      const res = await seatChange();
      expect(res.status).toBe(500);
      // No immediate decrease, no schedule written over the discount.
      expect(update).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
      expect(updateSched).not.toHaveBeenCalled();
      // The already-paid quantity and pool stay; the pending target is recorded.
      expect(org()).toMatchObject({ seatCount: 3, premiumVoiceQuantity: 4, seatCountAtRenewal: 3 });
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      // Explicit, actionable record for an operator; the event is not acknowledged, so Stripe retries it.
      expect(needsSupport()).toHaveLength(1);
      expect(needsSupport()[0].metadata).toMatchObject({ reason: "unsupported_terms", pendingSeats: 3, addonQuantity: 4 });
      expect(String((needsSupport()[0].metadata as { action: string }).action)).toMatch(/Stripe Dashboard/);
      expect(fake.rows("stripeEvent")).toHaveLength(0);
      // A retry (or any later event) changes nothing either: still no shrink, still failing visibly.
      expect((await seatChange()).status).toBe(500);
      expect(update).not.toHaveBeenCalled();
      expect(orgAllowance().premiumMinutesCap).toBe(160);
    });

    it("unsupported terms still unresolved after a renewal: Stripe bills the old quantity, so the Team keeps exactly those units", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      live = teamLive(3, 4, { discounts: ["di_test_1"] });
      await seatChange();
      const nextEnd = Math.floor(future().getTime() / 1000) + 30 * 86400;
      vi.setSystemTime(new Date(future().getTime() + 60_000));
      live = teamLive(3, 4, { discounts: ["di_test_1"], current_period_end: nextEnd });
      expect((await seatChange()).status).toBe(500);
      // Never more than the billed add-on quantity, never less while it is billed; the target stays pending.
      expect(org()).toMatchObject({ premiumVoiceQuantity: 4, seatCountAtRenewal: 3 });
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      expect(update).not.toHaveBeenCalled();
      // Once support lowers it (here: Stripe reports 3), the mark clears and the pool follows.
      live = teamLive(3, 3, { discounts: ["di_test_1"], current_period_end: nextEnd });
      expect((await seatChange()).status).toBe(200);
      expect(org().seatCountAtRenewal).toBeNull();
      expect(orgAllowance().premiumMinutesCap).toBe(120);
    });

    it("Codex P1: the schedule is created (attached), a later step fails, and the replay of the event completes it on the original renewal date", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      live = teamLive(3, 4);
      const originalEnd = Math.floor(future().getTime() / 1000);
      // The create lands and attaches the schedule; the read that follows fails, and so does the release of it.
      vi.mocked(stripeApi.retrieveSubscriptionSchedule).mockRejectedValueOnce(new StripeApiError(500));
      vi.mocked(stripeApi.releaseSubscriptionSchedule).mockRejectedValueOnce(new StripeApiError(500));
      const raw = JSON.stringify({ id: "evt_test_portal_partial", type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_test_team", customer: "cus_test_team" } } });
      const send = () => {
        const t = Math.floor(Date.now() / 1000);
        const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
        return webhook(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }));
      };
      expect((await send()).status).toBe(500);
      expect((live as { schedule: string | null }).schedule).toBe("sub_sched_test_portal");
      expect(updateSched).not.toHaveBeenCalled();
      expect(fake.rows("stripeEvent").some((r) => r.id === "evt_test_portal_partial")).toBe(false);
      // Meanwhile the paid pool is kept.
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      // Stripe's retry: the attached schedule is the app's own unfinished setup, resumed through the lease and baseline.
      expect((await send()).status).toBe(200);
      expect(create).toHaveBeenCalledTimes(1);
      expect(updateSched).toHaveBeenCalledTimes(1);
      const phases = (updateSched.mock.calls[0][1] as unknown as { phases: { end_date?: number; items: unknown[] }[] }).phases;
      expect(phases[0].end_date).toBe(originalEnd);
      expect(phases[1].items).toEqual([{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 3 }]);
      expect(sched?.phases[1].start_date).toBe(originalEnd);
      expect(update).not.toHaveBeenCalled();
      expect(org().premiumScheduleRef).toBeNull();
      expect(needsSupport()).toHaveLength(0);
    });

    it("someone else's schedule: untouched, nothing lowered, pool kept, and an explicit failure for support", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const end = Math.floor(future().getTime() / 1000);
      // A schedule made in the Dashboard whose renewal phase keeps the add-on at 4.
      sched = { id: "sub_sched_test_foreign", status: "active", end_behavior: "release", phases: [
        { start_date: periodStart(), end_date: end, items: [{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 4 }] },
        { start_date: end, end_date: end + 30 * 86400, items: [{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 4 }] },
      ] };
      const before = structuredClone(sched);
      live = teamLive(3, 4, { schedule: "sub_sched_test_foreign" });
      expect((await seatChange()).status).toBe(500);
      expect(create).not.toHaveBeenCalled();
      expect(updateSched).not.toHaveBeenCalled();
      expect(stripeApi.releaseSubscriptionSchedule).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(sched).toEqual(before);
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      expect(needsSupport()[0].metadata).toMatchObject({ reason: "schedule_conflict", pendingSeats: 3 });
    });

    it("someone else's schedule that already lowers the add-on at the renewal date: arranged, read only, acknowledged", async () => {
      const end = Math.floor(future().getTime() / 1000);
      sched = { id: "sub_sched_test_ops", status: "active", end_behavior: "release", phases: [
        { start_date: periodStart(), end_date: end, items: [{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 4 }] },
        { start_date: end, end_date: end + 30 * 86400, items: [{ price: "price_test_team_m", quantity: 3 }, { price: "price_test_prem_m", quantity: 3 }] },
      ] };
      const before = structuredClone(sched);
      live = teamLive(3, 4, { schedule: "sub_sched_test_ops" });
      expect((await seatChange()).status).toBe(200);
      expect(create).not.toHaveBeenCalled();
      expect(updateSched).not.toHaveBeenCalled();
      expect(sched).toEqual(before);
      expect(orgAllowance().premiumMinutesCap).toBe(160);
      expect(needsSupport()).toHaveLength(0);
    });

    it("a schedule setup that fails answers 500 and drops the event id; Stripe's retry finishes it, still at renewal", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      live = teamLive(3, 4);
      create.mockRejectedValueOnce(new StripeApiError(500));
      const raw = JSON.stringify({ id: "evt_test_portal_retry", type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_test_team", customer: "cus_test_team" } } });
      const send = () => {
        const t = Math.floor(Date.now() / 1000);
        const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
        return webhook(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }));
      };
      expect((await send()).status).toBe(500);
      expect(fake.rows("stripeEvent").some((r) => r.id === "evt_test_portal_retry")).toBe(false);
      expect((await send()).status).toBe(200);
      expect(create).toHaveBeenCalledTimes(2);
      expect(updateSched).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
      expect(orgAllowance().premiumMinutesCap).toBe(160);
    });

    it("writes nothing while Premium is off sale, or while a schedule owns the next quantities", async () => {
      vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
      live = teamLive(6, 4);
      await seatChange();
      vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
      live = teamLive(6, 4, { schedule: "sub_sched_test_1" });
      await seatChange();
      expect(update).not.toHaveBeenCalled();
    });

    it("a failed sync answers 500 and drops the event id, so Stripe's retry syncs again", async () => {
      live = teamLive(6, 4);
      update.mockRejectedValueOnce(new StripeApiError(500));
      vi.spyOn(console, "error").mockImplementation(() => {});
      const raw = JSON.stringify({ id: "evt_test_sync_retry", type: "customer.subscription.updated", livemode: false, data: { object: { id: "sub_test_team", customer: "cus_test_team" } } });
      const send = () => {
        const t = Math.floor(Date.now() / 1000);
        const sig = `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${raw}`).digest("hex")}`;
        return webhook(new NextRequest("http://localhost/api/stripe/webhook", { method: "POST", body: raw, headers: { "stripe-signature": sig } }));
      };
      expect((await send()).status).toBe(500);
      expect(fake.rows("stripeEvent").some((r) => r.id === "evt_test_sync_retry")).toBe(false);
      expect((await send()).status).toBe(200);
      expect(update).toHaveBeenCalledTimes(2);
      // The retry of the same event repeats the exact key, so Stripe applies the change once.
      expect(update.mock.calls[1][2]).toBe("addon-sync:sub_test_team:si_test_prem:4-6:evt_test_sync_retry");
      expect(update.mock.calls[0][2]).toBe(update.mock.calls[1][2]);
    });
  });

  it("a Premium add-on on a different interval from the base plan grants no Premium", async () => {
    live = { ...liveSub("active"), items: { data: [
      { id: "si_test_base", quantity: 1, price: price("price_test_pro_m", PRO_META) },
      { id: "si_test_prem", quantity: 1, price: price("price_test_prem_y", PREMIUM_META, "year") },
    ] } };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect(user()).toMatchObject({ planTier: "pro", premiumVoice: false });
  });
});

// ---- Session logging: model and effective tier, with receipt integrity -----------------------------------

describe("session log: model provenance from the mr3 receipt, tier label from its own route", () => {
  let models: string[];
  beforeEach(() => {
    models = [];
    vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
    vi.stubEnv("REALTIME_MODEL", "");
    vi.stubEnv("REALTIME_MODEL_PREMIUM", "model-premium-test");
    vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(init.body as string).session.model);
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
    }));
  });
  const mint = async () => (await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }))).json();
  const save = (minted: { sessionId: string; callId?: string; receipt?: string }) => saveTranscript(new NextRequest("http://localhost/api/transcripts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: minted.sessionId, callId: minted.callId, transcript: [{ role: "user", text: "Hi" }], scenario: { id: scn.id }, realtimeReceipt: minted.receipt }),
  }));
  const voiceOf = async (id: string) => {
    const res = await getVoice(new NextRequest(`http://localhost/api/transcripts/${id}/voice`), { params: Promise.resolve({ id }) });
    return { status: res.status, text: await res.text() };
  };

  it("a paid Premium call: the mint logs the model and tier on the call's own row; the save's receipt is its one use", async () => {
    addUser("u-1", proPremium());
    const minted = await mint();
    expect(models).toEqual(["model-premium-test"]);
    expect(minted.sessionId).toBe(minted.callId);
    // Logged by the server at mint, before (and without) any save.
    expect(session(minted.callId)).toMatchObject({ engineTier: "premium", voiceTier: "premium", realtimeModel: "model-premium-test" });
    expect((await save(minted)).status).toBe(200);
    expect(session(minted.callId)).toMatchObject({ engineTier: "premium", realtimeModel: "model-premium-test" });
    const audits = () => fake.rows("auditEvent").filter((e) => e.action === "session.saved").map((e) => (e.metadata as { receiptRejected?: boolean }).receiptRejected ?? false);
    expect(audits()).toEqual([false]);
    // A replay is still refused: single use is kept.
    await save(minted);
    expect(audits()).toEqual([false, true]);
    const v = await voiceOf(minted.callId);
    expect(v).toEqual({ status: 200, text: JSON.stringify({ voiceUsed: "premium" }) });
    // The session view itself stays the exact allowlist: no tier, no model.
    const detail = await (await getTranscript(new NextRequest(`http://localhost/api/transcripts/${minted.callId}`), { params: Promise.resolve({ id: minted.callId }) })).text();
    expect(detail).not.toMatch(/model-premium-test|realtimeModel|engineTier|voiceUsed|"premium"/);
  });

  it("a comped call stays on the standard billing engine; its durable voiceTier says Premium, saved or not", async () => {
    addUser("u-1", { planTier: "pro", organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const minted = await mint();
    expect(models).toEqual(["model-premium-test"]);
    // Abandoned: never saved. The row already has the model and the effective tier.
    expect(session(minted.callId)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0, voiceTier: "premium", realtimeModel: "model-premium-test" });
    expect(JSON.parse((await voiceOf(minted.callId)).text).voiceUsed).toBe("premium");
  });

  it("the label reads the stored tier, not the environment: changing the Premium model later does not relabel a call", async () => {
    addUser("u-1", { planTier: "pro", organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const minted = await mint();
    vi.stubEnv("REALTIME_MODEL_PREMIUM", "model-premium-next");
    expect(JSON.parse((await voiceOf(minted.callId)).text).voiceUsed).toBe("premium");
  });

  it("a failed upstream mint logs no model (the secret was never issued)", async () => {
    addUser("u-1", proPremium());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(502);
    expect(fake.rows("trainerSession").every((s) => s.realtimeModel == null)).toBe(true);
  });

  describe("the mint log must land before the credential is released", () => {
    const isMintLog = (a: { data: Record<string, unknown> }) => "realtimeModel" in a.data;
    const mintRaw = () => realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const expectRefusedAndSettled = async (res: Response) => {
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: "usage_unavailable" });
      // No usable credential and no receipt; nothing names a model.
      expect(text).not.toMatch(/ek_test|clientSecret|receipt|model-premium-test|model-standard-test/);
      // OpenAI did issue a secret; it is dropped unused.
      expect(models).toEqual(["model-premium-test"]);
      const [row] = fake.rows("trainerSession");
      expect(row).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
      expect(row.endedAt).toBeInstanceOf(Date);
      // The reservation and the Premium minutes are released; nothing is charged.
      expect(allowanceOf("u-1")).toMatchObject({ minutesReserved: 0, premiumMinutesReserved: 0, minutesUsed: 0 });
      expect(fake.rows("usageEntry").filter((e) => (e.minutes as number) > 0)).toEqual([]);
      return row;
    };

    it("a write that throws: 503, no secret or receipt, the call settled unbilled", async () => {
      addUser("u-1", proPremium());
      vi.spyOn(console, "error").mockImplementation(() => {});
      fake.interleave("trainerSession", "updateMany", async () => { throw new Error("connection reset"); }, isMintLog);
      const row = await expectRefusedAndSettled(await mintRaw());
      expect(row.realtimeModel ?? null).toBeNull();
      // A fresh attempt once the database is back mints and logs normally.
      vi.setSystemTime(at(5));
      const again = await mint();
      expect(typeof again.clientSecret).toBe("string");
      expect(session(again.callId)).toMatchObject({ realtimeModel: "model-premium-test", voiceTier: "premium" });
    });

    it("a write that updates no row (false): 503, no secret or receipt, the call settled unbilled", async () => {
      addUser("u-1", proPremium());
      vi.spyOn(console, "error").mockImplementation(() => {});
      // Another writer got there first, so the guarded update (realtimeModel still null) matches nothing.
      fake.interleave("trainerSession", "updateMany", async () => {
        for (const r of fake.rows("trainerSession")) r.realtimeModel = "model-other-test";
      }, isMintLog);
      const row = await expectRefusedAndSettled(await mintRaw());
      // The guarded writer never overwrote what was there.
      expect(row.realtimeModel).toBe("model-other-test");
    });
  });

  it("an unmetered save stores the tier from the verified receipt once; the label then reads it", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("USAGE_CAPS", "");
    addUser("u-1", { organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const minted = await mint();
    expect(minted.callId).toBeUndefined();
    const saved = await (await save(minted)).json();
    expect(saved.id).toBe(`rt_${minted.sessionId}`);
    expect(session(saved.id)).toMatchObject({ realtimeModel: "model-premium-test", voiceTier: "premium" });
    expect(JSON.parse((await voiceOf(saved.id)).text).voiceUsed).toBe("premium");
  });

  it("a Standard call reads Standard; a text session reads null; another trainee gets 403 and a manager gets the label", async () => {
    addUser("u-1");
    const minted = await mint();
    await save(minted);
    expect(JSON.parse((await voiceOf(minted.callId)).text).voiceUsed).toBe("standard");
    const text = fake.seed("trainerSession", { userId: "u-1", organizationId: "org-1", scenarioId: scn.id, transcript: [{ role: "user", text: "Hi" }] });
    expect(JSON.parse((await voiceOf(text.id)).text).voiceUsed).toBeNull();
    addUser("p-1", { role: "trainee" });
    mocks.authId = "p-1";
    expect((await voiceOf(minted.callId)).status).toBe(403);
    addUser("m-1", { role: "manager" });
    mocks.authId = "m-1";
    expect(JSON.parse((await voiceOf(minted.callId)).text).voiceUsed).toBe("standard");
    expect((await voiceOf("missing-id")).status).toBe(404);
  });

  it("call A's receipt does not label call B", async () => {
    addUser("u-1", proPremium());
    const a = await mint();
    vi.setSystemTime(at(5));
    const b = await mint();
    // a holds the 40 Premium minutes, so b is Standard; a's Premium receipt cannot relabel it.
    expect(session(b.callId)).toMatchObject({ realtimeModel: "model-standard-test", voiceTier: "standard" });
    await save({ ...b, receipt: a.receipt });
    expect(session(b.callId)).toMatchObject({ realtimeModel: "model-standard-test", voiceTier: "standard" });
    const audit = fake.rows("auditEvent").find((e) => e.action === "session.saved")!;
    expect((audit.metadata as { receiptRejected?: boolean }).receiptRejected).toBe(true);
  });
});

// ---- Client seam for premium_upsell_viewed ------------------------------------------------------------------

describe("premium_upsell_viewed", () => {
  it("dispatches one DOM event per surface per page view, with only the surface", () => {
    resetPremiumUpsellSeen();
    const seen: unknown[] = [];
    const target = { dispatchEvent: (e: Event) => { seen.push((e as CustomEvent).detail); return true; } };
    expect(trackPremiumUpsell("setup", target)).toBe(true);
    expect(trackPremiumUpsell("setup", target)).toBe(false);
    expect(trackPremiumUpsell("billing", target)).toBe(true);
    expect(seen).toEqual([{ name: "premium_upsell_viewed", surface: "setup" }, { name: "premium_upsell_viewed", surface: "billing" }]);
    expect(PREMIUM_DOM_EVENT).toBe("calltrainer:premium-event");
  });
});
