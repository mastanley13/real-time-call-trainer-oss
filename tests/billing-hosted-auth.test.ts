import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import jwt from "jsonwebtoken";

/**
 * POST /api/billing/checkout and /api/billing/portal must refuse an unsigned request
 * before Stripe is touched. Most billing tests mock requireAuth, so they would not
 * notice if those two routes stopped calling it. This file runs the real helper.
 */

const mocks = vi.hoisted(() => ({
  prisma: {
    user: { findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { POST as checkout } from "@/app/api/billing/checkout/route";
import { POST as portal } from "@/app/api/billing/portal/route";
import { signMfaChallengeToken, signSessionToken } from "@/lib/auth";
import { stripeApi } from "@/lib/stripe";

const KEY = "test-secret-0123456789abcdef0123456789";

let n = 0;
const ip = () => `198.51.${Math.floor(++n / 250)}.${n % 250}`;

function hostedOff() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("ALLOW_PUBLIC_DEMO", "");
  vi.stubEnv("JWT_SECRET", KEY);
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("STRIPE_LIVE_MODE", "");
  vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
}

function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip(), ...extra },
    body: JSON.stringify(body),
  });
}

const checkoutBody = { plan: "pro" as const, interval: "month" as const };

beforeEach(() => {
  hostedOff();
  mocks.prisma.user.findUnique.mockReset().mockResolvedValue(null);
  vi.spyOn(stripeApi, "createCheckoutSession").mockResolvedValue({
    id: "cs_test_should_not_mint",
    url: "https://checkout.stripe.com/c/pay/cs_test_should_not_mint",
  });
  vi.spyOn(stripeApi, "createPortalSession").mockResolvedValue({
    url: "https://billing.stripe.com/p/session/test_should_not_open",
  });
  vi.spyOn(stripeApi, "retrievePrice").mockRejectedValue(new Error("hosted-auth tests must not retrieve prices"));
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("hosted-auth tests must not call fetch");
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/billing/checkout hosted auth", () => {
  it("returns 401 Authentication required without a session, and does not call Stripe", async () => {
    const res = await checkout(post("/api/billing/checkout", checkoutBody));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid or expired session for a garbage bearer token", async () => {
    const res = await checkout(post("/api/billing/checkout", checkoutBody, { authorization: "Bearer not-a-jwt" }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("returns 401 for an expired session cookie, and does not look the user up", async () => {
    const token = jwt.sign({ id: "u-rep", email: "rep@example.test" }, KEY, { expiresIn: -10 });
    const res = await checkout(post("/api/billing/checkout", checkoutBody, { cookie: `authToken=${token}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("refuses an MFA challenge token as a session, so the second login step cannot start checkout", async () => {
    const challenge = signMfaChallengeToken("u-rep");
    const res = await checkout(post("/api/billing/checkout", checkoutBody, { authorization: `Bearer ${challenge}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });

  it("a still-fresh session gets past auth (404 here because the account row is missing)", async () => {
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test", role: "owner" });
    const res = await checkout(post("/api/billing/checkout", checkoutBody, { cookie: `authToken=${token}` }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mocks.prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u-rep" },
      include: { organization: true },
    });
    expect(stripeApi.createCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("POST /api/billing/portal hosted auth", () => {
  it("returns 401 Authentication required without a session, and does not open a portal", async () => {
    const res = await portal(post("/api/billing/portal", {}));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
    expect(stripeApi.createPortalSession).not.toHaveBeenCalled();
    expect(mocks.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 401 Invalid or expired session for an expired cookie", async () => {
    const token = jwt.sign({ id: "u-rep", email: "rep@example.test" }, KEY, { expiresIn: -10 });
    const res = await portal(post("/api/billing/portal", {}, { cookie: `authToken=${token}` }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid or expired session" });
    expect(stripeApi.createPortalSession).not.toHaveBeenCalled();
  });

  it("a still-fresh session gets past auth (404 here because the account row is missing)", async () => {
    const token = signSessionToken({ id: "u-rep", email: "rep@example.test", role: "owner" });
    const res = await portal(post("/api/billing/portal", {}, { cookie: `authToken=${token}` }));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("not_found");
    expect(mocks.prisma.user.findUnique).toHaveBeenCalled();
    expect(stripeApi.createPortalSession).not.toHaveBeenCalled();
  });
});
