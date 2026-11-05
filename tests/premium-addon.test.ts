import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Database, session check and Stripe's HTTP methods are replaced. No Stripe object is created; nothing leaves the process.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "owner-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/rateLimit")>()), ipLimitResponse: () => null, userLimitResponse: () => null }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));

import {
  AddonError, addonQuantity, confirmAddPremium, confirmSeatChange, planAddPremium, previewAddPremium, previewSeatChange, readPreviewToken,
  renewalTotal, scheduleRemovePremium, seatItems, signPreviewToken, splitItems, type AddonDeps, type AddonSubject,
} from "@/lib/premiumAddon";
import { PRICE_ENV, parseLiveSubscription, resetPriceCache, type PriceIds } from "@/lib/billing";
import { setPremiumEventSink, type PremiumEvent } from "@/lib/billingEvents";
import { stripeApi, StripeApiError } from "@/lib/stripe";
import { getCapabilities, premiumOnSale } from "@/lib/serverConfig";
import { checkoutBody } from "@/lib/checkoutStart";
import { POST as premiumRoute } from "@/app/api/billing/premium/route";
import { POST as seatsRoute } from "@/app/api/billing/seats/route";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";

const JWT = "test-only-not-a-secret-0123456789abcdef";
const NOW = new Date("2026-11-05T15:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const END_S = NOW_S + 20 * 86400;
const PERIOD_START_S = END_S - 30 * 86400;

// Placeholder ids, not real Stripe objects.
const PRICES: PriceIds = {
  pro: { month: "price_test_pro_m", year: "price_test_pro_y" },
  team: { month: "price_test_team_m", year: "price_test_team_y" },
  premium: { month: "price_test_prem_m", year: "price_test_prem_y" },
};
const PRO_META = { ct_plan: "pro", ct_addon: "none", ct_version: "1" };
const TEAM_META = { ct_plan: "team", ct_addon: "none", ct_seat_min: "3", ct_version: "1" };
const PREMIUM_META = { ct_plan: "addon", ct_addon: "premium_voice", ct_version: "1" };
const UNIT: Record<string, number> = { price_test_pro_m: 2900, price_test_pro_y: 29000, price_test_team_m: 5900, price_test_team_y: 59000, price_test_prem_m: 2000, price_test_prem_y: 20000 };
const META: Record<string, Record<string, string>> = { pro: PRO_META, team: TEAM_META, prem: PREMIUM_META };
const price = (id: string) => {
  const [, , kind, iv] = id.split("_");
  return { id, type: "recurring", unit_amount: UNIT[id], currency: "usd", recurring: { usage_type: "licensed", interval: iv === "y" ? "year" : "month" }, product: { metadata: META[kind] } };
};
type SubOpts = { plan?: "pro" | "team"; interval?: "m" | "y"; seats?: number; premium?: number; status?: string; schedule?: string | null; cancelAtPeriodEnd?: boolean };
const subscription = (o: SubOpts = {}) => {
  const plan = o.plan ?? "team";
  const iv = o.interval ?? "m";
  return {
    id: plan === "team" ? "sub_test_team" : "sub_test_pro", customer: "cus_test_1", status: o.status ?? "active", metadata: {},
    current_period_end: END_S, cancel_at_period_end: o.cancelAtPeriodEnd ?? false, schedule: o.schedule ?? null,
    items: { data: [
      { id: "si_test_base", quantity: plan === "team" ? o.seats ?? 3 : 1, price: price(`price_test_${plan}_${iv}`) },
      ...(o.premium ? [{ id: "si_test_prem", quantity: o.premium, price: price(`price_test_prem_${iv}`) }] : []),
    ] },
  };
};

const TEAM: AddonSubject = { kind: "organization", id: "org-1", plan: "team", subscriptionId: "sub_test_team", seats: 3 };
const PRO: AddonSubject = { kind: "user", id: "owner-1", plan: "pro", subscriptionId: "sub_test_pro", seats: 1 };

/** Every Stripe dependency as a typed vitest mock of its own AddonDeps signature, so `.mock.calls` is typed. */
type MockDeps = { [K in keyof AddonDeps]: Mock<AddonDeps[K]> };

function deps(sub: ReturnType<typeof subscription>, extra: Partial<MockDeps> = {}): MockDeps {
  const schedule = { id: "sub_sched_test_1", phases: [{ start_date: PERIOD_START_S, end_date: END_S, items: sub.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity })) }] };
  return {
    retrieveSubscription: vi.fn<AddonDeps["retrieveSubscription"]>(async () => sub),
    retrievePrice: vi.fn<AddonDeps["retrievePrice"]>(async (id) => ({ id, unit_amount: UNIT[id] })),
    previewInvoice: vi.fn<AddonDeps["previewInvoice"]>(async () => ({ amount_due: 1333, currency: "usd" })),
    updateSubscription: vi.fn<AddonDeps["updateSubscription"]>(async () => ({})),
    createSubscriptionSchedule: vi.fn<AddonDeps["createSubscriptionSchedule"]>(async () => ({ id: "sub_sched_test_1" })),
    retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async () => schedule),
    updateSubscriptionSchedule: vi.fn<AddonDeps["updateSubscriptionSchedule"]>(async () => ({})),
    prices: vi.fn<AddonDeps["prices"]>(async () => PRICES),
    sync: vi.fn<AddonDeps["sync"]>(async () => undefined),
    ...extra,
  };
}

