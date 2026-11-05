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
  renewalTotal, scheduleRemovePremium, seatItems, signPreviewToken, splitItems, canonicalJson, SCHEDULE_LEASE_MS, type AddonDeps, type AddonSubject,
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
  // The subject's premiumScheduleRef, compare-and-set like the database column.
  let ref: string | null = null;
  return {
    readScheduleRef: vi.fn<AddonDeps["readScheduleRef"]>(async () => ref),
    swapScheduleRef: vi.fn<AddonDeps["swapScheduleRef"]>(async (_s, from, to) => {
      if (ref !== from) return false;
      ref = to;
      return true;
    }),
    retrieveSubscription: vi.fn<AddonDeps["retrieveSubscription"]>(async () => sub),
    retrievePrice: vi.fn<AddonDeps["retrievePrice"]>(async (id) => ({ id, unit_amount: UNIT[id] })),
    previewInvoice: vi.fn<AddonDeps["previewInvoice"]>(async () => ({ amount_due: 1333, currency: "usd" })),
    updateSubscription: vi.fn<AddonDeps["updateSubscription"]>(async () => ({})),
    // Stripe's create answers with the whole schedule as created; the app stores it as the exact original.
    createSubscriptionSchedule: vi.fn<AddonDeps["createSubscriptionSchedule"]>(async () => structuredClone(schedule)),
    retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async () => schedule),
    updateSubscriptionSchedule: vi.fn<AddonDeps["updateSubscriptionSchedule"]>(async () => ({})),
    releaseSubscriptionSchedule: vi.fn<AddonDeps["releaseSubscriptionSchedule"]>(async () => ({})),
    prices: vi.fn<AddonDeps["prices"]>(async () => PRICES),
    sync: vi.fn<AddonDeps["sync"]>(async () => undefined),
    now: vi.fn<AddonDeps["now"]>(() => Date.now()),
    ...extra,
  };
}

/** The same subscription with extra Stripe fields (discounts, tax, a schedule, another period...). */
const withTerms = (sub: ReturnType<typeof subscription>, terms: Record<string, unknown>) => ({ ...sub, ...terms }) as ReturnType<typeof subscription>;
const codeOf = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (e) { return (e as AddonError).code; } };

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
  const payload = {
    k: "add" as const, s: "organization:org-1", u: "owner-1", sub: "sub_test_team", items: [{ price: "price_test_prem_m", quantity: 3 }],
    d: NOW_S, a: 1333, c: "usd", q: "a".repeat(64), h: "b".repeat(64), exp: NOW_S + 600,
  };
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

  it("confirm re-previews at the SAME proration date, then charges exactly the reviewed amount with an idempotent key", async () => {
    const d = deps(subscription({ seats: 4 }));
    const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", d, NOW);
    const later = new Date(NOW.getTime() + 120_000);
    await confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, d, later);
    await confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, d, later);
    // One preview at review, one re-preview per confirm, all with identical params (same proration_date).
    expect(d.previewInvoice).toHaveBeenCalledTimes(3);
    for (const [params] of d.previewInvoice.mock.calls) expect(params).toEqual(d.previewInvoice.mock.calls[0][0]);
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

  it("confirm refuses a changed amount, currency, total or balance from the re-preview, and charges nothing", async () => {
    for (const second of [
      { amount_due: 1334, currency: "usd" },
      { amount_due: 1333, currency: "eur" },
      { amount_due: 1333, currency: "usd", total: 1500 },
      { amount_due: 1333, currency: "usd", starting_balance: -200 },
    ]) {
      const d = deps(subscription({ seats: 4 }));
      const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", d, NOW);
      d.previewInvoice.mockResolvedValueOnce(second);
      expect(await codeOf(() => confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, d, NOW)), JSON.stringify(second)).toBe("price_changed");
      expect(d.updateSubscription).not.toHaveBeenCalled();
    }
  });

  it("confirm refuses changed terms: a discount, a base price amount, the add-on price amount, the billing period, tax", async () => {
    const base = subscription({ seats: 4 });
    const changes: [string, MockDeps][] = [
      ["discount added", deps(withTerms(base, { discounts: ["di_test_1"] }))],
      ["base unit amount", deps(withTerms(base, { items: { data: [{ ...base.items.data[0], price: { ...base.items.data[0].price, unit_amount: 6900 } }] } }))],
      ["period moved", deps(withTerms(base, { current_period_end: END_S + 86400 }))],
      ["tax rate added", deps(withTerms(base, { default_tax_rates: ["txr_test_1"] }))],
      ["add-on price amount", deps(base, { retrievePrice: vi.fn<AddonDeps["retrievePrice"]>(async (id) => ({ id, unit_amount: UNIT[id] + 500 })) })],
    ];
    for (const [label, changed] of changes) {
      const p = await previewAddPremium({ ...TEAM, seats: 4 }, "owner-1", deps(base), NOW);
      expect(await codeOf(() => confirmAddPremium({ ...TEAM, seats: 4 }, "owner-1", p.token, changed, NOW)), label).toBe("subscription_changed");
      expect(changed.updateSubscription, label).not.toHaveBeenCalled();
    }
  });
});

