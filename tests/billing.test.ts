import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "owner-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));

import { buildCheckoutParams, CheckoutConfigError, entitlementFromItems, priceIds, type PriceIds } from "@/lib/billing";
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
const PRICE_ENV: Record<string, string> = {
  STRIPE_PRICE_PRO_MONTHLY: "price_test_pro_m", STRIPE_PRICE_PRO_ANNUAL: "price_test_pro_y",
  STRIPE_PRICE_TEAM_MONTHLY: "price_test_team_m", STRIPE_PRICE_TEAM_ANNUAL: "price_test_team_y",
  STRIPE_PRICE_PREMIUM_MONTHLY: "price_test_prem_m", STRIPE_PRICE_PREMIUM_ANNUAL: "price_test_prem_y",
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
  for (const [k, v] of Object.entries(PRICE_ENV)) vi.stubEnv(k, v);
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

  it("reads price ids from the six env var names", () => {
    expect(priceIds()).toEqual(PRICES);
    const none = { month: undefined, year: undefined };
    expect(priceIds({})).toEqual({ pro: none, team: none, premium: none });
  });
});

describe("checkout route", () => {
  const post = (body: unknown) => checkout(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }));

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
        m.plan === "team" ? { quantity: seats, price: { id: "price_test_team_m" } } : { quantity: 1, price: { id: "price_test_pro_m" } },
        ...(m.premium === "true" ? [{ quantity: seats, price: { id: "price_test_prem_m" } }] : []),
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
    ...(o.team ? [{ quantity: o.team, price: { id: "price_test_team_m" } }] : []),
    ...(o.pro ? [{ quantity: 1, price: { id: "price_test_pro_y" } }] : []),
    ...(o.premium ? [{ quantity: o.premium, price: { id: "price_test_prem_m" } }] : []),
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
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "free", minutesCap: 20 });
  });

  it("moves a user from Team seats to Pro prices and the cap follows", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } }));
    await deliver(event("customer.subscription.updated", sub({ id: "sub_test_1", pro: true, premium: 1 })));
    expect(user()).toMatchObject({ planTier: "pro", premiumVoice: true });
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(200);
  });

  it("does not touch a plan when the subscription has none of our prices", async () => {
    await deliver(event("customer.subscription.updated", { ...sub({ id: "sub_test_team", customer: "cus_test_team" }), items: { data: [{ quantity: 1, price: { id: "price_unknown" } }] } }));
    expect(org().planTier).toBe("team");
  });

  it("waits for an incomplete checkout to finish", async () => {
    await update({ team: 8, status: "incomplete" });
    expect(org().seatCount).toBe(3);
  });

  it("derives entitlement from price ids: Team wins over Pro, Premium is only a flag", () => {
    expect(entitlementFromItems([{ priceId: "price_test_team_y", quantity: 2 }], PRICES)).toEqual({ plan: "team", seats: 3, premium: false });
    expect(entitlementFromItems([{ priceId: "price_test_pro_m", quantity: 1 }, { priceId: "price_test_prem_m", quantity: 1 }], PRICES)).toEqual({ plan: "pro", seats: 1, premium: true });
    expect(entitlementFromItems([{ priceId: "price_test_prem_m", quantity: 1 }], PRICES)).toBeNull();
  });
});

describe("customer.subscription.deleted", () => {
  it("downgrades a Pro user to Free, cap 20, and keeps the usage anchor", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1", premium: "true" } }));
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(200);
    await deliver(event("customer.subscription.deleted", sub({ pro: true })));
    expect(user()).toMatchObject({ planTier: "free", premiumVoice: false, stripeSubscriptionId: null, subscriptionStatus: "canceled", stripeCustomerId: "cus_test_1" });
    expect(allowance("userId", "owner-1")).toMatchObject({ planTier: "free", minutesCap: 20 });
    expect((allowance("userId", "owner-1")!.anchorAt as Date).getTime()).toBe(ANCHOR.getTime());
  });

  it("downgrades a Team organization to Free and its members fall back to their own allowance", async () => {
    await deliver(event("checkout.session.completed", { mode: "subscription", customer: "cus_test_team", subscription: "sub_test_team", metadata: { plan: "team", organizationId: "org-1", seats: "5", premium: "true" } }));
    await deliver(event("customer.subscription.deleted", sub({ id: "sub_test_team", customer: "cus_test_team", metadata: {}, team: 5 })));
    expect(org()).toMatchObject({ planTier: "free", seatCount: 1, premiumVoice: false, subscriptionStatus: "canceled" });
    expect(allowance("organizationId", "org-1")).toMatchObject({ planTier: "free", minutesCap: 20 });
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
    expect(allowance("userId", "owner-1")?.minutesCap).toBe(20);
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
    expect(allowance("userId", "owner-1")?.minutesCap ?? 20).toBe(20);
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