/** Schedule params read in the shape the assertions need. The mocks themselves stay fully typed. */
type SchedulePhases = { phases: { items: unknown[] }[] };
const phasesOf = (params: unknown): SchedulePhases => params as SchedulePhases;

beforeEach(() => {
  vi.stubEnv("JWT_SECRET", JWT);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---- Pure planning ---------------------------------------------------------------------------------------

describe("planning a Premium add", () => {
  it("matches the base interval and uses quantity = seats (Pro 1)", () => {
    expect(planAddPremium(parseLiveSubscription(subscription({ seats: 5 })), PRICES, "team")).toEqual({ priceId: "price_test_prem_m", quantity: 5, interval: "month" });
    expect(planAddPremium(parseLiveSubscription(subscription({ plan: "pro", interval: "y" })), PRICES, "pro")).toEqual({ priceId: "price_test_prem_y", quantity: 1, interval: "year" });
    expect(addonQuantity("pro", 9)).toBe(1);
    expect(addonQuantity("team", 7)).toBe(7);
  });

  it("refuses when already added, not in good standing, already scheduled or ending, or unpriced", () => {
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (e) { return (e as AddonError).code; } };
    expect(code(() => planAddPremium(parseLiveSubscription(subscription({ premium: 3 })), PRICES, "team"))).toBe("already_added");
    for (const status of ["past_due", "unpaid", "incomplete", "canceled"]) {
      expect(code(() => planAddPremium(parseLiveSubscription(subscription({ status })), PRICES, "team")), status).toBe("not_in_good_standing");
    }
    expect(code(() => planAddPremium(parseLiveSubscription(subscription({ schedule: "sub_sched_test_x" })), PRICES, "team"))).toBe("change_scheduled");
    expect(code(() => planAddPremium(parseLiveSubscription(subscription({ cancelAtPeriodEnd: true })), PRICES, "team"))).toBe("change_scheduled");
    expect(code(() => planAddPremium(parseLiveSubscription(subscription()), { ...PRICES, premium: { month: undefined, year: undefined } }, "team"))).toBe("price_not_configured");
  });

  it("renewal total is every item's unit amount times quantity, plus the add-on", () => {
    const live = parseLiveSubscription(subscription({ seats: 4 }));
    expect(renewalTotal(live)).toBe(4 * 5900);
    expect(renewalTotal(live, [{ priceUnit: 2000, quantity: 4 }])).toBe(4 * 5900 + 4 * 2000);
    expect(renewalTotal(live, [{ itemId: "si_test_base", quantity: 6 }])).toBe(6 * 5900);
    expect(renewalTotal(live, [{ priceUnit: null, quantity: 1 }])).toBeNull();
  });

  it("seat changes move the base item and the add-on item to the same quantity", () => {
    const { base, premium } = splitItems(parseLiveSubscription(subscription({ seats: 4, premium: 4 })));
    expect(seatItems(base!, premium, 6)).toEqual([{ id: "si_test_base", quantity: 6 }, { id: "si_test_prem", quantity: 6 }]);
    const noPrem = splitItems(parseLiveSubscription(subscription({ seats: 4 })));
    expect(seatItems(noPrem.base!, noPrem.premium, 6)).toEqual([{ id: "si_test_base", quantity: 6 }]);
  });
});

// ---- Preview tokens ----------------------------------------------------------------------------------------

describe("preview tokens", () => {
  const payload = { k: "add" as const, s: "organization:org-1", u: "owner-1", sub: "sub_test_team", items: [{ price: "price_test_prem_m", quantity: 3 }], d: NOW_S, a: 1333, exp: NOW_S + 600 };
  it("verify only for the same actor, subject and kind, unexpired and untampered", () => {
    const t = signPreviewToken(payload, JWT);
    const want = { userId: "owner-1", subject: "organization:org-1", kind: "add" as const };
    expect(readPreviewToken(t, want, NOW.getTime(), JWT)).toMatchObject({ a: 1333, d: NOW_S });
    expect(readPreviewToken(t, { ...want, userId: "rep-1" }, NOW.getTime(), JWT)).toBeNull();
    expect(readPreviewToken(t, { ...want, subject: "user:owner-1" }, NOW.getTime(), JWT)).toBeNull();
    expect(readPreviewToken(t, { ...want, kind: "seats" }, NOW.getTime(), JWT)).toBeNull();
    expect(readPreviewToken(t, want, (NOW_S + 601) * 1000, JWT)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace('"quantity":3', '"quantity":30')).toString("base64url");
    expect(readPreviewToken(`${forged}.${sig}`, want, NOW.getTime(), JWT)).toBeNull();
    expect(readPreviewToken(t, want, NOW.getTime(), "another-key-0123456789abcdef0123456789")).toBeNull();
  });

  it("cannot be signed without JWT_SECRET", () => {
    expect(() => signPreviewToken(payload, "")).toThrow(AddonError);
  });
});

// ---- Add Premium: preview, then confirm -----------------------------------------------------------------------

describe("adding Premium to an existing subscription", () => {
  it("preview asks Stripe for the prorated invoice at a fixed proration date and shows the new renewal total", async () => {
    const d = deps(subscription({ seats: 4 }));
    const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", d, NOW);
    expect(d.previewInvoice).toHaveBeenCalledWith({
      subscription: "sub_test_team",
      subscription_details: { items: [{ price: "price_test_prem_m", quantity: 4 }], proration_behavior: "always_invoice", proration_date: NOW_S },
    });
    expect(p).toMatchObject({ dueNow: 1333, renewalTotal: 4 * 5900 + 4 * 2000, currency: "usd", interval: "month", quantity: 4, renewsAt: new Date(END_S * 1000).toISOString() });
    expect(d.updateSubscription).not.toHaveBeenCalled();
    expect(JSON.stringify({ ...p, token: undefined })).not.toMatch(/sub_|price_|cus_|si_/);
  });

  it("confirm charges exactly the preview: same proration date, always_invoice, error_if_incomplete, idempotent key", async () => {
    const d = deps(subscription({ seats: 4 }));
    const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", d, NOW);
    const later = new Date(NOW.getTime() + 120_000);
    await confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, d, later);
    await confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, d, later);
    expect(d.updateSubscription).toHaveBeenCalledTimes(2);
    const [id, params, key] = d.updateSubscription.mock.calls[0];
    const key2 = d.updateSubscription.mock.calls[1][2];
    expect(id).toBe("sub_test_team");
    expect(params).toEqual({
      items: [{ price: "price_test_prem_m", quantity: 4 }], proration_behavior: "always_invoice", proration_date: NOW_S,
      payment_behavior: "error_if_incomplete", metadata: { premium: "true" },
    });
    // A double submit sends the same idempotency key, so Stripe makes one change.
    expect(key).toBe(key2);
    expect(key).toMatch(/^premium-add:[0-9a-f]{48}$/);
    expect(d.sync).toHaveBeenCalledWith("sub_test_team");
  });

  it("confirm refuses a missing, expired, tampered or other user's token, and a subscription that changed since", async () => {
    const d = deps(subscription({ seats: 4 }));
    const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", d, NOW);
    const fail = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return (e as AddonError).code; } };
    expect(await fail(() => confirmAddPremium(TEAM, "owner-1", "nope", d, NOW))).toBe("invalid_token");
    expect(await fail(() => confirmAddPremium(TEAM, "owner-1", p.token, d, new Date(NOW.getTime() + 11 * 60_000)))).toBe("invalid_token");
    expect(await fail(() => confirmAddPremium(TEAM, "manager-1", p.token, d, NOW))).toBe("invalid_token");
    expect(await fail(() => confirmAddPremium(PRO, "owner-1", p.token, d, NOW))).toBe("invalid_token");
    // Seats went from 4 to 6 after the preview: the charge shown is no longer the charge.
    const changed = deps(subscription({ seats: 6 }));
    expect(await fail(() => confirmAddPremium(TEAM, "owner-1", p.token, changed, NOW))).toBe("subscription_changed");
    expect(d.updateSubscription).not.toHaveBeenCalled();
    expect(changed.updateSubscription).not.toHaveBeenCalled();
  });
});

