import { createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "owner-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));

import { buildCheckoutParams, CheckoutConfigError, entitlementFromItems, LOOKUP_KEYS, resetPriceCache, resolvePriceIds, type PriceIds } from "@/lib/billing";
import { isTeamPlan } from "@/lib/usagePlan";
import { billingGate, encodeForm, stripeApi, StripeApiError, stripeSecretKey, stripeStatus, StripeConfigError, verifyWebhookSignature } from "@/lib/stripe";
import { classifyPlanChange, setBillingEventSink, type BillingLifecycleEvent } from "@/lib/billingEvents";
import { POST as webhook } from "@/app/api/stripe/webhook/route";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";

// Placeholder ids, not real Stripe objects.
const PRICES: PriceIds = {
  pro: { month: "price_test_pro_m", year: "price_test_pro_y" },
  team: { month: "price_test_team_m", year: "price_test_team_y" },
  premium: { month: "price_test_prem_m", year: "price_test_prem_y" },
};
// What stripe.prices.list({ lookup_keys }) returns in these tests: no network, placeholder ids.
const priceRow = (key: string, id: string, extra: Record<string, unknown> = {}) => ({ id, lookup_key: key, active: true, type: "recurring", recurring: { usage_type: "licensed" }, ...extra });
const PRICE_LIST = {
  data: [
    priceRow(LOOKUP_KEYS.pro.month, PRICES.pro.month!, { product: { metadata: { plan: "pro" } } }),
    priceRow(LOOKUP_KEYS.pro.year, PRICES.pro.year!, { product: { metadata: { plan: "pro" } } }),
    priceRow(LOOKUP_KEYS.team.month, PRICES.team.month!, { product: { metadata: { plan: "team", min_seats: "3", pooled_minutes_per_seat: "300" } } }),
    priceRow(LOOKUP_KEYS.team.year, PRICES.team.year!, { product: { metadata: { plan: "team" } } }),
    priceRow(LOOKUP_KEYS.premium.month, PRICES.premium.month!),
    priceRow(LOOKUP_KEYS.premium.year, PRICES.premium.year!),
  ],
};
const WHSEC = "whsec_test_placeholder";
const NOW = new Date("2026-10-31T10:00:00Z");
const ANCHOR = new Date("2026-03-10T09:30:00Z");

let fake: ReturnType<typeof createFakePrisma>;
const user = () => fake.rows("user").find((u) => u.id === "owner-1")!;
const org = () => fake.rows("organization").find((o) => o.id === "org-1")!;
const allowance = (key: "userId" | "organizationId", id: string) => fake.rows("usageAllowance").find((a) => a[key] === id);

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "owner-1";
  fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-02-20T00:00:00Z") });
  fake.seed("user", { id: "owner-1", email: "owner-1@example.test", organizationId: "org-1", role: "owner", usageAnchorAt: ANCHOR });
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  resetPriceCache();
  vi.spyOn(stripeApi, "listPricesByLookupKeys").mockResolvedValue(PRICE_LIST);
  setBillingEventSink(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBillingEventSink(null);
});

describe("test-mode only", () => {
  it("accepts only sk_test_ keys", () => {
    expect(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("ready");
    expect(stripeStatus({ STRIPE_SECRET_KEY: "sk_live_abc" })).toBe("live_key_refused");
    expect(stripeStatus({ STRIPE_SECRET_KEY: "rk_live_abc" })).toBe("live_key_refused");
    expect(stripeStatus({ STRIPE_SECRET_KEY: "rk_test_abc" })).toBe("live_key_refused");
  });

  it("is off with no key and in demo mode, even with a good key", () => {
    expect(stripeStatus({})).toBe("disabled");
    expect(stripeStatus({ STRIPE_SECRET_KEY: "  " })).toBe("disabled");
    expect(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_abc", DEMO_MODE: "true" })).toBe("disabled");
  });

  it("refuses every Stripe call with a clear error when the key looks live, and never sends it", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder");
    const sent = vi.fn();
    vi.stubGlobal("fetch", sent);
    expect(() => stripeSecretKey()).toThrow(StripeConfigError);
    await expect(stripeApi.createCheckoutSession({ mode: "subscription" })).rejects.toMatchObject({ code: "stripe_live_key_refused" });
    await expect(stripeApi.createPortalSession({ customer: "cus_test" })).rejects.toMatchObject({ code: "stripe_live_key_refused" });
    expect(sent).not.toHaveBeenCalled();

    const gate = billingGate();
    expect(gate?.status).toBe(503);
    const body = await gate!.json();
    expect(body.error).toBe("stripe_live_key_refused");
    expect(body.message).toContain("sk_test_");
    expect(JSON.stringify(body)).not.toContain("sk_live_placeholder");
  });

  it("checkout, portal and webhook routes all refuse a live key before doing anything", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder");
    const spy = vi.spyOn(stripeApi, "createCheckoutSession");
    const req = (path: string, body: unknown) => new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect((await checkout(req("/api/billing/checkout", { plan: "pro", interval: "month" }))).status).toBe(503);
    expect((await portal(req("/api/billing/portal", {}))).status).toBe(503);
    expect((await webhook(req("/api/stripe/webhook", {}))).status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });

  it("is a no-op in demo mode: routes answer billing_not_configured", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await checkout(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", interval: "month" }), headers: { "content-type": "application/json" } }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("billing_not_configured");
  });

  it("sends the key only as a bearer header, form-encoded, and never surfaces Stripe's error body", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ error: { message: "secret detail" } }), { status: 400 }));
    vi.stubGlobal("fetch", sent);
    await expect(stripeApi.createCheckoutSession({ mode: "subscription", line_items: [{ price: "price_x", quantity: 3 }] })).rejects.toMatchObject({ status: 400 });
    const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_placeholder");
    expect(init.body).toBe("mode=subscription&line_items%5B0%5D%5Bprice%5D=price_x&line_items%5B0%5D%5Bquantity%5D=3");
  });

  it("encodes nested params the way Stripe expects", () => {
    expect(encodeForm({ a: { b: [{ c: 1 }] }, skip: undefined, flag: true }).map(decodeURIComponent)).toEqual(["a[b][0][c]=1", "flag=true"]);
  });
});