// ---- Removal at period end ------------------------------------------------------------------------------------

describe("removing Premium at period end", () => {
  it("puts the subscription under a schedule: this period unchanged, next period without the add-on, then released", async () => {
    const d = deps(subscription({ seats: 4, premium: 4 }));
    const { removeAt } = await scheduleRemovePremium(TEAM, d);
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

  it("refuses ANY existing schedule (a multi-phase one ending in cancel) and leaves it exactly as it is", async () => {
    // Someone else's schedule: a seat decrease at renewal, a later phase, and cancellation at the end.
    const existing = {
      id: "sub_sched_test_other", end_behavior: "cancel",
      phases: [
        { start_date: PERIOD_START_S, end_date: END_S, items: [{ price: "price_test_team_m", quantity: 6 }, { price: "price_test_prem_m", quantity: 6 }], collection_method: "send_invoice" },
        { start_date: END_S, end_date: END_S + 30 * 86400, items: [{ price: "price_test_team_m", quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }] },
        { start_date: END_S + 30 * 86400, end_date: END_S + 60 * 86400, items: [{ price: "price_test_team_m", quantity: 3 }] },
      ],
    };
    const snapshot = JSON.stringify(existing);
    const d = deps(subscription({ seats: 6, premium: 6, schedule: "sub_sched_test_other" }), {
      retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async () => existing),
    });
    const err = await scheduleRemovePremium(TEAM, d).catch((e: AddonError) => e);
    expect(err).toMatchObject({ code: "change_scheduled" });
    expect((err as AddonError).message).toMatch(/cannot safely edit.*Nothing was changed/);
    for (const m of [d.createSubscriptionSchedule, d.retrieveSubscriptionSchedule, d.updateSubscriptionSchedule, d.releaseSubscriptionSchedule, d.updateSubscription]) {
      expect(m).not.toHaveBeenCalled();
    }
    expect(JSON.stringify(existing)).toBe(snapshot);
    // A seat decrease is refused the same way, at the preview already.
    expect(await codeOf(() => previewSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, d, NOW))).toBe("change_scheduled");
    expect(d.updateSubscriptionSchedule).not.toHaveBeenCalled();
  });

  it("refuses a subscription whose discounts or tax settings a scheduled phase would drop, before any Stripe write", async () => {
    for (const terms of [{ discounts: ["di_test_1"] }, { discount: { id: "di_test_2" } }, { default_tax_rates: ["txr_test_1"] }, { automatic_tax: { enabled: true } }, { collection_method: "send_invoice" }]) {
      const d = deps(withTerms(subscription({ seats: 4, premium: 4 }), terms));
      expect(await codeOf(() => scheduleRemovePremium(TEAM, d)), JSON.stringify(terms)).toBe("unsupported_billing_terms");
      expect(d.createSubscriptionSchedule).not.toHaveBeenCalled();
    }
  });

  it("a new schedule that does not mirror the subscription is released at once and nothing changes", async () => {
    // Stripe created it (the create response is the schedule as created) with a phase that does not end at the period end.
    const odd = { id: "sub_sched_test_1", phases: [{ start_date: PERIOD_START_S, end_date: END_S + 86400, items: [{ price: "price_test_team_m", quantity: 4 }] }] };
    const d = deps(subscription({ seats: 4, premium: 4 }), {
      createSubscriptionSchedule: vi.fn<AddonDeps["createSubscriptionSchedule"]>(async () => structuredClone(odd)),
      retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async () => structuredClone(odd)),
    });
    expect(await codeOf(() => scheduleRemovePremium(TEAM, d))).toBe("change_scheduled");
    expect(d.retrieveSubscriptionSchedule).not.toHaveBeenCalled();
    // The release key is the attempt's own (scope, subscription, period end, attempt nonce).
    expect(d.releaseSubscriptionSchedule).toHaveBeenCalledWith("sub_sched_test_1", expect.stringMatching(/^premium-remove:sub_test_team:\d+:[0-9a-f]{12}:release$/));
    expect(d.updateSubscriptionSchedule).not.toHaveBeenCalled();
    expect(await d.readScheduleRef(TEAM)).toBeNull();
  });

  it("a subscription already set to cancel at period end needs no schedule: Premium ends with it", async () => {
    const d = deps(subscription({ premium: 3, cancelAtPeriodEnd: true }));
    const { removeAt } = await scheduleRemovePremium(TEAM, d);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(d.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(d.updateSubscriptionSchedule).not.toHaveBeenCalled();
  });

  it("refuses when there is nothing to remove", async () => {
    await expect(scheduleRemovePremium(TEAM, deps(subscription()))).rejects.toMatchObject({ code: "not_added" });
  });
});