// ---- Removal at period end ------------------------------------------------------------------------------------

describe("removing Premium at period end", () => {
  it("puts the subscription under a schedule: this period unchanged, next period without the add-on, then released", async () => {
    const d = deps(subscription({ seats: 4, premium: 4 }));
    const { removeAt } = await scheduleRemovePremium(TEAM, d, NOW);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(d.createSubscriptionSchedule).toHaveBeenCalledWith({ from_subscription: "sub_test_team" }, expect.stringMatching(/^premium-remove:sub_test_team:/));
    expect(d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
    const [schedId, params] = d.updateSubscriptionSchedule.mock.calls[0];
    expect(schedId).toBe("sub_sched_test_1");
    expect(params).toEqual({
      end_behavior: "release",
      phases: [
        { items: [{ price: "price_test_team_m", quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }], start_date: PERIOD_START_S, end_date: END_S, proration_behavior: "none" },
        { items: [{ price: "price_test_team_m", quantity: 4 }], iterations: 1, proration_behavior: "none" },
      ],
    });
    // Nothing is charged, credited or changed now.
    expect(d.updateSubscription).not.toHaveBeenCalled();
    expect(d.previewInvoice).not.toHaveBeenCalled();
  });

  it("reuses an existing schedule and keeps its pending seat decrease", async () => {
    const sub = subscription({ seats: 6, premium: 6, schedule: "sub_sched_test_1" });
    const d = deps(sub, {
      retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async () => ({ id: "sub_sched_test_1", phases: [
        { start_date: PERIOD_START_S, end_date: END_S, items: [{ price: "price_test_team_m", quantity: 6 }, { price: "price_test_prem_m", quantity: 6 }] },
        { start_date: END_S, end_date: END_S + 30 * 86400, items: [{ price: { id: "price_test_team_m" }, quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }] },
      ] })),
    });
    await scheduleRemovePremium(TEAM, d, NOW);
    expect(d.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
    expect(phasesOf(d.updateSubscriptionSchedule.mock.calls[0][1]).phases[1].items).toEqual([{ price: "price_test_team_m", quantity: 4 }]);
  });

  it("a subscription already set to cancel at period end needs no schedule: Premium ends with it", async () => {
    const d = deps(subscription({ premium: 3, cancelAtPeriodEnd: true }));
    const { removeAt } = await scheduleRemovePremium(TEAM, d, NOW);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(d.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(d.updateSubscriptionSchedule).not.toHaveBeenCalled();
  });

  it("refuses when there is nothing to remove", async () => {
    await expect(scheduleRemovePremium(TEAM, deps(subscription()), NOW)).rejects.toMatchObject({ code: "not_added" });
  });
});

// ---- Seats: add now (prorated), remove at renewal --------------------------------------------------------------

describe("seat changes keep the add-on quantity in step", () => {
  it("an increase updates base and add-on together now, prorated and charged at once", async () => {
    const d = deps(subscription({ seats: 4, premium: 4 }));
    const p = await previewSeatChange({ ...TEAM, seats: 4 }, "owner-1", 6, d, NOW);
    expect(p).toMatchObject({ direction: "up", dueNow: 1333, renewalTotal: 6 * 5900 + 6 * 2000 });
    expect(d.previewInvoice).toHaveBeenCalledWith(expect.objectContaining({
      subscription_details: { items: [{ id: "si_test_base", quantity: 6 }, { id: "si_test_prem", quantity: 6 }], proration_behavior: "always_invoice", proration_date: NOW_S },
    }));
    const done = await confirmSeatChange({ ...TEAM, seats: 4 }, "owner-1", 6, p.token, d, NOW);
    expect(done.direction).toBe("up");
    expect(d.updateSubscription).toHaveBeenCalledTimes(1);
    const [, params, key] = d.updateSubscription.mock.calls[0];
    expect(params).toEqual({ items: [{ id: "si_test_base", quantity: 6 }, { id: "si_test_prem", quantity: 6 }], proration_behavior: "always_invoice", proration_date: NOW_S, payment_behavior: "error_if_incomplete" });
    expect(key).toMatch(/^seats-up:/);
    expect(d.sync).toHaveBeenCalled();
  });

  it("a decrease waits for renewal: nothing charged now, base and add-on drop together in the next phase", async () => {
    const d = deps(subscription({ seats: 6, premium: 6 }));
    const p = await previewSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, d, NOW);
    expect(p).toMatchObject({ direction: "down", dueNow: 0, renewalTotal: 4 * 5900 + 4 * 2000, effectiveAt: new Date(END_S * 1000).toISOString() });
    expect(d.previewInvoice).not.toHaveBeenCalled();
    const done = await confirmSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, p.token, d, NOW);
    expect(done.effectiveAt?.getTime()).toBe(END_S * 1000);
    expect(d.updateSubscription).not.toHaveBeenCalled();
    expect(d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
    const { phases } = phasesOf(d.updateSubscriptionSchedule.mock.calls[0][1]);
    expect(phases[0].items).toEqual([{ price: "price_test_team_m", quantity: 6 }, { price: "price_test_prem_m", quantity: 6 }]);
    expect(phases[1].items).toEqual([{ price: "price_test_team_m", quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }]);
  });

  it("rejects seat counts out of range, no change, Pro, and a confirm whose seats differ from the preview", async () => {
    const d = deps(subscription({ seats: 4 }));
    await expect(previewSeatChange(TEAM, "owner-1", 2, d, NOW)).rejects.toMatchObject({ code: "invalid_seats" });
    await expect(previewSeatChange(TEAM, "owner-1", 4, d, NOW)).rejects.toMatchObject({ code: "no_change" });
    await expect(previewSeatChange(PRO, "owner-1", 4, deps(subscription({ plan: "pro" })), NOW)).rejects.toMatchObject({ code: "not_team" });
    const p = await previewSeatChange(TEAM, "owner-1", 5, d, NOW);
    await expect(confirmSeatChange(TEAM, "owner-1", 7, p.token, d, NOW)).rejects.toMatchObject({ code: "subscription_changed" });
  });
});

// ---- Routes: sale gate, owner authorization, no Stripe ids -----------------------------------------------------

describe("/api/billing/premium and /api/billing/seats", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  let live: ReturnType<typeof subscription>;
  let events: PremiumEvent[];
  const call = (route: typeof premiumRoute, url: string, body: unknown) => route(new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const premium = (body: unknown) => call(premiumRoute, "http://localhost/api/billing/premium", body);
  const seats = (body: unknown) => call(seatsRoute, "http://localhost/api/billing/seats", body);

  beforeEach(() => {
    // The server clock sits inside the fake billing period, whenever this suite runs.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    fake = createFakePrisma();
    mocks.fake = fake;
    mocks.authId = "owner-1";
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    for (const slot of ["pro", "team", "premium"] as const) for (const i of ["month", "year"] as const) vi.stubEnv(PRICE_ENV[slot][i], PRICES[slot][i]!);
    resetPriceCache();
    fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-02-20T00:00:00Z"), planTier: "team", seatCount: 4, stripeSubscriptionId: "sub_test_team", stripeCustomerId: "cus_test_1", subscriptionStatus: "active", subscriptionPeriodEnd: new Date(END_S * 1000) });
    fake.seed("user", { id: "owner-1", email: "owner-1@example.test", organizationId: "org-1", role: "owner" });
    fake.seed("user", { id: "manager-1", email: "manager-1@example.test", organizationId: "org-1", role: "manager" });
    fake.seed("user", { id: "rep-1", email: "rep-1@example.test", organizationId: "org-1", role: "trainee" });
    live = subscription({ seats: 4 });
    vi.spyOn(stripeApi, "retrieveSubscription").mockImplementation(async () => live);
    vi.spyOn(stripeApi, "retrievePrice").mockImplementation(async (id: string) => ({ ...price(id), active: true, livemode: false }));
    vi.spyOn(stripeApi, "previewInvoice").mockResolvedValue({ amount_due: 1333, currency: "usd" });
    vi.spyOn(stripeApi, "updateSubscription").mockImplementation(async () => {
      live = subscription({ seats: 4, premium: 4 });
      return live;
    });
    vi.spyOn(stripeApi, "createSubscriptionSchedule").mockResolvedValue({ id: "sub_sched_test_1" });
    vi.spyOn(stripeApi, "retrieveSubscriptionSchedule").mockImplementation(async () => ({ id: "sub_sched_test_1", phases: [{ start_date: PERIOD_START_S, end_date: END_S, items: live.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity })) }] }));
    vi.spyOn(stripeApi, "updateSubscriptionSchedule").mockResolvedValue({});
    events = [];
    setPremiumEventSink((e) => { events.push(e); });
  });
  afterEach(() => { setPremiumEventSink(null); vi.useRealTimers(); });

  it("sale off: preview and confirm are 400 premium_not_available without touching Stripe; removal still works", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    for (const body of [{ action: "preview" }, { action: "confirm", token: "x" }]) {
      const res = await premium(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("premium_not_available");
    }
    expect((await seats({ action: "preview", seats: 5 })).status).toBe(400);
    expect(stripeApi.previewInvoice).not.toHaveBeenCalled();
    expect(stripeApi.updateSubscription).not.toHaveBeenCalled();
    live = subscription({ seats: 4, premium: 4 });
    const res = await premium({ action: "remove" });
    expect(res.status).toBe(200);
    expect((await res.json()).removeAt).toBe(new Date(END_S * 1000).toISOString());
  });

  it("only exact true turns the sale on", async () => {
    for (const v of ["TRUE", "1", "yes", "false"]) {
      vi.stubEnv("PREMIUM_VOICE_ON_SALE", v);
      expect((await premium({ action: "preview" })).status, v).toBe(400);
    }
  });

  it("Team: only the owner; managers and trainees get 403 and Stripe is not called", async () => {
    for (const who of ["manager-1", "rep-1"]) {
      mocks.authId = who;
      const res = await premium({ action: "preview" });
      expect(res.status, who).toBe(403);
      expect((await res.json()).message).toContain("Ask your admin");
    }
    expect(stripeApi.retrieveSubscription).not.toHaveBeenCalled();
  });

  it("an account with no paid subscription gets 409 no_subscription (checkout is the path for new buyers)", async () => {
    fake.seed("user", { id: "solo-1", email: "solo-1@example.test", organizationId: null, role: "owner" });
    mocks.authId = "solo-1";
    expect((await premium({ action: "preview" })).status).toBe(409);
  });

  it("owner: preview shows the prorated charge and renewal total with no Stripe ids; confirm adds it and the add-on syncs", async () => {
    const res = await premium({ action: "preview" });
    expect(res.status).toBe(200);
    const text = await res.text();
    const p = JSON.parse(text);
    expect(p).toMatchObject({ dueNow: 1333, renewalTotal: 4 * 5900 + 4 * 2000, interval: "month", quantity: 4 });
    expect(text.replace(p.token, "")).not.toMatch(/sub_|price_|cus_|si_|sk_test/);
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_add_started", subject: "organization", plan: "team", units: 4 }));

    const done = await premium({ action: "confirm", token: p.token });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ added: true, quantity: 4 });
    const org = fake.rows("organization")[0];
    expect(org).toMatchObject({ premiumVoice: true, premiumVoiceQuantity: 4, seatCount: 4 });
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_added", subject: "organization", units: 4 }));
    expect(fake.rows("auditEvent").some((a) => a.action === "billing.premium_added")).toBe(true);
    const pool = fake.rows("usageAllowance").find((a) => a.organizationId === "org-1")!;
    expect(pool).toMatchObject({ minutesCap: 1200, premiumMinutesCap: 160 });
  });

  it("a declined card answers 402 and nothing changes", async () => {
    const p = await (await premium({ action: "preview" })).json();
    vi.mocked(stripeApi.updateSubscription).mockRejectedValueOnce(new StripeApiError(402));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await premium({ action: "confirm", token: p.token });
    expect(res.status).toBe(402);
    expect((await res.json()).error).toBe("payment_failed");
    expect(fake.rows("organization")[0].premiumVoice).toBe(false);
  });

  it("remove schedules the end of Premium for the period end and records the date shown on billing", async () => {
    live = subscription({ seats: 4, premium: 4 });
    Object.assign(fake.rows("organization")[0], { premiumVoice: true, premiumVoiceQuantity: 4 });
    const res = await premium({ action: "remove" });
    expect(await res.json()).toEqual({ removeAt: new Date(END_S * 1000).toISOString() });
    expect((fake.rows("organization")[0].premiumVoiceRemoveAt as Date).getTime()).toBe(END_S * 1000);
    // Premium stays on until then.
    expect(fake.rows("organization")[0].premiumVoice).toBe(true);
    expect(events).toContainEqual(expect.objectContaining({ name: "premium_removed", reason: "scheduled" }));
  });

  it("seats: a decrease is recorded for renewal; an increase syncs base and add-on now", async () => {
    live = subscription({ seats: 4, premium: 4 });
    Object.assign(fake.rows("organization")[0], { premiumVoice: true, premiumVoiceQuantity: 4 });
    const down = await (await seats({ action: "preview", seats: 3 })).json();
    expect(down).toMatchObject({ direction: "down", dueNow: 0 });
    const confirmed = await seats({ action: "confirm", seats: 3, token: down.token });
    expect(await confirmed.json()).toMatchObject({ direction: "down", effectiveAt: new Date(END_S * 1000).toISOString() });
    expect(fake.rows("organization")[0].seatCountAtRenewal).toBe(3);

    // A pending schedule blocks an increase until it lands, so nothing conflicts.
    live = { ...subscription({ seats: 4, premium: 4 }), schedule: "sub_sched_test_1" };
    const blocked = await seats({ action: "preview", seats: 6 });
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).error).toBe("change_scheduled");
  });

  it("bad bodies are 400", async () => {
    expect((await premium({ action: "buy" })).status).toBe(400);
    expect((await premium({ action: "confirm" })).status).toBe(400);
    expect((await seats({ action: "preview", seats: 2 })).status).toBe(400);
    expect((await seats({ action: "preview", seats: 501 })).status).toBe(400);
  });
});