describe("checkout params per plan", () => {
  const base = { userId: "owner-1", email: "owner-1@example.test", anchorAt: ANCHOR, baseUrl: "http://localhost:3000", now: NOW, premium: false, seats: 1, interval: "month" as const };
  const items = (p: ReturnType<typeof buildCheckoutParams>) => p.line_items as { price: string; quantity: number }[];

  it("Pro: one seat at the Pro price, monthly or annual", () => {
    expect(items(buildCheckoutParams({ ...base, plan: "pro" }, PRICES))).toEqual([{ price: "price_test_pro_m", quantity: 1 }]);
    expect(items(buildCheckoutParams({ ...base, plan: "pro", interval: "year", seats: 9 }, PRICES))).toEqual([{ price: "price_test_pro_y", quantity: 1 }]);
  });

  it("Team: quantity is the seat count and the minimum is 3", () => {
    expect(items(buildCheckoutParams({ ...base, plan: "team", seats: 3 }, PRICES))).toEqual([{ price: "price_test_team_m", quantity: 3 }]);
    expect(items(buildCheckoutParams({ ...base, plan: "team", seats: 12, interval: "year" }, PRICES))).toEqual([{ price: "price_test_team_y", quantity: 12 }]);
    expect(() => buildCheckoutParams({ ...base, plan: "team", seats: 2 }, PRICES)).toThrow(CheckoutConfigError);
    expect(() => buildCheckoutParams({ ...base, plan: "team", seats: 0 }, PRICES)).toThrow(/between 3/);
  });

  it("Premium add-on: quantity equals seats, on the same billing period", () => {
    expect(items(buildCheckoutParams({ ...base, plan: "team", seats: 5, premium: true }, PRICES))).toEqual([
      { price: "price_test_team_m", quantity: 5 },
      { price: "price_test_prem_m", quantity: 5 },
    ]);
    expect(items(buildCheckoutParams({ ...base, plan: "team", seats: 4, premium: true, interval: "year" }, PRICES))[1]).toEqual({ price: "price_test_prem_y", quantity: 4 });
    expect(items(buildCheckoutParams({ ...base, plan: "pro", premium: true }, PRICES))[1]).toEqual({ price: "price_test_prem_m", quantity: 1 });
  });

  it("is a flat licensed subscription: no metered prices, no overage items, no free-form amounts", () => {
    const p = buildCheckoutParams({ ...base, plan: "team", seats: 3, premium: true }, PRICES);
    expect(p.mode).toBe("subscription");
    for (const li of p.line_items as Record<string, unknown>[]) expect(Object.keys(li).sort()).toEqual(["price", "quantity"]);
    expect(JSON.stringify(p)).not.toMatch(/price_data|usage_type|metered|overage/);
  });

  it("anchors the Stripe billing day to the usage day when it is in the future", () => {
    const p = buildCheckoutParams({ ...base, plan: "pro" }, PRICES);
    const sub = p.subscription_data as Record<string, unknown>;
    expect(sub.billing_cycle_anchor).toBe(Math.floor(new Date("2026-11-10T09:30:00Z").getTime() / 1000));
    expect(sub.proration_behavior).toBe("create_prorations");
  });

  it("leaves the anchor out on the anchor day, where Stripe cannot take a past or present time", () => {
    const p = buildCheckoutParams({ ...base, plan: "pro", now: new Date("2026-10-10T15:00:00Z") }, PRICES);
    expect(p.subscription_data).not.toHaveProperty("billing_cycle_anchor");
  });

  it("uses the existing customer when there is one, else the email; carries ids in metadata", () => {
    const withCustomer = buildCheckoutParams({ ...base, plan: "pro", customerId: "cus_test_1" }, PRICES);
    expect(withCustomer.customer).toBe("cus_test_1");
    expect(withCustomer).not.toHaveProperty("customer_email");
    const fresh = buildCheckoutParams({ ...base, plan: "team", seats: 3, organizationId: "org-1", premium: true }, PRICES);
    expect(fresh.customer_email).toBe("owner-1@example.test");
    expect(fresh.metadata).toMatchObject({ plan: "team", seats: "3", premium: "true", userId: "owner-1", organizationId: "org-1" });
    expect((fresh.subscription_data as { metadata: unknown }).metadata).toEqual(fresh.metadata);
  });

  it("reports a missing price instead of sending an empty one", () => {
    expect(() => buildCheckoutParams({ ...base, plan: "pro" }, { ...PRICES, pro: { month: undefined, year: undefined } })).toThrow(/not set up/);
    expect(() => buildCheckoutParams({ ...base, plan: "pro", premium: true }, { ...PRICES, premium: { month: undefined, year: undefined } })).toThrow(CheckoutConfigError);
  });

  it("resolves the six prices by lookup key and caches the result", async () => {
    const list = vi.mocked(stripeApi.listPricesByLookupKeys);
    expect(await resolvePriceIds()).toEqual(PRICES);
    expect([...list.mock.calls[0][0]].sort()).toEqual(Object.values(LOOKUP_KEYS).flatMap((k) => Object.values(k)).sort());
    await resolvePriceIds();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("asks Stripe for prices by lookup key with the product expanded, never by price id", async () => {
    const sent = vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", sent);
    vi.mocked(stripeApi.listPricesByLookupKeys).mockRestore();
    await stripeApi.listPricesByLookupKeys(["calltrainer_pro_monthly"]);
    const [url, init] = sent.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("GET");
    expect(decodeURIComponent(url)).toBe("https://api.stripe.com/v1/prices?lookup_keys[0]=calltrainer_pro_monthly&active=true&limit=100&expand[0]=data.product");
  });

  it("leaves a price unresolved when it is inactive, metered, one-time or on the wrong product", async () => {
    vi.mocked(stripeApi.listPricesByLookupKeys).mockResolvedValue({
      data: [
        priceRow(LOOKUP_KEYS.pro.month, "price_test_x1", { active: false }),
        priceRow(LOOKUP_KEYS.pro.year, "price_test_x2", { recurring: { usage_type: "metered" } }),
        priceRow(LOOKUP_KEYS.team.month, "price_test_x3", { type: "one_time", recurring: null }),
        priceRow(LOOKUP_KEYS.team.year, "price_test_x4", { product: { metadata: { plan: "pro" } } }),
      ],
    });
    const none = { month: undefined, year: undefined };
    expect(await resolvePriceIds()).toEqual({ pro: none, team: none, premium: none });
  });

  it("a Pro or Team product with no plan metadata, or a different plan, is not resolved", async () => {
    const mk = (product: unknown) => ({
      data: [
        priceRow(LOOKUP_KEYS.pro.month, "price_test_pro_m", { product }),
        priceRow(LOOKUP_KEYS.pro.year, "price_test_pro_y", { product }),
        priceRow(LOOKUP_KEYS.team.month, "price_test_team_m", { product }),
        priceRow(LOOKUP_KEYS.team.year, "price_test_team_y", { product }),
      ],
    });
    const none = { month: undefined, year: undefined };
    for (const product of [undefined, null, "prod_not_expanded", { metadata: null }, { metadata: {} }, { metadata: { plan: "" } }, { metadata: { plan: "enterprise" } }, { metadata: { min_seats: "3" } }]) {
      resetPriceCache();
      vi.mocked(stripeApi.listPricesByLookupKeys).mockResolvedValue(mk(product));
      expect(await resolvePriceIds(), JSON.stringify(product)).toEqual({ pro: none, team: none, premium: none });
    }
    // Each key needs its own plan: a Team product behind a Pro key (and the reverse) is refused.
    resetPriceCache();
    vi.mocked(stripeApi.listPricesByLookupKeys).mockResolvedValue({
      data: [
        priceRow(LOOKUP_KEYS.pro.month, "price_test_pro_m", { product: { metadata: { plan: "team" } } }),
        priceRow(LOOKUP_KEYS.team.month, "price_test_team_m", { product: { metadata: { plan: "pro" } } }),
      ],
    });
    expect(await resolvePriceIds()).toEqual({ pro: none, team: none, premium: none });
  });

  it("Premium Voice is an add-on: it resolves without plan metadata and never sets a tier", async () => {
    expect((await resolvePriceIds()).premium).toEqual({ month: "price_test_prem_m", year: "price_test_prem_y" });
  });
});

describe("isTeamPlan", () => {
  it("is true only for planTier team", () => {
    expect(isTeamPlan({ planTier: "team" })).toBe(true);
    for (const t of ["free", "pro", "TEAM", "", null, undefined]) expect(isTeamPlan({ planTier: t })).toBe(false);
    expect(isTeamPlan(null)).toBe(false);
  });
});

describe("no secrets or price ids in src", () => {
  it("has no Stripe key, signing secret or price id literal", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(e.name) && /\b(sk|rk|pk)_(test|live)_[A-Za-z0-9]{10,}|\bwhsec_[A-Za-z0-9]{10,}|\bprice_[A-Za-z0-9]{14,}|\bprod_[A-Za-z0-9]{10,}/.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(hits).toEqual([]);
  });
});

describe("checkout route", () => {
  const post = (body: unknown) => checkout(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

  it("a misconfigured product blocks checkout before any Stripe session or charge exists", async () => {
    const create = vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({ id: "cs_test_x", url: "https://checkout.example/x" });
    const missing = (key: string, id: string) => priceRow(key, id); // product not expanded, so no plan metadata
    const cases: { body: Record<string, unknown>; data: unknown[] }[] = [
      { body: { plan: "pro", interval: "month" }, data: [missing(LOOKUP_KEYS.pro.month, "price_test_pro_m")] },
      { body: { plan: "pro", interval: "month" }, data: [priceRow(LOOKUP_KEYS.pro.month, "price_test_pro_m", { product: { metadata: { plan: "team" } } })] },
      { body: { plan: "team", interval: "year", seats: 3 }, data: [priceRow(LOOKUP_KEYS.team.year, "price_test_team_y", { product: { metadata: {} } })] },
      { body: { plan: "team", interval: "year", seats: 3 }, data: [priceRow(LOOKUP_KEYS.team.year, "price_test_team_y", { product: { metadata: { plan: "pro" } } })] },
    ];
    for (const c of cases) {
      resetPriceCache();
      vi.mocked(stripeApi.listPricesByLookupKeys).mockResolvedValue({ data: c.data });
      const res = await post(c.body);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("price_not_configured");
    }
    expect(create).not.toHaveBeenCalled();
    // Nothing was recorded for a checkout that never existed.
    expect(user().stripeCheckoutSessionId ?? null).toBeNull();
    expect(org().stripeCheckoutSessionId ?? null).toBeNull();
  });

  it("the same prices with the right product metadata check out", async () => {
    const create = vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({ id: "cs_test_ok", url: "https://checkout.example/ok" });
    expect((await post({ plan: "pro", interval: "month" })).status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("creates a Team session with the requested seats and the Premium add-on at the same quantity", async () => {
    const spy = vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({ id: "cs_test_1", url: "https://checkout.example/test" });
    const res = await post({ plan: "team", interval: "year", seats: 6, premium: true });
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe("https://checkout.example/test");
    const params = spy.mock.calls[0][0];
    expect(params.line_items).toEqual([{ price: "price_test_team_y", quantity: 6 }, { price: "price_test_prem_y", quantity: 6 }]);
    // Team anchors to the organization's creation date (Feb 20), not the user's.
    expect((params.subscription_data as { billing_cycle_anchor: number }).billing_cycle_anchor).toBe(Math.floor(new Date("2026-11-20T00:00:00Z").getTime() / 1000));
  });

  it("rejects fewer than 3 seats and a missing seat count with a 400, without calling Stripe", async () => {
    const spy = vi.spyOn(stripeApi, "createCheckoutSession");
    expect((await post({ plan: "team", interval: "month", seats: 2 })).status).toBe(400);
    expect((await post({ plan: "team", interval: "month" })).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it("only an owner or manager can buy Team", async () => {
    fake.seed("user", { id: "rep-1", email: "rep-1@example.test", organizationId: "org-1", role: "trainee" });
    mocks.authId = "rep-1";
    const spy = vi.spyOn(stripeApi, "createCheckoutSession");
    expect((await post({ plan: "team", interval: "month", seats: 3 })).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("blocks a second subscription and points to the portal", async () => {
    fake.rows("user")[0].planTier = "pro";
    fake.rows("user")[0].stripeSubscriptionId = "sub_test_1";
    const res = await post({ plan: "pro", interval: "month" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_subscribed");
  });

  it("does not leak a Stripe failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("sk_test_leak", { status: 500 })));
    const res = await post({ plan: "pro", interval: "month" });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toContain("sk_test_leak");
  });
});

describe("portal route", () => {
  const open = () => portal(new NextRequest("http://localhost/api/billing/portal", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }));

  it("opens the portal for the organization's customer when an owner has one", async () => {
    fake.rows("organization")[0].stripeCustomerId = "cus_test_org";
    fake.rows("user")[0].stripeCustomerId = "cus_test_user";
    const spy = vi.spyOn(stripeApi, "createPortalSession").mockResolvedValue({ url: "https://portal.example/test" });
    const res = await open();
    expect((await res.json()).url).toBe("https://portal.example/test");
    expect(spy.mock.calls[0][0]).toMatchObject({ customer: "cus_test_org", return_url: "http://localhost/settings/billing" });
  });

  it("a trainee only ever gets their own customer, and 404 when there is none", async () => {
    fake.seed("user", { id: "rep-1", email: "rep-1@example.test", organizationId: "org-1", role: "trainee" });
    fake.rows("organization")[0].stripeCustomerId = "cus_test_org";
    mocks.authId = "rep-1";
    const spy = vi.spyOn(stripeApi, "createPortalSession");
    const res = await open();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no_billing_account");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ---- Webhook -------------------------------------------------------------------------------------

const sign = (raw: string, t = Math.floor(Date.now() / 1000), secret = WHSEC) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

let eventSeq = 0;
const event = (type: string, object: Record<string, unknown>, id = `evt_test_${++eventSeq}`) => ({ id, type, data: { object } });
const deliverRaw = (e: unknown, header?: string | null) => {
  const raw = JSON.stringify(e);
  return webhook(new NextRequest("http://localhost/api/stripe/webhook", {
    method: "POST", body: raw,
    headers: header === null ? {} : { "stripe-signature": header ?? sign(raw) },
  }));
};

/** Subscription item prices as Stripe returns them with the product expanded. */
const itemPrice = (id: string, lookup_key: string | null, metadata: Record<string, string>) => ({ id, lookup_key, product: { metadata } });
const PRO_PRICE = itemPrice("price_test_pro_y", "calltrainer_pro_annual", { plan: "pro" });
const TEAM_PRICE = itemPrice("price_test_team_m", "calltrainer_team_monthly", { plan: "team", min_seats: "3", pooled_minutes_per_seat: "300" });
const PREMIUM_PRICE = itemPrice("price_test_prem_m", "calltrainer_premium_monthly", {});

/** Stripe's current state by subscription id. A missing id answers 404, like a subscription Stripe no longer has. */
const liveStripe = new Map<string, unknown>();
let retrieveSpy: MockInstance<typeof stripeApi.retrieveSubscription>;
let cancelSpy: MockInstance<typeof stripeApi.cancelSubscription>;
beforeEach(() => {
  liveStripe.clear();
  retrieveSpy = vi.spyOn(stripeApi, "retrieveSubscription").mockImplementation(async (id: string) => {
    if (!liveStripe.has(id)) throw new StripeApiError(404);
    return liveStripe.get(id);
  });
  cancelSpy = vi.spyOn(stripeApi, "cancelSubscription").mockResolvedValue({ id: "" });
});

/** For tests about one event at a time: the event's own snapshot is what Stripe currently reports. */
function mirrorSnapshot(e: { type: string; data: { object: Record<string, unknown> } }) {
  const o = e.data.object;
  if (e.type === "customer.subscription.updated") liveStripe.set(o.id as string, o);
  if (e.type === "checkout.session.completed" && typeof o.subscription === "string") {
    const m = (o.metadata ?? {}) as Record<string, string>;
    const seats = Number.parseInt(m.seats ?? "", 10) || 3;
    liveStripe.set(o.subscription, {
      id: o.subscription, customer: o.customer ?? "cus_test_1", status: "active", metadata: m,
      items: { data: [
        m.plan === "team" ? { quantity: seats, price: TEAM_PRICE } : { quantity: 1, price: PRO_PRICE },
        ...(m.premium === "true" ? [{ quantity: seats, price: PREMIUM_PRICE }] : []),
      ] },
    });
  }
}
const deliver = (e: unknown, header?: string | null) => {
  mirrorSnapshot(e as Parameters<typeof mirrorSnapshot>[0]);
  return deliverRaw(e, header);
};

const sub = (o: { id?: string; customer?: string; status?: string; team?: number; pro?: boolean; premium?: number; metadata?: Record<string, string> }) => ({
  id: o.id ?? "sub_test_1",
  customer: o.customer ?? "cus_test_1",
  status: o.status ?? "active",
  metadata: o.metadata ?? { userId: "owner-1" },
  items: { data: [
    ...(o.team ? [{ quantity: o.team, price: TEAM_PRICE }] : []),
    ...(o.pro ? [{ quantity: 1, price: PRO_PRICE }] : []),
    ...(o.premium ? [{ quantity: o.premium, price: PREMIUM_PRICE }] : []),
  ] },
});

describe("webhook signature", () => {
  it("rejects a bad signature, a missing one, a wrong secret and a stale timestamp, and touches nothing", async () => {
    const e = event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } });
    const raw = JSON.stringify(e);
    expect((await deliver(e, "t=1,v1=deadbeef")).status).toBe(400);
    expect((await deliver(e, null)).status).toBe(400);
    expect((await deliver(e, sign(raw, undefined, "whsec_other"))).status).toBe(400);
    expect((await deliver(e, sign(raw, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    // Signed for a different body.
    expect((await deliver(e, sign(raw + " "))).status).toBe(400);
    const res = await deliver(e, "t=1,v1=deadbeef");
    expect((await res.json()).error).toBe("invalid_signature");
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(user().planTier).toBe("free");
  });

  it("verifyWebhookSignature accepts a valid header and any one of several v1 values", () => {
    const raw = "{}";
    const t = 1_800_000_000;
    const good = sign(raw, t);
    expect(verifyWebhookSignature(raw, good, WHSEC, t + 10)).toBe(true);
    expect(verifyWebhookSignature(raw, `${good},v1=00`, WHSEC, t + 10)).toBe(true);
    expect(verifyWebhookSignature(raw, good, WHSEC, t + 1000)).toBe(false);
    expect(verifyWebhookSignature(raw, "", WHSEC, t)).toBe(false);
  });

  it("is 503 without STRIPE_WEBHOOK_SECRET", async () => {
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "");
    expect((await deliver(event("x", {}))).status).toBe(503);
  });

  it("acknowledges a valid event of a type it does not handle", async () => {
    const res = await deliver(event("invoice.paid", {}));
    expect(await res.json()).toEqual({ received: true, result: "ignored" });
  });
});

describe("checkout.session.completed", () => {
  it("Pro: sets plan, customer and subscription, and raises the user's cap to 200", async () => {
    const res = await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1", premium: "false" } }));
    expect((await res.json()).result).toBe("processed");
    expect(user()).toMatchObject({ planTier: "pro", stripeCustomerId: "cus_test_1", stripeSubscriptionId: "sub_test_1", premiumVoice: false, subscriptionStatus: "active" });
    const a = allowance("userId", "owner-1")!;
    expect(a).toMatchObject({ planTier: "pro", minutesCap: 200 });
    // The usage anchor never moves: the period still starts on the 10th.
    expect((a.periodStart as Date).getUTCDate()).toBe(10);
    expect((a.anchorAt as Date).getTime()).toBe(ANCHOR.getTime());
  });

  it("Team with Premium: sets org plan, seats, premium flag and pool cap (seats x 300)", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", userId: "owner-1", organizationId: "org-1", seats: "4", premium: "true" } }));
    expect(org()).toMatchObject({ planTier: "team", seatCount: 4, premiumVoice: true, stripeCustomerId: "cus_test_team", stripeSubscriptionId: "sub_test_team" });
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "team", minutesCap: 1200 });
    expect(user().planTier).toBe("free");
  });

  it("never lets metadata drop Team below 3 seats", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "c", subscription: "s", metadata: { plan: "team", organizationId: "org-1", seats: "1" } }));
    expect(org().seatCount).toBe(3);
    expect(allowance("organizationId", "org-1")?.minutesCap).toBe(900);
  });

  it("keeps minutes already used when a Free user upgrades mid-period", async () => {
    const now = new Date();
    const first = await (await import("@/lib/usage")).ensureAllowance(fake.db as never, { userId: "owner-1" }, now);
    allowance("userId", "owner-1")!.minutesUsed = 12;
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    expect(allowance("userId", "owner-1")).toMatchObject({ minutesCap: 200, minutesUsed: 12 });
    expect((allowance("userId", "owner-1")!.periodStart as Date).getTime()).toBe((first.periodStart as Date).getTime());
  });

  it("ignores a session for someone else's organization id that does not exist", async () => {
    const res = await deliver(event("checkout.session.completed", { mode: "subscription", customer: "c", subscription: "s", metadata: { plan: "team", organizationId: "org-nope" } }));
    expect((await res.json()).result).toBe("ignored");
    expect(org().planTier).toBe("free");
  });
});

describe("customer.subscription.updated", () => {
  beforeEach(async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", userId: "owner-1", organizationId: "org-1", seats: "3" } }));
  });
  const update = (o: Parameters<typeof sub>[0]) => deliver(event("customer.subscription.updated", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: { organizationId: "org-1" }, ...o })));

  it("15: a seat added in the portal raises the pool cap by 300 and re-syncs the premium flag and status", async () => {
    expect(allowance("organizationId", "org-1")?.minutesCap).toBe(900);
    await update({ team: 4, premium: 4 });
    expect(org()).toMatchObject({ seatCount: 4, premiumVoice: true, subscriptionStatus: "active" });
    expect(allowance("organizationId", "org-1")?.minutesCap).toBe(1200);
    await update({ team: 4 });
    expect(org().premiumVoice).toBe(false);
  });

  it("keeps the plan while past_due, records the status", async () => {
    await update({ team: 3, status: "past_due" });
    expect(org()).toMatchObject({ planTier: "team", subscriptionStatus: "past_due" });
  });

  it("falls back to Free for unpaid, canceled and incomplete_expired subscriptions", async () => {
    await update({ team: 5, status: "unpaid" });
    expect(org()).toMatchObject({ planTier: "free", seatCount: 1, subscriptionStatus: "unpaid", premiumVoice: false });
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "free", minutesCap: 10 });
  });

  it("moves a user from Team seats to Pro prices and the cap follows", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    await deliver(event("customer.subscription.updated", sub({ id: "sub_test_1", pro: true, premium: 1 })));
    expect(user()).toMatchObject({ planTier: "pro", premiumVoice: true });
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(200);
  });

  const withItems = (items: unknown[], status = "active") =>
    deliver(event("customer.subscription.updated", { ...sub({ id: "sub_test_team", customer: "cus_test_team", metadata: { organizationId: "org-1" }, status }), items: { data: items } }));

  it("does not change a paid plan when the items declare no valid plan", async () => {
    await withItems([{ quantity: 1, price: itemPrice("price_unknown", null, {}) }]);
    expect(org().planTier).toBe("team");
  });

  it("an archived price with no lookup key still syncs from its product metadata", async () => {
    const archived = itemPrice("price_test_archived_team", null, { plan: "team" });
    await withItems([{ quantity: 5, price: archived }]);
    expect(org()).toMatchObject({ planTier: "team", seatCount: 5 });
    expect(allowance("organizationId", "org-1")?.minutesCap).toBe(1500);
  });

  it("an archived price that goes unpaid or past its lifetime still drops the org to Free", async () => {
    const archived = itemPrice("price_test_archived_team", null, { plan: "team" });
    await withItems([{ quantity: 3, price: archived }], "unpaid");
    expect(org()).toMatchObject({ planTier: "free", subscriptionStatus: "unpaid" });
  });

  it("unpaid revokes access even when the items carry no plan metadata at all", async () => {
    await withItems([{ quantity: 3, price: itemPrice("price_unknown", null, {}) }], "unpaid");
    expect(org()).toMatchObject({ planTier: "free", subscriptionStatus: "unpaid" });
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "free", minutesCap: 10 });
  });

  it("a product without plan metadata, or with an invalid one, never grants Team", async () => {
    await update({ team: 3 });
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_x", subscription: "sub_test_nometa", metadata: { plan: "team", organizationId: "org-2" } }));
    liveStripe.set("sub_test_nometa", { ...sub({ id: "sub_test_nometa", customer: "cus_x" }), items: { data: [{ quantity: 9, price: itemPrice("price_a", "calltrainer_team_monthly", {}) }] } });
    fake.seed("organization", { id: "org-2", code: "456", createdAt: new Date("2026-02-20T00:00:00Z") });
    await deliverRaw(event("customer.subscription.updated", { id: "sub_test_nometa", customer: "cus_x", status: "active", metadata: { organizationId: "org-2" } }));
    liveStripe.set("sub_test_nometa", { ...sub({ id: "sub_test_nometa", customer: "cus_x" }), items: { data: [{ quantity: 9, price: itemPrice("price_a", "calltrainer_team_monthly", { plan: "enterprise" }) }] } });
    await deliverRaw(event("customer.subscription.updated", { id: "sub_test_nometa", customer: "cus_x", status: "active", metadata: { organizationId: "org-2" } }));
    expect(fake.rows("organization").find((o) => o.id === "org-2")?.planTier ?? "free").toBe("free");
  });

  it("waits for an incomplete checkout to finish", async () => {
    await update({ team: 8, status: "incomplete" });
    expect(org().seatCount).toBe(3);
  });

  it("derives entitlement from product metadata: the plan must be declared, Premium is only a flag", () => {
    expect(entitlementFromItems([{ quantity: 2, productMetadata: { plan: "team" } }])).toEqual({ plan: "team", seats: 3, premium: false });
    expect(entitlementFromItems([{ quantity: 1, productMetadata: { plan: "pro" } }, { quantity: 1, lookupKey: "calltrainer_premium_monthly", productMetadata: {} }])).toEqual({ plan: "pro", seats: 1, premium: true });
    expect(entitlementFromItems([{ quantity: 1, lookupKey: "calltrainer_premium_monthly" }])).toBeNull();
  });

  it("missing, invalid or conflicting metadata grants nothing", () => {
    expect(entitlementFromItems([{ quantity: 3, lookupKey: "calltrainer_team_monthly", productMetadata: {} }])).toBeNull();
    expect(entitlementFromItems([{ quantity: 3, lookupKey: "calltrainer_team_monthly", productMetadata: null }])).toBeNull();
    for (const plan of ["enterprise", "Team", "", "free"]) expect(entitlementFromItems([{ quantity: 3, productMetadata: { plan } }])).toBeNull();
    // The lookup key says Team but the product says Pro, and the reverse.
    expect(entitlementFromItems([{ quantity: 3, lookupKey: "calltrainer_team_annual", productMetadata: { plan: "pro" } }])).toBeNull();
    expect(entitlementFromItems([{ quantity: 1, lookupKey: "calltrainer_pro_annual", productMetadata: { plan: "team" } }])).toBeNull();
    // Two products declaring different plans on one subscription.
    expect(entitlementFromItems([{ quantity: 1, productMetadata: { plan: "pro" } }, { quantity: 3, productMetadata: { plan: "team" } }])).toBeNull();
  });

  it("an item with no lookup key resolves by metadata alone", () => {
    expect(entitlementFromItems([{ quantity: 6, lookupKey: null, productMetadata: { plan: "team", pooled_minutes_per_seat: "300" } }])).toEqual({ plan: "team", seats: 6, premium: false });
  });

  it("asks Stripe for the subscription with its products expanded", async () => {
    const sent = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", sent);
    retrieveSpy.mockRestore();
    await stripeApi.retrieveSubscription("sub_test_1");
    expect(decodeURIComponent((sent.mock.calls[0] as unknown as [string])[0])).toBe("https://api.stripe.com/v1/subscriptions/sub_test_1?expand[0]=items.data.price.product");
  });
});