// ---- Schedule setup cut short: release only the app's own, resume on retry, never touch anyone else's -------------

type Phase = { start_date: number; end_date: number | null; items: { price: string; quantity: number }[]; [setting: string]: unknown };
type Sched = { id: string; phases: Phase[]; [term: string]: unknown };

/** Phase settings nobody set, as Stripe shows them. */
const PHASE_DEFAULTS = { discounts: [], default_tax_rates: [], collection_method: null, metadata: {} };

/**
 * A small stand-in for Stripe's schedules on one subscription: create attaches a schedule (at most one per
 * subscription) and answers with the whole schedule as created, replaying that same answer for the same idempotency key;
 * update replaces the phases (settings not sent reset to unset) and end_behavior; release detaches. The clock is the
 * world's own, so a test decides when a lease runs out. No network.
 */
function scheduleWorld(o: SubOpts, foreign: Sched | null = null) {
  const sub = subscription(o);
  let attached: Sched | null = foreign;
  let n = 0;
  let clock = Date.parse("2026-11-05T15:00:00Z");
  const byKey = new Map<string, Sched>();
  const d = deps(sub, {
    retrieveSubscription: vi.fn<AddonDeps["retrieveSubscription"]>(async () => ({ ...sub, schedule: attached?.id ?? null })),
    createSubscriptionSchedule: vi.fn<AddonDeps["createSubscriptionSchedule"]>(async (_p, key) => {
      const replay = byKey.get(key);
      if (replay) return structuredClone(replay);
      if (attached) throw new StripeApiError(400);
      const id = `sub_sched_test_new_${++n}`;
      const created: Sched = {
        id, object: "subscription_schedule", status: "active", end_behavior: "release", subscription: sub.id, metadata: {},
        default_settings: { collection_method: "charge_automatically", default_tax_rates: [] },
        phases: [{ start_date: PERIOD_START_S, end_date: END_S, items: sub.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity })), ...PHASE_DEFAULTS, proration_behavior: "create_prorations" }],
      };
      attached = structuredClone(created);
      byKey.set(key, structuredClone(created));
      return created;
    }),
    retrieveSubscriptionSchedule: vi.fn<AddonDeps["retrieveSubscriptionSchedule"]>(async (id) => {
      const cur = attached;
      if (cur?.id !== id) throw new StripeApiError(404);
      return structuredClone(cur);
    }),
    updateSubscriptionSchedule: vi.fn<AddonDeps["updateSubscriptionSchedule"]>(async (id, params) => {
      const cur = attached;
      if (cur?.id !== id) throw new StripeApiError(400);
      const p = params as unknown as { end_behavior: string; phases: { items: Phase["items"]; start_date?: number; proration_behavior: string }[] };
      const [first, second] = p.phases;
      cur.end_behavior = p.end_behavior;
      cur.phases = [
        { start_date: first.start_date ?? PERIOD_START_S, end_date: END_S, items: first.items, ...PHASE_DEFAULTS, proration_behavior: first.proration_behavior },
        { start_date: END_S, end_date: END_S + 30 * 86400, items: second.items, ...PHASE_DEFAULTS, proration_behavior: second.proration_behavior },
      ];
      return structuredClone(cur);
    }),
    releaseSubscriptionSchedule: vi.fn<AddonDeps["releaseSubscriptionSchedule"]>(async (id) => {
      if (attached?.id !== id) throw new StripeApiError(400);
      attached = null;
      return {};
    }),
    now: vi.fn<AddonDeps["now"]>(() => clock),
  });
  return {
    d,
    schedule: () => attached,
    /** Someone edits the attached schedule in the Dashboard. */
    edit: (fn: (s: Sched) => void) => { if (attached) fn(attached); },
    tick: (ms: number) => { clock += ms; },
  };
}