// ---- Sale gate --------------------------------------------------------------------------------------------------

describe("PREMIUM_VOICE_ON_SALE", () => {
  it("is on only with the exact string true and billing on; /api/config reports it as a boolean", () => {
    expect(premiumOnSale({})).toBe(false);
    expect(premiumOnSale({ PREMIUM_VOICE_ON_SALE: "true" })).toBe(false); // no Stripe key: nothing can be bought
    expect(premiumOnSale({ PREMIUM_VOICE_ON_SALE: "true", STRIPE_SECRET_KEY: "sk_test_placeholder" })).toBe(true);
    expect(premiumOnSale({ PREMIUM_VOICE_ON_SALE: "True", STRIPE_SECRET_KEY: "sk_test_placeholder" })).toBe(false);
    expect(premiumOnSale({ PREMIUM_VOICE_ON_SALE: "true", STRIPE_SECRET_KEY: "sk_test_placeholder", DEMO_MODE: "true" })).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    expect(getCapabilities().premiumOnSale).toBe(false);
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    expect(getCapabilities().premiumOnSale).toBe(true);
  });

  it("the checkout step sends premium:true only when the box was ticked", () => {
    expect(checkoutBody({ plan: "pro", interval: "month" })).toEqual({ plan: "pro", interval: "month", premium: false });
    expect(checkoutBody({ plan: "pro", interval: "year", premium: true })).toEqual({ plan: "pro", interval: "year", premium: true });
    expect(checkoutBody({ plan: "team", interval: "month", seats: 4, premium: true })).toEqual({ plan: "team", interval: "month", premium: true, seats: 4 });
  });
});