describe("customer.subscription.deleted", () => {
  it("downgrades a Pro user to Free, cap 10, and keeps the usage anchor", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1", premium: "true" } }));
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(200);
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    expect(user()).toMatchObject({ planTier: "free", premiumVoice: false, stripeSubscriptionId: null, subscriptionStatus: "canceled", stripeCustomerId: "cus_test_1" });
    expect(allowance("userId", "owner-1")).toMatchObject({ planTier: "free", minutesCap: 10 });
    expect((allowance("userId", "owner-1")!.anchorAt as Date).getTime()).toBe(ANCHOR.getTime());
  });

  it("cancel to Free applies the 10 minute cap to this month's usage: 150 used is over it, 7 used leaves 3", async () => {
    const { beginCall, resolveAllowance } = await import("@/lib/usage");
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    allowance("userId", "owner-1")!.minutesUsed = 150;
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    // Usage is kept, the cap drops to 10, and the next voice call is refused before anything is charged.
    expect(allowance("userId", "owner-1")).toMatchObject({ planTier: "free", minutesCap: 10, minutesUsed: 150 });
    expect(await beginCall("owner-1", { id: "quote-follow-up" })).toEqual({ ok: false, error: "cap_reached" });
    expect(fake.rows("trainerSession")).toHaveLength(0);
    expect(fake.rows("usageEntry")).toHaveLength(0);

    // A user with usage under the Free cap keeps the rest of it.
    allowance("userId", "owner-1")!.minutesUsed = 7;
    const r = await resolveAllowance(fake.db as never, "owner-1", new Date());
    expect(r).toMatchObject({ plan: "free", remaining: 3 });
    expect((await beginCall("owner-1", { id: "quote-follow-up" })).ok).toBe(true);
  });

  it("unpaid also drops to the Free cap on this month's usage", async () => {
    const { beginCall } = await import("@/lib/usage");
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    allowance("userId", "owner-1")!.minutesUsed = 40;
    await deliver(event("customer.subscription.updated", sub({ id: "sub_test_1", pro: true, status: "unpaid" })));
    expect(allowance("userId", "owner-1")).toMatchObject({ planTier: "free", minutesCap: 10, minutesUsed: 40 });
    expect(await beginCall("owner-1", { id: "quote-follow-up" })).toEqual({ ok: false, error: "cap_reached" });
  });

  it("downgrades a Team organization to Free and its members fall back to their own allowance", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", organizationId: "org-1", seats: "5", premium: "true" } }));
    await deliver(event("customer.subscription.deleted", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: {}, team: 5 })));
    expect(org()).toMatchObject({ planTier: "free", seatCount: 1, premiumVoice: false, subscriptionStatus: "canceled" });
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "free", minutesCap: 10 });
    const { resolveAllowance } = await import("@/lib/usage");
    const r = await resolveAllowance(fake.db as never, "owner-1", NOW);
    expect(r).toMatchObject({ pooled: false, plan: "free" });
  });
});