/** A promise the test resolves by hand, to hold one request mid-flight while another runs. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const refOf = async (d: MockDeps) => {
  const raw = await d.readScheduleRef(TEAM);
  return raw ? (JSON.parse(raw) as { sub: string; key: string; id: string | null }) : null;
};
const WITHOUT_PREMIUM = [{ price: "price_test_team_m", quantity: 4 }];

describe("a schedule setup cut short never blocks the retry", () => {
  it("retrieval fails right after create (a Stripe error, or a body that does not parse): the new schedule is released and the retry succeeds", async () => {
    for (const failure of ["stripe error", "unparseable"] as const) {
      const w = scheduleWorld({ seats: 4, premium: 4 });
      if (failure === "stripe error") w.d.retrieveSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
      else w.d.retrieveSubscriptionSchedule.mockResolvedValueOnce({ unexpected: true });
      const err = await scheduleRemovePremium(TEAM, w.d).catch((e: AddonError) => e);
      expect(err, failure).toMatchObject({ code: "schedule_setup_failed" });
      expect((err as AddonError).message).toMatch(/nothing was changed/);
      expect(w.d.releaseSubscriptionSchedule).toHaveBeenCalledWith("sub_sched_test_new_1", expect.stringMatching(/^premium-remove:sub_test_team:\d+:[0-9a-f]{12}:release$/));
      expect(w.d.updateSubscriptionSchedule).not.toHaveBeenCalled();
      expect(w.schedule()).toBeNull();
      expect(await refOf(w.d)).toBeNull();
      // The retry is not blocked by a leftover: it makes a new schedule and finishes.
      const { removeAt } = await scheduleRemovePremium(TEAM, w.d);
      expect(removeAt?.getTime()).toBe(END_S * 1000);
      expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
      expect(await refOf(w.d)).toBeNull();
      // Each attempt has its own create key, so the retry is never answered with the released schedule.
      const keys = w.d.createSubscriptionSchedule.mock.calls.map((c) => c[1]);
      expect(new Set(keys).size).toBe(2);
    }
  });

  it("an update Stripe rejects (4xx): the new schedule is released; the same seat decrease confirmed again schedules", async () => {
    const w = scheduleWorld({ seats: 6, premium: 6 });
    const p = await previewSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, w.d, NOW);
    w.d.updateSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(400));
    expect(await codeOf(() => confirmSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, p.token, w.d, NOW))).toBe("schedule_setup_failed");
    expect(w.schedule()).toBeNull();
    expect(await refOf(w.d)).toBeNull();
    const done = await confirmSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, p.token, w.d, NOW);
    expect(done.effectiveAt?.getTime()).toBe(END_S * 1000);
    expect(w.schedule()?.phases[1].items).toEqual([{ price: "price_test_team_m", quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }]);
    expect(w.d.createSubscriptionSchedule).toHaveBeenCalledTimes(2);
  });

  it("an update with no clear answer that DID land is kept as a success: nothing is released", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const real = w.d.updateSubscriptionSchedule.getMockImplementation()!;
    w.d.updateSubscriptionSchedule.mockImplementationOnce(async (...a) => { await real(...a); throw new StripeApiError(502); });
    const { removeAt } = await scheduleRemovePremium(TEAM, w.d);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(w.d.releaseSubscriptionSchedule).not.toHaveBeenCalled();
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
    expect(await refOf(w.d)).toBeNull();
  });

  it("an update with no clear answer that did NOT land is released after a fresh read; the retry succeeds", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    w.d.updateSubscriptionSchedule.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("schedule_setup_failed");
    expect(w.d.retrieveSubscriptionSchedule).toHaveBeenCalledTimes(2);
    expect(w.schedule()).toBeNull();
    await scheduleRemovePremium(TEAM, w.d);
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
  });

  it("a release that fails leaves the app's own schedule marked; the next attempt resumes it instead of being refused", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    w.d.retrieveSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    w.d.releaseSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    expect(w.schedule()?.id).toBe("sub_sched_test_new_1");
    expect(await refOf(w.d)).toMatchObject({ sub: "sub_test_team", id: "sub_sched_test_new_1" });
    // A seat decrease preview is not refused by the app's own leftover either.
    expect(await previewSeatChange({ ...TEAM, seats: 4 }, "owner-1", 3, w.d, NOW)).toMatchObject({ direction: "down", dueNow: 0 });
    // The retry resumes the same schedule: no second create, the update lands, the marker clears.
    await scheduleRemovePremium(TEAM, w.d);
    expect(w.d.createSubscriptionSchedule).toHaveBeenCalledTimes(1);
    expect(w.schedule()).toMatchObject({ id: "sub_sched_test_new_1" });
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
    expect(await refOf(w.d)).toBeNull();
    // Finished, it is an ordinary scheduled change: a further attempt is refused and does not touch it.
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_scheduled");
    expect(w.d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
  });

  it("an update whose answer is lost and whose re-read fails stays marked; the retry finds it applied and sends no second update", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realUpdate = w.d.updateSubscriptionSchedule.getMockImplementation()!;
    const realRetrieve = w.d.retrieveSubscriptionSchedule.getMockImplementation()!;
    w.d.updateSubscriptionSchedule.mockImplementationOnce(async (...a) => { await realUpdate(...a); throw new StripeApiError(500); });
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(realRetrieve).mockRejectedValueOnce(new StripeApiError(500));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    // Not released: the change may well have gone through, and it did.
    expect(w.d.releaseSubscriptionSchedule).not.toHaveBeenCalled();
    expect(w.schedule()?.phases).toHaveLength(2);
    const { removeAt } = await scheduleRemovePremium(TEAM, w.d);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(w.d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
    expect(w.d.releaseSubscriptionSchedule).not.toHaveBeenCalled();
    expect(await refOf(w.d)).toBeNull();
  });

  it("a create whose answer is lost: the retry replays that exact create to learn the id, then finishes on it", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realCreate = w.d.createSubscriptionSchedule.getMockImplementation()!;
    w.d.createSubscriptionSchedule.mockImplementationOnce(async (...a) => { await realCreate(...a); throw new TypeError("fetch failed"); });
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    expect(w.schedule()?.id).toBe("sub_sched_test_new_1");
    expect(await refOf(w.d)).toMatchObject({ id: null });
    await scheduleRemovePremium(TEAM, w.d);
    const keys = w.d.createSubscriptionSchedule.mock.calls.map((c) => c[1]);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(w.schedule()).toMatchObject({ id: "sub_sched_test_new_1" });
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
    expect(await refOf(w.d)).toBeNull();
  });

  it("never touches anyone else's schedule, whatever marker is left over", async () => {
    const other = (): { id: string; phases: Phase[] } => ({ id: "sub_sched_test_other", phases: [
      { start_date: PERIOD_START_S, end_date: END_S, items: [{ price: "price_test_team_m", quantity: 4 }, { price: "price_test_prem_m", quantity: 4 }] },
      { start_date: END_S, end_date: END_S + 30 * 86400, items: [{ price: "price_test_team_m", quantity: 3 }] },
    ] });
    const markers = [
      // A marker naming a different schedule of the app's (long gone).
      { sub: "sub_test_team", key: "premium-remove:sub_test_team:1:aaaaaaaaaaaa", id: "sub_sched_test_mine" },
      // A marker for another subscription.
      { sub: "sub_test_old", key: "premium-remove:sub_test_old:1:bbbbbbbbbbbb", id: "sub_sched_test_other" },
    ];
    for (const marker of markers) {
      const w = scheduleWorld({ seats: 4, premium: 4 }, other());
      await w.d.swapScheduleRef(TEAM, null, JSON.stringify(marker));
      expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d)), marker.sub).toBe("change_scheduled");
      expect(await codeOf(() => previewSeatChange({ ...TEAM, seats: 4 }, "owner-1", 3, w.d, NOW)), marker.sub).toBe("change_scheduled");
      for (const m of [w.d.createSubscriptionSchedule, w.d.retrieveSubscriptionSchedule, w.d.updateSubscriptionSchedule, w.d.releaseSubscriptionSchedule]) expect(m).not.toHaveBeenCalled();
      expect(w.schedule()).toEqual(other());
    }

    // A marker whose create never reported an id, with someone else's schedule attached: the exact replay of the app's
    // create is refused by Stripe (the subscription already has a schedule), so the schedule is not the app's.
    const w = scheduleWorld({ seats: 4, premium: 4 }, other());
    await w.d.swapScheduleRef(TEAM, null, JSON.stringify({ sub: "sub_test_team", key: "premium-remove:sub_test_team:1:cccccccccccc", id: null }));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_scheduled");
    for (const m of [w.d.retrieveSubscriptionSchedule, w.d.updateSubscriptionSchedule, w.d.releaseSubscriptionSchedule]) expect(m).not.toHaveBeenCalled();
    expect(w.schedule()).toEqual(other());
    expect(await refOf(w.d)).toBeNull();

    // The app's own marked schedule that someone has since edited (not as created, not this change): left as it is.
    const edited = scheduleWorld({ seats: 4, premium: 4 }, other());
    await edited.d.swapScheduleRef(TEAM, null, JSON.stringify({ sub: "sub_test_team", key: "premium-remove:sub_test_team:1:dddddddddddd", id: "sub_sched_test_other" }));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, edited.d))).toBe("change_scheduled");
    for (const m of [edited.d.updateSubscriptionSchedule, edited.d.releaseSubscriptionSchedule, edited.d.createSubscriptionSchedule]) expect(m).not.toHaveBeenCalled();
    expect(edited.schedule()).toEqual(other());
    expect(await refOf(edited.d)).toBeNull();
  });

  it("the stored original is the exact create response (canonical JSON, nothing parsed away)", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    w.d.retrieveSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    w.d.releaseSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    await codeOf(() => scheduleRemovePremium(TEAM, w.d));
    const ref = JSON.parse((await w.d.readScheduleRef(TEAM))!) as { orig: string; op: string | null; lease: number };
    expect(ref.orig).toBe(canonicalJson(w.schedule()));
    expect(JSON.parse(ref.orig)).toMatchObject({ end_behavior: "release", default_settings: { collection_method: "charge_automatically" } });
    // Parked: nobody holds it, so the next attempt may take it at once.
    expect(ref).toMatchObject({ op: null, lease: 0 });
  });

  it("the billing routes map a released setup to 502 schedule_setup_failed and an unfinished one to 409 change_pending", async () => {
    const { addonFailure } = await import("@/app/api/billing/_lib/addonRoute");
    const failed = addonFailure(new AddonError("schedule_setup_failed", "x"), "test");
    const pending = addonFailure(new AddonError("change_pending", "y"), "test");
    expect([failed.status, pending.status]).toEqual([502, 409]);
    expect(await failed.json()).toEqual({ error: "schedule_setup_failed", message: "x" });
  });
});

// ---- Overlapping attempts: one owner at a time, and a lost owner never mutates -------------------------------------

describe("overlapping schedule attempts (controlled A/B interleaving)", () => {
  const counts = (w: ReturnType<typeof scheduleWorld>) => ({
    create: w.d.createSubscriptionSchedule.mock.calls.length,
    update: w.d.updateSubscriptionSchedule.mock.calls.length,
    release: w.d.releaseSubscriptionSchedule.mock.calls.length,
  });

  it("B arrives while A holds the setup: B is refused and touches nothing; A then finishes", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realRetrieve = w.d.retrieveSubscriptionSchedule.getMockImplementation()!;
    const reached = deferred();
    const gate = deferred();
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(async (id) => { reached.resolve(); await gate.promise; return realRetrieve(id); });
    const a = scheduleRemovePremium(TEAM, w.d);
    await reached.promise; // A created the schedule and is reading it
    const before = counts(w);
    const marker = await w.d.readScheduleRef(TEAM);
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    expect(counts(w)).toEqual(before);
    expect(await w.d.readScheduleRef(TEAM)).toBe(marker); // B did not even write the marker
    gate.resolve();
    expect((await a).removeAt?.getTime()).toBe(END_S * 1000);
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
    expect(counts(w)).toEqual({ create: 1, update: 1, release: 0 });
  });

  it("Codex P1: A stalls past its lease, B takes over and completes, then A's read fails: A cannot release B's change", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const reached = deferred();
    const gate = deferred();
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; throw new StripeApiError(500); });
    const a = scheduleRemovePremium(TEAM, w.d).then(() => null, (e: AddonError) => e);
    await reached.promise;
    w.tick(SCHEDULE_LEASE_MS + 1);
    // B resumes A's schedule (it is still exactly as created), applies the change and clears the marker.
    const b = await scheduleRemovePremium(TEAM, w.d);
    expect(b.removeAt?.getTime()).toBe(END_S * 1000);
    expect(await refOf(w.d)).toBeNull();
    // A wakes up with its "fresh" schedule unreadable. Before releasing it re-checks ownership, finds it lost, and stops.
    gate.resolve();
    expect(await a).toMatchObject({ code: "change_pending" });
    expect(counts(w)).toEqual({ create: 1, update: 1, release: 0 });
    expect(w.schedule()?.phases).toHaveLength(2);
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
    expect(await refOf(w.d)).toBeNull();
  });

  it("A stalls between its read and its update past the lease, B completes: A sends no update", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realRetrieve = w.d.retrieveSubscriptionSchedule.getMockImplementation()!;
    const reached = deferred();
    const gate = deferred();
    // A reads the schedule while it is still as created, then is held before it can update.
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(async (id) => { const snap = await realRetrieve(id); reached.resolve(); await gate.promise; return snap; });
    const a = scheduleRemovePremium(TEAM, w.d).then(() => null, (e: AddonError) => e);
    await reached.promise;
    w.tick(SCHEDULE_LEASE_MS + 1);
    await scheduleRemovePremium(TEAM, w.d);
    const afterB = structuredClone(w.schedule());
    gate.resolve();
    expect(await a).toMatchObject({ code: "change_pending" });
    expect(counts(w)).toEqual({ create: 1, update: 1, release: 0 });
    expect(w.schedule()).toEqual(afterB);
  });

  it("a lost owner's cleanup after an unclear update cannot release what the new owner completed", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const reached = deferred();
    const gate = deferred();
    // A's update never reaches Stripe and its answer is held.
    w.d.updateSubscriptionSchedule.mockImplementationOnce(async () => { reached.resolve(); await gate.promise; throw new TypeError("fetch failed"); });
    const a = scheduleRemovePremium(TEAM, w.d).then(() => null, (e: AddonError) => e);
    await reached.promise;
    w.tick(SCHEDULE_LEASE_MS + 1);
    await scheduleRemovePremium(TEAM, w.d); // B applies the change
    gate.resolve();
    // A's re-read would find it applied; but it must re-check ownership first, and it has lost it.
    expect(await a).toMatchObject({ code: "change_pending" });
    expect(counts(w)).toEqual({ create: 1, update: 2, release: 0 });
    expect(w.schedule()?.phases[1].items).toEqual(WITHOUT_PREMIUM);
  });
});

// ---- External edits on the app's unfinished schedule: detected and left untouched ----------------------------------

describe("external edits are left untouched (same phase count and dates)", () => {
  /** A parked, unfinished app schedule still exactly as created: its read failed and its release failed. */
  async function parkedPristine() {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    w.d.retrieveSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    w.d.releaseSubscriptionSchedule.mockRejectedValueOnce(new StripeApiError(500));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    return w;
  }
  /** A parked app schedule that already carries this change: the update landed but its answer and the re-read were lost. */
  async function parkedApplied() {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realUpdate = w.d.updateSubscriptionSchedule.getMockImplementation()!;
    const realRetrieve = w.d.retrieveSubscriptionSchedule.getMockImplementation()!;
    w.d.updateSubscriptionSchedule.mockImplementationOnce(async (...a) => { await realUpdate(...a); throw new StripeApiError(500); });
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(realRetrieve).mockRejectedValueOnce(new StripeApiError(500));
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d))).toBe("change_pending");
    expect(w.schedule()?.phases).toHaveLength(2);
    return w;
  }
  const expectUntouched = async (w: ReturnType<typeof scheduleWorld>, label: string) => {
    const snapshot = structuredClone(w.schedule());
    const updates = w.d.updateSubscriptionSchedule.mock.calls.length;
    const releases = w.d.releaseSubscriptionSchedule.mock.calls.length;
    const err = await scheduleRemovePremium(TEAM, w.d).catch((e: AddonError) => e);
    expect(err, label).toMatchObject({ code: "change_scheduled" });
    expect((err as AddonError).message, label).toMatch(/changed outside the app, so it was left exactly as it is/);
    expect(w.d.updateSubscriptionSchedule.mock.calls.length, label).toBe(updates);
    expect(w.d.releaseSubscriptionSchedule.mock.calls.length, label).toBe(releases);
    expect(w.schedule(), label).toEqual(snapshot);
    // No longer the app's to finish: the marker is cleared, and later attempts refuse it like anyone else's.
    expect(await refOf(w.d), label).toBeNull();
    expect(await codeOf(() => scheduleRemovePremium(TEAM, w.d)), label).toBe("change_scheduled");
    expect(w.schedule(), label).toEqual(snapshot);
  };

  const ONE_PHASE_EDITS: [string, (s: Sched) => void][] = [
    ["phase discount", (s) => { s.phases[0].discounts = [{ coupon: "co_test_1" }]; }],
    ["phase tax rate", (s) => { s.phases[0].default_tax_rates = ["txr_test_1"]; }],
    ["phase collection method", (s) => { s.phases[0].collection_method = "send_invoice"; }],
    ["phase metadata", (s) => { s.phases[0].metadata = { note: "edited" }; }],
    ["item tax rate", (s) => { (s.phases[0].items[0] as Record<string, unknown>).tax_rates = ["txr_test_2"]; }],
    ["end_behavior", (s) => { s.end_behavior = "cancel"; }],
    ["default settings", (s) => { s.default_settings = { collection_method: "send_invoice", default_tax_rates: [] }; }],
    ["schedule metadata", (s) => { s.metadata = { owner: "someone else" }; }],
  ];

  it.each(ONE_PHASE_EDITS)("unfinished, still one phase with the same dates, edited: %s", async (label, edit) => {
    const w = await parkedPristine();
    w.edit(edit);
    expect(w.schedule()?.phases).toHaveLength(1);
    expect(w.schedule()?.phases[0].end_date).toBe(END_S);
    await expectUntouched(w, label);
  });

  const TWO_PHASE_EDITS: [string, (s: Sched) => void][] = [
    ["next phase discount", (s) => { s.phases[1].discounts = [{ coupon: "co_test_1" }]; }],
    ["next phase tax rate", (s) => { s.phases[1].default_tax_rates = ["txr_test_1"]; }],
    ["current phase collection method", (s) => { s.phases[0].collection_method = "send_invoice"; }],
    ["end_behavior", (s) => { s.end_behavior = "cancel"; }],
    ["schedule metadata", (s) => { s.metadata = { owner: "someone else" }; }],
  ];

  it.each(TWO_PHASE_EDITS)("change applied, then edited with the same phases and dates: %s", async (label, edit) => {
    const w = await parkedApplied();
    w.edit(edit);
    await expectUntouched(w, label);
  });

  it("an unedited applied schedule is still recognised as done (the control case)", async () => {
    const w = await parkedApplied();
    const { removeAt } = await scheduleRemovePremium(TEAM, w.d);
    expect(removeAt?.getTime()).toBe(END_S * 1000);
    expect(w.d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
  });

  it("edited between the app's create and its first read: not updated, not released", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realRetrieve = w.d.retrieveSubscriptionSchedule.getMockImplementation()!;
    w.d.retrieveSubscriptionSchedule.mockImplementationOnce(async (id) => { w.edit((s) => { s.phases[0].discounts = [{ coupon: "co_test_1" }]; }); return realRetrieve(id); });
    const err = await scheduleRemovePremium(TEAM, w.d).catch((e: AddonError) => e);
    expect(err).toMatchObject({ code: "change_scheduled" });
    expect(w.d.updateSubscriptionSchedule).not.toHaveBeenCalled();
    expect(w.d.releaseSubscriptionSchedule).not.toHaveBeenCalled();
    expect(w.schedule()?.phases[0].discounts).toEqual([{ coupon: "co_test_1" }]);
  });

  it("edited between the app's unclear update and its re-read: not released", async () => {
    const w = scheduleWorld({ seats: 4, premium: 4 });
    const realUpdate = w.d.updateSubscriptionSchedule.getMockImplementation()!;
    w.d.updateSubscriptionSchedule.mockImplementationOnce(async (...a) => {
      await realUpdate(...a);
      w.edit((s) => { s.phases[1].default_tax_rates = ["txr_test_1"]; });
      throw new StripeApiError(502);
    });
    const err = await scheduleRemovePremium(TEAM, w.d).catch((e: AddonError) => e);
    expect(err).toMatchObject({ code: "change_scheduled" });
    expect(w.d.releaseSubscriptionSchedule).not.toHaveBeenCalled();
    expect(w.d.updateSubscriptionSchedule).toHaveBeenCalledTimes(1);
    expect(w.schedule()?.phases[1].default_tax_rates).toEqual(["txr_test_1"]);
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

  it("seats up: the confirm re-previews at the same proration date and refuses a changed charge or changed terms", async () => {
    const sub = subscription({ seats: 4, premium: 4 });
    const d = deps(sub);
    const p = await previewSeatChange({ ...TEAM, seats: 4 }, "owner-1", 6, d, NOW);
    d.previewInvoice.mockResolvedValueOnce({ amount_due: 9999, currency: "usd" });
    expect(await codeOf(() => confirmSeatChange({ ...TEAM, seats: 4 }, "owner-1", 6, p.token, d, NOW))).toBe("price_changed");
    expect(d.previewInvoice.mock.calls[1][0]).toEqual(d.previewInvoice.mock.calls[0][0]);
    const discounted = deps(withTerms(sub, { discounts: ["di_test_1"] }));
    expect(await codeOf(() => confirmSeatChange({ ...TEAM, seats: 4 }, "owner-1", 6, p.token, discounted, NOW))).toBe("subscription_changed");
    expect(d.updateSubscription).not.toHaveBeenCalled();
    expect(discounted.updateSubscription).not.toHaveBeenCalled();
  });

  it("seats down: the confirm refuses changed terms (a new unit price) before any schedule is made", async () => {
    const sub = subscription({ seats: 6, premium: 6 });
    const p = await previewSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, deps(sub), NOW);
    const repriced = deps(withTerms(sub, { items: { data: sub.items.data.map((i) => ({ ...i, price: { ...i.price, unit_amount: (i.price.unit_amount ?? 0) + 100 } })) } }));
    expect(await codeOf(() => confirmSeatChange({ ...TEAM, seats: 6 }, "owner-1", 4, p.token, repriced, NOW))).toBe("subscription_changed");
    expect(repriced.createSubscriptionSchedule).not.toHaveBeenCalled();
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
    // Create answers with the whole schedule as created, and an unedited read returns exactly the same object.
    const asCreated = () => ({ id: "sub_sched_test_1", phases: [{ start_date: PERIOD_START_S, end_date: END_S, items: live.items.data.map((i) => ({ price: i.price.id, quantity: i.quantity })) }] });
    vi.spyOn(stripeApi, "createSubscriptionSchedule").mockImplementation(async () => asCreated());
    vi.spyOn(stripeApi, "retrieveSubscriptionSchedule").mockImplementation(async () => asCreated());
    vi.spyOn(stripeApi, "updateSubscriptionSchedule").mockResolvedValue({});
    vi.spyOn(stripeApi, "releaseSubscriptionSchedule").mockResolvedValue({});
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

  it("remove on a subscription with an existing schedule answers 409 with a clear message and writes nothing", async () => {
    live = { ...subscription({ seats: 4, premium: 4 }), schedule: "sub_sched_test_other" };
    Object.assign(fake.rows("organization")[0], { premiumVoice: true, premiumVoiceQuantity: 4 });
    const res = await premium({ action: "remove" });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: "change_scheduled" });
    expect(body.message).toMatch(/Manage billing or contact support/);
    expect(stripeApi.createSubscriptionSchedule).not.toHaveBeenCalled();
    expect(stripeApi.updateSubscriptionSchedule).not.toHaveBeenCalled();
    expect(fake.rows("organization")[0].premiumVoiceRemoveAt).toBeNull();
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
