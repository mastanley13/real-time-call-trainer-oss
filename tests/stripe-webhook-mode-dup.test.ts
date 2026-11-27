import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

/**
 * POST /api/stripe/webhook drops a signed event whose livemode does not match
 * the server before handleStripeEvent runs, so the event id is not stored.
 * The same id can still process when livemode matches. A mismatch replay after
 * a processed event does not change the plan. Stripe is mocked; no network.
 */

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));

import { PRICE_ENV, resetPriceCache, type PriceIds } from "@/lib/billing";
import { setBillingEventSink } from "@/lib/billingEvents";
import { stripeApi, StripeApiError } from "@/lib/stripe";
import { POST as webhook } from "@/app/api/stripe/webhook/route";

const PRICES: PriceIds = {
  pro: { month: "price_test_pro_m", year: "price_test_pro_y" },
  team: { month: "price_test_team_m", year: "price_test_team_y" },
  premium: { month: "price_test_prem_m", year: "price_test_prem_y" },
};
const PRO_META = { ct_plan: "pro", ct_addon: "none", ct_seat_min: "1", ct_voice_minutes: "200", ct_minutes_basis: "user", ct_version: "1" };
const PRO_PRICE = {
  id: PRICES.pro.year!,
  type: "recurring",
  recurring: { usage_type: "licensed", interval: "year" },
  product: { metadata: PRO_META },
};
const WHSEC = "whsec_test_placeholder";
const ANCHOR = new Date("2026-03-10T09:30:00Z");

const sign = (raw: string, t = Math.floor(Date.now() / 1000), secret = WHSEC) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;

const event = (type: string, object: Record<string, unknown>, id: string, livemode: boolean) =>
  ({ id, type, livemode, data: { object } });

const checkout = (id: string, livemode: boolean) => event(
  "checkout.session.completed",
  { mode: "subscription", customer: "cus_test_1", subscription: "sub_test_1", metadata: { plan: "pro", userId: "owner-1" } },
  id,
  livemode,
);

const liveSub = {
  id: "sub_test_1",
  customer: "cus_test_1",
  status: "active",
  metadata: { plan: "pro", userId: "owner-1" },
  items: { data: [{ quantity: 1, price: PRO_PRICE }] },
};

let fake: ReturnType<typeof createFakePrisma>;
const user = () => fake.rows("user").find((u) => u.id === "owner-1")!;
const liveStripe = new Map<string, unknown>();

function deliver(e: unknown, header?: string | null) {
  const raw = JSON.stringify(e);
  return webhook(new NextRequest("http://localhost/api/stripe/webhook", {
    method: "POST",
    body: raw,
    headers: header === null ? {} : { "stripe-signature": header ?? sign(raw) },
  }));
}

function stubAllowlist() {
  for (const slot of ["pro", "team", "premium"] as const) {
    for (const i of ["month", "year"] as const) vi.stubEnv(PRICE_ENV[slot][i], PRICES[slot][i]!);
  }
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  liveStripe.clear();
  liveStripe.set("sub_test_1", liveSub);
  fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-02-20T00:00:00Z") });
  fake.seed("user", { id: "owner-1", email: "owner-1@example.test", organizationId: "org-1", role: "owner", usageAnchorAt: ANCHOR });
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_LIVE_MODE", "");
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", WHSEC);
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  resetPriceCache();
  stubAllowlist();
  vi.spyOn(stripeApi, "retrieveSubscription").mockImplementation(async (id: string) => {
    if (!liveStripe.has(id)) throw new StripeApiError(404);
    return liveStripe.get(id);
  });
  vi.spyOn(stripeApi, "cancelSubscription").mockResolvedValue({ id: "" });
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("stripe-webhook-mode-dup tests must not call fetch");
  }));
  setBillingEventSink(null);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setBillingEventSink(null);
});

describe("livemode mismatch does not occupy the event id", () => {
  it("a live event on a test server is ignored with an empty stripeEvent table", async () => {
    const before = JSON.stringify(user());
    const res = await deliver(checkout("evt_live_on_test", true));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: "mode_mismatch" });
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(stripeApi.retrieveSubscription).not.toHaveBeenCalled();
    expect(JSON.stringify(user())).toBe(before);
  });

  it("a test event on a live server is ignored with an empty stripeEvent table", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder");
    vi.stubEnv("STRIPE_LIVE_MODE", "true");
    const before = JSON.stringify(user());
    const res = await deliver(checkout("evt_test_on_live", false));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ received: true, ignored: "mode_mismatch" });
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(stripeApi.retrieveSubscription).not.toHaveBeenCalled();
    expect(JSON.stringify(user())).toBe(before);
  });

  it("a bad signature is 400 even when livemode already mismatches, so mode is not a shortcut", async () => {
    const e = checkout("evt_bad_sig_live", true);
    const res = await deliver(e, "t=1,v1=deadbeef");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_signature" });
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(stripeApi.retrieveSubscription).not.toHaveBeenCalled();
    expect(user().planTier).toBe("free");
  });

  it("the same event id still processes after a mismatch once livemode matches", async () => {
    const id = "evt_mismatch_then_ok";
    const ignored = await deliver(checkout(id, true));
    expect(ignored.status).toBe(200);
    expect(await ignored.json()).toMatchObject({ ignored: "mode_mismatch" });
    expect(fake.rows("stripeEvent")).toHaveLength(0);
    expect(user().planTier).toBe("free");

    const ok = await deliver(checkout(id, false));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ received: true, result: "processed" });
    expect(user().planTier).toBe("pro");
    expect(fake.rows("stripeEvent").map((r) => r.id)).toEqual([id]);
    expect(stripeApi.retrieveSubscription).toHaveBeenCalledWith("sub_test_1");
  });

  it("a mismatch replay after a processed event does not change the plan or store a second row", async () => {
    const id = "evt_ok_then_mismatch";
    expect((await (await deliver(checkout(id, false))).json()).result).toBe("processed");
    expect(user().planTier).toBe("pro");
    const retrieves = vi.mocked(stripeApi.retrieveSubscription).mock.calls.length;

    user().planTier = "team";
    const replay = await deliver(checkout(id, true));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ received: true, ignored: "mode_mismatch" });
    expect(user().planTier).toBe("team");
    expect(fake.rows("stripeEvent")).toHaveLength(1);
    expect(vi.mocked(stripeApi.retrieveSubscription).mock.calls.length).toBe(retrieves);
  });

  it("a matching-mode redelivery after process is duplicate and does not undo a later plan change", async () => {
    const id = "evt_dup_after_ok";
    const e = checkout(id, false);
    expect((await (await deliver(e)).json()).result).toBe("processed");
    user().planTier = "free";
    const again = await deliver(e);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ received: true, result: "duplicate" });
    expect(user().planTier).toBe("free");
    expect(fake.rows("stripeEvent")).toHaveLength(1);
  });
});
