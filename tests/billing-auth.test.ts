import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

/**
 * Checkout and portal run the real session check (test-only JWT). billing.test.ts stubs requireAuth as always-ok,
 * so a missing or forged cookie never reached those routes there.
 */
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma> }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rateLimit")>()),
  ipLimitResponse: () => null,
  userLimitResponse: () => null,
}));

import { signSessionToken } from "@/lib/auth";
import { stripeApi } from "@/lib/stripe";
import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";

const JWT = "fixture-only-not-a-secret-0123456789abcdef";
const ANCHOR = new Date("2026-03-10T09:30:00Z");

let fake: ReturnType<typeof createFakePrisma>;
let n = 0;

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
  vi.stubEnv("JWT_SECRET", JWT);
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("STRIPE_LIVE_MODE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const cookie = (id: string, role: "trainee" | "manager" | "owner" = "trainee") =>
  `authToken=${signSessionToken({ id, email: `${id}@example.test`, role })}`;

const checkoutPost = (headers: Record<string, string> = {}, body: unknown = { plan: "pro", interval: "month" }) =>
  checkout(new NextRequest("http://localhost/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${(++n % 200) + 1}`, ...headers },
  }));

const portalPost = (headers: Record<string, string> = {}) =>
  portal(new NextRequest("http://localhost/api/billing/portal", {
    method: "POST",
    headers: { "x-forwarded-for": `203.0.113.${(++n % 200) + 1}`, ...headers },
  }));

describe("POST /api/billing/checkout authentication", () => {
  it("no cookie: 401 and Stripe is not called, even with billing unset", async () => {
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await checkoutPost();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Authentication required");
    expect(create).not.toHaveBeenCalled();
  });

  it("a forged cookie: 401 Invalid or expired session", async () => {
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await checkoutPost({ cookie: "authToken=not-a-session" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid or expired session");
    expect(create).not.toHaveBeenCalled();
  });

  it("a signed-in user with billing unset: 503 billing_not_configured, still no Stripe session", async () => {
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await checkoutPost({ cookie: cookie("u-1") });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("billing_not_configured");
    expect(create).not.toHaveBeenCalled();
  });

  it("a signed-in user whose row is gone: 404, Stripe is not called", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await checkoutPost({ cookie: cookie("missing-user") });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(create).not.toHaveBeenCalled();
  });

  it("a trainee cannot buy a Team plan: 403, Stripe is not called", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    fake.seed("organization", { id: "org-1", code: "123", createdAt: ANCHOR });
    fake.seed("user", { id: "u-trainee", email: "u-trainee@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: ANCHOR });
    const create = vi.spyOn(stripeApi, "createCheckoutSession");
    const res = await checkoutPost({ cookie: cookie("u-trainee", "trainee") }, { plan: "team", interval: "month", seats: 3 });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/portal authentication", () => {
  it("no cookie: 401 and the portal is not opened, even with billing unset", async () => {
    const create = vi.spyOn(stripeApi, "createPortalSession");
    const res = await portalPost();
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Authentication required");
    expect(create).not.toHaveBeenCalled();
  });

  it("a forged cookie: 401", async () => {
    const create = vi.spyOn(stripeApi, "createPortalSession");
    const res = await portalPost({ cookie: "authToken=not-a-session" });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid or expired session");
    expect(create).not.toHaveBeenCalled();
  });

  it("a signed-in user with billing unset: 503 billing_not_configured", async () => {
    const create = vi.spyOn(stripeApi, "createPortalSession");
    const res = await portalPost({ cookie: cookie("u-1") });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("billing_not_configured");
    expect(create).not.toHaveBeenCalled();
  });

  it("a signed-in user with no Stripe customer: 404 no_billing_account", async () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    fake.seed("organization", { id: "org-1", code: "123", createdAt: ANCHOR });
    fake.seed("user", { id: "u-1", email: "u-1@example.test", organizationId: "org-1", role: "trainee", usageAnchorAt: ANCHOR });
    const create = vi.spyOn(stripeApi, "createPortalSession");
    const res = await portalPost({ cookie: cookie("u-1") });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("no_billing_account");
    expect(create).not.toHaveBeenCalled();
  });
});