describe("idempotency", () => {
  it("a duplicate event is ignored: no second change, same answer", async () => {
    const e = event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }, "evt_test_dup");
    expect((await (await deliver(e)).json()).result).toBe("processed");
    // Something else changed the plan in between; a replay must not undo it.
    fake.rows("user")[0].planTier = "free";
    const again = await deliver(e);
    expect(again.status).toBe(200);
    expect((await again.json()).result).toBe("duplicate");
    expect(user().planTier).toBe("free");
    expect(fake.rows("stripeEvent")).toHaveLength(1);
  });

  it("persists the event id with the change; a failed change rolls the id back so Stripe's retry runs", async () => {
    const e = event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }, "evt_test_retry");
    fake.failNextUpdate("user");
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await deliver(e)).status).toBe(500);
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(user().planTier).toBe("free");
    const retry = await deliver(e);
    expect((await retry.json()).result).toBe("processed");
    expect(user().planTier).toBe("pro");
  });
});

describe("CRM lifecycle hook (off by default)", () => {
  const seen: BillingLifecycleEvent[] = [];
  beforeEach(() => { seen.length = 0; setBillingEventSink((e) => { seen.push(e); }); });
  const checkoutPro = (id: string) => deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }, id));

  it("emits nothing unless GHL_BILLING_EVENTS=true", async () => {
    await checkoutPro("evt_a");
    expect(seen).toEqual([]);
  });

  it("emits upgrade and churn with ids and plans only", async () => {
    vi.stubEnv("GHL_BILLING_EVENTS", "true");
    await checkoutPro("evt_b");
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    expect(seen.map((e) => [e.kind, e.fromPlan, e.toPlan])).toEqual([["upgrade", "free", "pro"], ["churn", "pro", "free"]]);
    expect(JSON.stringify(seen)).not.toContain("@");
  });

  it("a sink that throws never fails the webhook", async () => {
    vi.stubEnv("GHL_BILLING_EVENTS", "true");
    vi.spyOn(console, "error").mockImplementation(() => {});
    setBillingEventSink(() => { throw new Error("crm down"); });
    expect((await checkoutPro("evt_c")).status).toBe(200);
    expect(user().planTier).toBe("pro");
  });

  it("classifies plan changes", () => {
    expect(classifyPlanChange("free", "pro")).toBe("upgrade");
    expect(classifyPlanChange("pro", "team")).toBe("upgrade");
    expect(classifyPlanChange("team", "pro")).toBe("downgrade");
    expect(classifyPlanChange("team", "free")).toBe("churn");
    expect(classifyPlanChange("pro", "pro")).toBeNull();
  });
});

