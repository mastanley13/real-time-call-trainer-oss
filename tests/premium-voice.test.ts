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
import { PREMIUM_STATUSES, premiumBlock, premiumEntitled, premiumMinutesCapFor, premiumMinutesLeft } from "@/lib/premiumVoice";
import { addonQuantitySync, addonSyncRequest, invoiceSubscriptionId, parseLiveSubscription, periodEndOf, PRICE_ENV, resetPriceCache } from "@/lib/billing";
import { setPremiumEventSink, type PremiumEvent } from "@/lib/billingEvents";
import { readMintReceipt, signMintReceipt } from "@/lib/mintReceipt";
import { PREMIUM_DOM_EVENT, resetPremiumUpsellSeen, trackPremiumUpsell } from "@/lib/premiumEventTypes";
import { stripeApi, StripeApiError } from "@/lib/stripe";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { POST as saveTranscript } from "@/app/api/transcripts/route";
import { GET as getTranscript } from "@/app/api/transcripts/[id]/route";

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

  it("only active and trialing qualify", () => {
    expect(PREMIUM_STATUSES).toEqual(["active", "trialing"]);
    for (const s of ["active", "trialing"]) expect(premiumEntitled(row({ subscriptionStatus: s }), now), s).toBe(true);
    for (const s of ["past_due", "unpaid", "canceled", "incomplete", "incomplete_expired", "paused", null, "weird"]) {
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
      ["trialing", { subscriptionStatus: "trialing" }, "premium"],
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
    // Comped is independent of the flag.
    const c = await begin("u-1", 5, { compedPremium: true });
    expect(c).toMatchObject({ engine: "premium" });
    expect(c.premium.source).toBe("comped");
  });

  it("the past_due base plan keeps its grace (still Pro minutes) while Premium is off", async () => {
    addUser("u-1", proPremium({ subscriptionStatus: "past_due", pastDueSince: new Date(base.getTime() - DAY) }));
    const r = await resolveAllowance(fake.db as never, "u-1", base);
    expect(r).toMatchObject({ plan: "pro", premiumVoice: false, premiumConfigured: true });
    expect(r!.allowance).toMatchObject({ minutesCap: 200, premiumMinutesCap: 0 });
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
    expect(session(body.callId)).toMatchObject({ engineTier: "premium", premiumReservedMinutes: 0 });
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
    expect(session(body.callId)).toMatchObject({ engineTier: "premium", premiumReservedMinutes: 0 });
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
    addUser("u-1", proPremium());
  });
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

  it("invoice.payment_failed turns Premium off for the next call even before Stripe reports past_due; invoice.paid restores it", async () => {
    live = liveSub("active", { premium: 1 }); // Stripe still says active
    await deliver("invoice.payment_failed", { id: "in_test_1", customer: "cus_test_pro", subscription: "sub_test_pro" });
    expect(user()).toMatchObject({ premiumVoice: false, planTier: "pro" });
    expect((await begin("u-1")).engine).toBe("standard");
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_removed", reason: "payment_failed" }));
    await deliver("invoice.paid", { id: "in_test_1", customer: "cus_test_pro", parent: { subscription_details: { subscription: "sub_test_pro" } } });
    expect(user().premiumVoice).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_added" }));
    expect((await begin("u-1", 10)).engine).toBe("premium");
  });

  it("cancel at period end keeps Premium until the period end, then the next mint is Standard", async () => {
    const end = new Date(base.getTime() + 2 * DAY);
    live = liveSub("active", { premium: 1, cancelAtPeriodEnd: true, periodEnd: Math.floor(end.getTime() / 1000) });
    await deliver("customer.subscription.updated", { id: "sub_test_pro", customer: "cus_test_pro" });
    expect((await begin("u-1")).engine).toBe("premium");
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
    expect(r).toMatchObject({ engine: "premium" });
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
    beforeEach(() => {
      Object.assign(org(), {
        planTier: "team", seatCount: 4, premiumVoice: true, premiumVoiceQuantity: 4, stripeSubscriptionId: "sub_test_team",
        stripeCustomerId: "cus_test_team", subscriptionStatus: "active", subscriptionPeriodEnd: future(),
      });
      update = vi.spyOn(stripeApi, "updateSubscription").mockResolvedValue({});
    });
    const seatChange = () => deliver("customer.subscription.updated", { id: "sub_test_team", customer: "cus_test_team" });

    it("pure: quantity = seats (Pro 1); nothing when in step, scheduled, ending, or not in good standing", () => {
      const parse = (o: unknown) => parseLiveSubscription(o);
      expect(addonQuantitySync(parse(teamLive(6, 4)))).toEqual({ subscriptionId: "sub_test_team", itemId: "si_test_prem", quantity: 6, direction: "up" });
      expect(addonQuantitySync(parse(teamLive(3, 4)))).toEqual({ subscriptionId: "sub_test_team", itemId: "si_test_prem", quantity: 3, direction: "down" });
      expect(addonQuantitySync(parse(teamLive(4, 4)))).toBeNull();
      expect(addonQuantitySync(parse(teamLive(6, 4, { schedule: "sub_sched_test_1" })))).toBeNull();
      expect(addonQuantitySync(parse(teamLive(6, 4, { cancel_at_period_end: true })))).toBeNull();
      expect(addonQuantitySync(parse(teamLive(6, 4, { status: "past_due" })))).toBeNull();
      expect(addonQuantitySync(parse(liveSub("active", { premium: 2 })))).toMatchObject({ quantity: 1, direction: "down" });
      expect(addonSyncRequest({ subscriptionId: "sub_test_team", itemId: "si_test_prem", quantity: 6, direction: "up" })).toEqual({
        id: "sub_test_team", params: { items: [{ id: "si_test_prem", quantity: 6 }], proration_behavior: "create_prorations" }, idempotencyKey: "addon-sync:sub_test_team:si_test_prem:6",
      });
    });

    it("more seats in the portal: the pool stays at what is paid until the add-on follows, then grows", async () => {
      live = teamLive(6, 4);
      await seatChange();
      // Never more Premium than paid for: min(add-on 4, seats 6) = 4 units.
      expect(org()).toMatchObject({ seatCount: 6, premiumVoiceQuantity: 4 });
      expect(orgAllowance()).toMatchObject({ minutesCap: 1800, premiumMinutesCap: 160 });
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]).toEqual(["sub_test_team", { items: [{ id: "si_test_prem", quantity: 6 }], proration_behavior: "create_prorations" }, "addon-sync:sub_test_team:si_test_prem:6"]);
      // Stripe reports the synced add-on: the pool grows to 6 units and nothing more is written.
      live = teamLive(6, 6);
      await seatChange();
      expect(orgAllowance()).toMatchObject({ premiumMinutesCap: 240 });
      expect(update).toHaveBeenCalledTimes(1);
    });

    it("fewer seats in the portal: the pool shrinks with the seats at once and the add-on follows without a credit", async () => {
      live = teamLive(3, 4);
      await seatChange();
      expect(orgAllowance()).toMatchObject({ minutesCap: 900, premiumMinutesCap: 120 });
      expect(update.mock.calls[0]).toEqual(["sub_test_team", { items: [{ id: "si_test_prem", quantity: 3 }], proration_behavior: "none" }, "addon-sync:sub_test_team:si_test_prem:3"]);
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
      expect(update.mock.calls[1][2]).toBe("addon-sync:sub_test_team:si_test_prem:6");
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

describe("session log: realtimeModel and effective tier", () => {
  it("receipts carry the tier and call id sealed: readable only by the server, for the same user", () => {
    const r = signMintReceipt("u-1", "model-x", Date.now(), JWT, { tier: "premium", callId: "call-1" })!;
    expect(readMintReceipt(r, "u-1", Date.now(), JWT)).toEqual({ model: "model-x", tier: "premium", callId: "call-1" });
    const raw = Buffer.from(r.slice(r.indexOf(".") + 1), "base64url");
    raw[raw.length - 1] ^= 0x01;
    expect(readMintReceipt(`${r.slice(0, r.indexOf(".") + 1)}${raw.toString("base64url")}`, "u-1", Date.now(), JWT)).toBeNull();
    expect(readMintReceipt(r, "u-2", Date.now(), JWT)).toBeNull();
  });

  const save = (body: Record<string, unknown>) => saveTranscript(new NextRequest("http://localhost/api/transcripts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "s-1", transcript: [{ role: "user", text: "Hi" }], scenario: { id: scn.id }, ...body }),
  }));

  it("a receipt minted for one call cannot relabel another, and the mint-time log is never overwritten", async () => {
    addUser("u-1", proPremium());
    const a = await begin("u-1");
    fake.rows("trainerSession").find((s) => s.id === a.callId)!.realtimeModel = "model-standard-test";
    const premiumReceipt = signMintReceipt("u-1", "model-premium-test", Date.now(), JWT, { tier: "premium", callId: "some-other-call" });
    expect((await save({ callId: a.callId, realtimeReceipt: premiumReceipt })).status).toBe(200);
    expect(session(a.callId)).toMatchObject({ realtimeModel: "model-standard-test", engineTier: "premium" });
  });

  it("an unmetered call logs the model and tier from a receipt with no call id", async () => {
    addUser("u-1");
    const receipt = signMintReceipt("u-1", "model-premium-test", Date.now(), JWT, { tier: "premium" });
    const res = await save({ realtimeReceipt: receipt });
    const { id } = await res.json();
    expect(session(id)).toMatchObject({ realtimeModel: "model-premium-test", engineTier: "premium" });
  });

  it("GET /api/transcripts/[id] shows the voice used, never the model id", async () => {
    addUser("u-1", proPremium());
    const a = await begin("u-1");
    Object.assign(session(a.callId), { realtimeModel: "model-premium-test", transcript: [{ role: "user", text: "Hi" }] });
    const res = await getTranscript(new NextRequest(`http://localhost/api/transcripts/${a.callId}`), { params: Promise.resolve({ id: a.callId }) });
    const text = await res.text();
    expect(JSON.parse(text).session.voiceUsed).toBe("premium");
    expect(text).not.toContain("model-premium-test");
    expect(JSON.parse(text).session).not.toHaveProperty("realtimeModel");
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