// ---- Checkout: new buyers -----------------------------------------------------------------------------------------

describe("checkout with the new-buyer Premium box", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  beforeEach(() => {
    fake = createFakePrisma();
    mocks.fake = fake;
    mocks.authId = "owner-1";
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DEMO_MODE", "");
    for (const slot of ["pro", "team", "premium"] as const) for (const i of ["month", "year"] as const) vi.stubEnv(PRICE_ENV[slot][i], PRICES[slot][i]!);
    resetPriceCache();
    fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-02-20T00:00:00Z") });
    fake.seed("user", { id: "owner-1", email: "owner-1@example.test", organizationId: "org-1", role: "owner", usageAnchorAt: new Date("2026-03-10T09:30:00Z") });
    vi.spyOn(stripeApi, "retrievePrice").mockImplementation(async (id: string) => ({ ...price(id), active: true, livemode: false }));
  });
  const post = (body: unknown) => checkoutRoute(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

  it("on sale: premium:true adds the add-on on the same interval with quantity = seats", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    const create = vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({ id: "cs_test_1", url: "https://checkout.example/test" });
    expect((await post({ plan: "team", interval: "year", seats: 5, premium: true })).status).toBe(200);
    expect(create.mock.calls[0][0].line_items).toEqual([{ price: "price_test_team_y", quantity: 5 }, { price: "price_test_prem_y", quantity: 5 }]);
    expect((create.mock.calls[0][0].metadata as Record<string, string>).premium).toBe("true");
  });

  it("off sale (default): premium:true is rejected and Stripe is never called", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await post({ plan: "pro", interval: "month", premium: true });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("premium_not_available");
    expect(create).not.toHaveBeenCalled();
  });
});