// ---- Codex review: webhook ordering, ownership, duplicate checkout, unpaid checkout ------------------

const liveSub = (o: { id: string; status?: string; customer?: string; metadata?: Record<string, string> } & Parameters<typeof sub>[0]) => {
  const s = { ...sub(o), id: o.id };
  liveStripe.set(o.id, s);
  return s;
};

describe("out-of-order events are reconciled against Stripe's current state", () => {
  beforeEach(async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    expect(user().planTier).toBe("pro");
  });

  it("a delayed checkout.session.completed cannot restore a plan that was canceled since", async () => {
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    expect(user().planTier).toBe("free");
    liveStripe.delete("sub_test_1"); // Stripe: gone
    const late = event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" } });
    await deliverRaw(late);
    expect(user()).toMatchObject({ planTier: "free", stripeSubscriptionId: null });
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(10);
  });

  it("a delayed 'active' update cannot restore a subscription Stripe now reports canceled", async () => {
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    liveSub({ id: "sub_test_1", pro: true, status: "canceled" });
    await deliverRaw(event("customer.subscription.updated", sub({ pro: true, status: "active" })));
    expect(user()).toMatchObject({ planTier: "free", stripeSubscriptionId: null });
  });

  it("a delayed seat update cannot overwrite a newer seat or Premium change", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", organizationId: "org-1", seats: "3" } }));
    liveSub({ id: "sub_test_team", customer: "cus_test_team", metadata: { organizationId: "org-1" }, team: 5, premium: 5 });
    // The older event says 3 seats and no Premium; Stripe says 5 and Premium.
    await deliverRaw(event("customer.subscription.updated", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: { organizationId: "org-1" }, team: 3 })));
    expect(org()).toMatchObject({ planTier: "team", seatCount: 5, premiumVoice: true });
    expect(allowance("organizationId", "org-1")?.minutesCap).toBe(1500);
  });

  it("answers 500 without recording the event when Stripe cannot be read, so Stripe retries", async () => {
    retrieveSpy.mockRejectedValueOnce(new StripeApiError(503));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const e = event("customer.subscription.updated", sub({ pro: true, premium: 1 }), "evt_test_unreadable");
    expect((await deliverRaw(e)).status).toBe(500);
    expect(fake.rows("stripeEvent").some((r) => r.id === "evt_test_unreadable")).toBe(false);
    expect(user().premiumVoice).toBe(false);
    liveSub({ id: "sub_test_1", pro: true, premium: 1 });
    expect((await (await deliverRaw(e)).json()).result).toBe("processed");
    expect(user().premiumVoice).toBe(true);
  });
});

describe("a deleted older subscription cannot revoke a newer one", () => {
  it("ignores customer.subscription.deleted for a subscription the subject no longer holds", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_new", metadata: { plan: "pro", userId: "owner-1" } }));
    // Same customer and same userId metadata as the new subscription, but a different subscription id.
    const res = await deliverRaw(event("customer.subscription.deleted", sub({ id: "sub_test_old", customer: "cus_test_1", pro: true, metadata: { userId: "owner-1" } })));
    expect((await res.json()).result).toBe("ignored");
    expect(user()).toMatchObject({ planTier: "pro", stripeSubscriptionId: "sub_test_new", subscriptionStatus: "active" });
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(200);
  });

  it("still revokes when the deleted subscription is the one the subject holds", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_new", metadata: { plan: "pro", userId: "owner-1" } }));
    await deliverRaw(event("customer.subscription.deleted", sub({ id: "sub_test_new", customer: "cus_test_1", pro: true })));
    expect(user()).toMatchObject({ planTier: "free", stripeSubscriptionId: null });
  });

  it("does not let a late update from an old subscription replace the current one", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_new", metadata: { plan: "pro", userId: "owner-1", premium: "true" } }));
    liveSub({ id: "sub_test_old", customer: "cus_test_1", pro: true, status: "past_due", metadata: { userId: "owner-1" } });
    await deliverRaw(event("customer.subscription.updated", sub({ id: "sub_test_old", customer: "cus_test_1", pro: true, status: "past_due", metadata: { userId: "owner-1" } })));
    expect(user()).toMatchObject({ stripeSubscriptionId: "sub_test_new", premiumVoice: true, subscriptionStatus: "active" });
  });

  it("cancels a second ACTIVE subscription at Stripe instead of letting it replace or double the first", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_first", metadata: { plan: "pro", userId: "owner-1" } }));
    liveSub({ id: "sub_test_dupe", customer: "cus_test_1", pro: true, metadata: { userId: "owner-1" } });
    const res = await deliverRaw(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_dupe", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" } }));
    expect((await res.json()).result).toBe("processed");
    expect(cancelSpy).toHaveBeenCalledWith("sub_test_dupe");
    expect(user().stripeSubscriptionId).toBe("sub_test_first");
  });
});

describe("one outstanding Checkout Session per billing subject", () => {
  const post = (body: unknown) => checkout(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));
  let created: { id: string; key?: string; params: Record<string, unknown> }[];
  let expired: string[];
  let shift = 0;

  beforeEach(() => {
    // The billing limits are fixed (20 an hour per account), so give each test its own window rather than raising them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + ++shift * 2 * 3_600_000);
    created = [];
    expired = [];
    // Like Stripe: the same idempotency key returns the same session.
    vi.spyOn(stripeApi, "createCheckoutSession").mockImplementation(async (params, key) => {
      const hit = key ? created.find((c) => c.key === key) : undefined;
      if (hit) return { id: hit.id, url: `https://checkout.example/${hit.id}` };
      const id = `cs_test_${created.length + 1}`;
      created.push({ id, key, params: params as Record<string, unknown> });
      return { id, url: `https://checkout.example/${id}` };
    });
    vi.spyOn(stripeApi, "expireCheckoutSession").mockImplementation(async (id) => { expired.push(id); return { id }; });
  });

  it("a second click for the same purchase returns the first session instead of opening another", async () => {
    const a = await (await post({ plan: "pro", interval: "month" })).json();
    const b = await (await post({ plan: "pro", interval: "month" })).json();
    expect(b.url).toBe(a.url);
    expect(created).toHaveLength(1);
    expect(user()).toMatchObject({ stripeCheckoutSessionId: "cs_test_1", stripeCheckoutUrl: a.url });
  });

  it("choosing a different plan expires the outstanding session and records the new one", async () => {
    await post({ plan: "pro", interval: "month" });
    const res = await post({ plan: "pro", interval: "year" });
    expect(res.status).toBe(200);
    expect(expired).toEqual(["cs_test_1"]);
    expect(created).toHaveLength(2);
    expect(user().stripeCheckoutSessionId).toBe("cs_test_2");
  });

  it("an expired session is not reused", async () => {
    await post({ plan: "pro", interval: "month" });
    user().stripeCheckoutExpiresAt = new Date(Date.now() - 1000);
    await post({ plan: "pro", interval: "month" });
    expect(created).toHaveLength(2);
  });

  it("two identical requests at the same moment end up with one session recorded", async () => {
    const [a, b] = await Promise.all([post({ plan: "pro", interval: "month" }), post({ plan: "pro", interval: "month" })]);
    expect((await a.json()).url).toBe((await b.json()).url);
    expect(new Set(created.map((c) => c.id)).size).toBe(1);
    expect(user().stripeCheckoutSessionId).toBe("cs_test_1");
  });

  it("two different requests at the same moment: one wins, the other is expired and told to retry", async () => {
    const [a, b] = await Promise.all([post({ plan: "pro", interval: "month" }), post({ plan: "pro", interval: "year" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const recorded = user().stripeCheckoutSessionId as string;
    const loser = created.find((c) => c.id !== recorded)!;
    expect(expired).toContain(loser.id);
    expect(expired).not.toContain(recorded);
  });

  describe("replacing a session needs the old one confirmed closed", () => {
    const failExpire = (status = 400) => vi.spyOn(stripeApi, "expireCheckoutSession").mockImplementation(async (id) => { expired.push(id); throw new StripeApiError(status); });
    const doc = (o: Record<string, unknown>) => ({ id: "cs_test_1", mode: "subscription", customer: "cus_test_1", metadata: { plan: "pro", userId: "owner-1" }, ...o });

    it("an old session that is still open after a failed expire blocks the replacement", async () => {
      await post({ plan: "pro", interval: "month" });
      failExpire(500);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(doc({ status: "open" }));
      const res = await post({ plan: "pro", interval: "year" });
      expect(res.status).toBe(502);
      expect(created).toHaveLength(1);
      expect(user().stripeCheckoutSessionId).toBe("cs_test_1");
    });

    it("an old session whose state cannot be read blocks the replacement", async () => {
      await post({ plan: "pro", interval: "month" });
      failExpire(500);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockRejectedValue(new StripeApiError(503));
      expect((await post({ plan: "pro", interval: "year" })).status).toBe(502);
      expect(created).toHaveLength(1);
    });

    it("a session Stripe reports as expired (so expiring it again fails) is replaced", async () => {
      await post({ plan: "pro", interval: "month" });
      failExpire(400);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(doc({ status: "expired" }));
      const res = await post({ plan: "pro", interval: "year" });
      expect(res.status).toBe(200);
      expect(created).toHaveLength(2);
      expect(user().stripeCheckoutSessionId).toBe("cs_test_2");
    });

    it("a session that completed before its webhook arrived is applied, and no replacement is created", async () => {
      await post({ plan: "pro", interval: "month" });
      failExpire(400);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(doc({ status: "complete", payment_status: "paid", subscription: "sub_test_9" }));
      liveSub({ id: "sub_test_9", pro: true, metadata: { userId: "owner-1" } });
      const res = await post({ plan: "pro", interval: "year" });
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("checkout_completed");
      expect(created).toHaveLength(1);
      expect(user()).toMatchObject({ planTier: "pro", stripeSubscriptionId: "sub_test_9", stripeCheckoutSessionId: null });
      // The webhook for the same checkout arrives later and changes nothing.
      await deliverRaw(event("checkout.session.completed", doc({ subscription: "sub_test_9", payment_status: "paid" })));
      expect(user()).toMatchObject({ planTier: "pro", stripeSubscriptionId: "sub_test_9" });
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it("a completed session whose payment is still pending keeps blocking, and a failed payment frees the account", async () => {
      await post({ plan: "pro", interval: "month" });
      failExpire(400);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(doc({ status: "complete", payment_status: "unpaid", subscription: "sub_test_9" }));
      liveSub({ id: "sub_test_9", status: "incomplete", pro: true, metadata: { userId: "owner-1" } });
      expect((await post({ plan: "pro", interval: "year" })).status).toBe(409);
      expect(created).toHaveLength(1);
      expect(user()).toMatchObject({ planTier: "free", stripeCheckoutSessionId: "cs_test_1" });
      await deliverRaw(event("checkout.session.async_payment_failed", { id: "cs_test_1", mode: "subscription" }));
      expect(user().stripeCheckoutSessionId).toBeNull();
    });

    it("a stored session past our own 23 hour window is still confirmed closed first", async () => {
      await post({ plan: "pro", interval: "month" });
      user().stripeCheckoutExpiresAt = new Date(Date.now() - 1000);
      failExpire(500);
      vi.spyOn(stripeApi, "retrieveCheckoutSession").mockResolvedValue(doc({ status: "open" }));
      expect((await post({ plan: "pro", interval: "month" })).status).toBe(502);
      expect(created).toHaveLength(1);
    });
  });

  it("Team is tracked on the organization, separately from the owner's own Pro checkout", async () => {
    await post({ plan: "pro", interval: "month" });
    await post({ plan: "team", interval: "month", seats: 3 });
    expect(user().stripeCheckoutSessionId).toBe("cs_test_1");
    expect(org().stripeCheckoutSessionId).toBe("cs_test_2");
  });

  it("clears the stored session once the subscription lands, and when Stripe expires the session", async () => {
    await post({ plan: "pro", interval: "month" });
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" } }));
    expect(user()).toMatchObject({ stripeCheckoutSessionId: null, stripeCheckoutUrl: null });

    fake.rows("user")[0].planTier = "free";
    fake.rows("user")[0].stripeSubscriptionId = null;
    await post({ plan: "pro", interval: "month" });
    const id = user().stripeCheckoutSessionId as string;
    expect(id).toBeTruthy();
    expect((await (await deliverRaw(event("checkout.session.expired", { id, mode: "subscription" }))).json()).result).toBe("processed");
    expect(user().stripeCheckoutSessionId).toBeNull();
  });
});

afterEach(() => { vi.useRealTimers(); });

describe("checkout completion does not grant access to an unpaid subscription", () => {
  const completed = (o: Record<string, unknown> = {}) =>
    event("checkout.session.completed", { id: "cs_test_x", mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" }, ...o });

  it("payment_status unpaid (delayed payment method): nothing is granted yet", async () => {
    liveSub({ id: "sub_test_1", pro: true, status: "incomplete" });
    const res = await deliverRaw(completed({ payment_status: "unpaid" }));
    expect((await res.json()).result).toBe("ignored");
    expect(user()).toMatchObject({ planTier: "free", stripeSubscriptionId: null });
    expect(allowance("userId", "owner-1")?.minutesCap ?? 10).toBe(10);
  });

  it("then the subscription turning active grants it", async () => {
    liveSub({ id: "sub_test_1", pro: true, status: "incomplete" });
    await deliverRaw(completed({ payment_status: "unpaid" }));
    liveSub({ id: "sub_test_1", pro: true, status: "active" });
    await deliverRaw(event("customer.subscription.updated", sub({ pro: true, status: "active" })));
    expect(user()).toMatchObject({ planTier: "pro", stripeSubscriptionId: "sub_test_1" });
  });

  it("async_payment_succeeded grants it once Stripe reports the subscription active", async () => {
    liveSub({ id: "sub_test_1", pro: true, status: "active" });
    const res = await deliverRaw(event("checkout.session.async_payment_succeeded", { id: "cs_test_x", mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" } }));
    expect((await res.json()).result).toBe("processed");
    expect(user().planTier).toBe("pro");
  });

  it("async_payment_succeeded still grants nothing if the subscription is not active", async () => {
    liveSub({ id: "sub_test_1", pro: true, status: "incomplete" });
    await deliverRaw(event("checkout.session.async_payment_succeeded", { id: "cs_test_x", mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "paid", metadata: { plan: "pro", userId: "owner-1" } }));
    expect(user().planTier).toBe("free");
  });

  it("async_payment_failed grants nothing", async () => {
    liveSub({ id: "sub_test_1", pro: true, status: "incomplete" });
    await deliverRaw(event("checkout.session.async_payment_failed", { id: "cs_test_x", mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", payment_status: "unpaid", metadata: { plan: "pro", userId: "owner-1" } }));
    expect(user().planTier).toBe("free");
  });

  it("a 'paid' checkout whose subscription Stripe reports unpaid or canceled is Free, whatever the metadata says", async () => {
    for (const status of ["unpaid", "canceled", "incomplete_expired"]) {
      liveSub({ id: "sub_test_1", pro: true, status });
      await deliverRaw(completed());
      expect(user().planTier).toBe("free");
    }
  });

  it("plan and seats come from the subscription's prices, not from checkout metadata", async () => {
    liveSub({ id: "sub_test_team", customer: "cus_test_team", team: 4, metadata: { organizationId: "org-1" } });
    await deliverRaw(completed({ customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", organizationId: "org-1", seats: "99" } }));
    expect(org()).toMatchObject({ planTier: "team", seatCount: 4 });
  });
});

describe("a Team that cancels or goes unpaid carries this month's pool usage into the Free cap", () => {
  const scnInfo = { id: "quote-follow-up" };

  /** The member runs a real call against the Team pool: `minutes` whole minutes, on a clock that starts now. */
  async function memberUsesPool(minutes: number) {
    const { beginCall, endCall, heartbeat } = await import("@/lib/usage");
    const t0 = new Date();
    const begun = await beginCall("owner-1", scnInfo, t0);
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("owner-1", begun.callId, "connected", t0);
    await endCall("owner-1", begun.callId, "user_hangup", new Date(t0.getTime() + minutes * 60_000));
  }

  beforeEach(async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", userId: "owner-1", organizationId: "org-1", seats: "3" } }));
    expect(org()).toMatchObject({ planTier: "team", seatCount: 3 });
  });

  const cancel = () => deliver(event("customer.subscription.deleted", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: {}, team: 3 })));
  const unpaid = () => deliver(event("customer.subscription.updated", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: { organizationId: "org-1" }, team: 3, status: "unpaid" })));

  for (const [name, end] of [["cancellation", cancel], ["an unpaid subscription", unpaid]] as const) {
    it(`${name}: a member with 12 pool minutes this month is over the Free cap and cannot start another call`, async () => {
      const { beginCall, resolveAllowance } = await import("@/lib/usage");
      await memberUsesPool(12);
      expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "team", minutesUsed: 12 });
      await end();
      expect(org().planTier).toBe("free");

      const r = await resolveAllowance(fake.db as never, "owner-1", new Date());
      expect(r).toMatchObject({ plan: "free", pooled: false, usedElsewhere: 12, remaining: 0 });
      const calls = fake.rows("trainerSession").length;
      expect(await beginCall("owner-1", scnInfo)).toEqual({ ok: false, error: "cap_reached" });
      expect(fake.rows("trainerSession")).toHaveLength(calls);
    });

    it(`${name}: a member with 4 pool minutes keeps 6 Free minutes and can start a call`, async () => {
      const { beginCall, resolveAllowance } = await import("@/lib/usage");
      await memberUsesPool(4);
      await end();
      expect(await resolveAllowance(fake.db as never, "owner-1", new Date())).toMatchObject({ plan: "free", usedElsewhere: 4, remaining: 6 });
      expect(await beginCall("owner-1", scnInfo)).toMatchObject({ ok: true, remaining: 6 });
    });
  }
});
