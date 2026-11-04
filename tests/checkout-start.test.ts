import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BILLING_NOTICE_PATH, NOTICE_TEXT, afterSignin, checkoutBody, intentFromQuery, rememberNotice, startCheckout, takeNotice,
} from "@/lib/checkoutStart";

const answer = (status: number, body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
const sentBody = (f: ReturnType<typeof vi.fn>) => JSON.parse(f.mock.calls[0][1].body as string);

describe("startCheckout", () => {
  it("200 redirects to the returned Stripe URL", async () => {
    const f = answer(200, { url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(await startCheckout({ plan: "pro", interval: "year" }, f as unknown as typeof fetch)).toEqual({ kind: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test_1" });
    expect(f.mock.calls[0][0]).toBe("/api/billing/checkout");
  });

  it("never follows a non-https or missing url", async () => {
    for (const url of ["http://evil.example/x", "javascript:alert(1)", undefined]) {
      const out = await startCheckout({ plan: "pro", interval: "month" }, answer(200, { url }) as unknown as typeof fetch);
      expect(out).toEqual({ kind: "unavailable" });
    }
  });

  it("409 already_subscribed goes to billing settings", async () => {
    const out = await startCheckout({ plan: "pro", interval: "month" }, answer(409, { error: "already_subscribed", status: "active" }) as unknown as typeof fetch);
    expect(out).toEqual({ kind: "already_subscribed" });
    expect(BILLING_NOTICE_PATH).toBe("/settings/billing?notice=already_subscribed");
  });

  it("503 billing_not_configured and 422 price_not_configured fall back to Free", async () => {
    expect(await startCheckout({ plan: "pro", interval: "month" }, answer(503, { error: "billing_not_configured" }) as unknown as typeof fetch)).toEqual({ kind: "unavailable" });
    expect(await startCheckout({ plan: "team", interval: "month" }, answer(422, { error: "price_not_configured" }) as unknown as typeof fetch)).toEqual({ kind: "unavailable" });
  });

  it("every other non-2xx falls back to Free, whatever the body", async () => {
    for (const [status, error] of [[400, "invalid_request"], [400, "premium_not_available"], [401, "unauthorized"], [403, "forbidden"], [409, "checkout_in_progress"], [429, "rate_limited"], [500, "boom"], [502, "stripe_error"]] as const) {
      const out = await startCheckout({ plan: "team", interval: "month", seats: 3 }, answer(status, { error, message: "x" }) as unknown as typeof fetch);
      expect(out, `${status} ${error}`).toEqual({ kind: "unavailable" });
    }
    // A 409 that is not already_subscribed is not the "you already have a plan" case.
    expect(await startCheckout({ plan: "pro", interval: "month" }, answer(409, {}) as unknown as typeof fetch)).toEqual({ kind: "unavailable" });
  });

  it("a request that got no answer at all keeps the page with a retry", async () => {
    const net = await startCheckout({ plan: "pro", interval: "month" }, vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch);
    expect(net).toMatchObject({ kind: "error", help: false });
  });

  it("sends premium:false always, and seats 3 for Team by default", async () => {
    const team = answer(200, { url: "https://checkout.stripe.com/x" });
    await startCheckout({ plan: "team", interval: "year" }, team as unknown as typeof fetch);
    expect(sentBody(team)).toEqual({ plan: "team", interval: "year", premium: false, seats: 3 });
    const pro = answer(200, { url: "https://checkout.stripe.com/x" });
    await startCheckout({ plan: "pro", interval: "month", seats: 9 }, pro as unknown as typeof fetch);
    expect(sentBody(pro)).toEqual({ plan: "pro", interval: "month", premium: false });
  });
});

describe("checkoutBody seats", () => {
  it("keeps Team at 3 or more and passes a larger count through", () => {
    expect(checkoutBody({ plan: "team", interval: "month", seats: 1 }).seats).toBe(3);
    expect(checkoutBody({ plan: "team", interval: "month", seats: Number.NaN }).seats).toBe(3);
    expect(checkoutBody({ plan: "team", interval: "month", seats: 8 }).seats).toBe(8);
  });
});

describe("register link intent", () => {
  it("reads and whitelists the query", () => {
    expect(intentFromQuery(new URLSearchParams("plan=team&interval=year&src=pricing&seg=saas"))).toEqual({ plan: "team", interval: "year", src: "pricing", seg: "saas" });
    expect(intentFromQuery(new URLSearchParams(`plan=enterprise&src=${"x".repeat(500)}&seg=<script>`))).toEqual({});
  });

  it("billing off lands on /trainer, with the notice only when a plan was asked for", () => {
    expect(afterSignin(false, { plan: "pro", interval: "year", src: "pricing" })).toEqual({ path: "/trainer", notice: "plans_soon" });
    expect(afterSignin(false, { src: "pricing" })).toEqual({ path: "/trainer", notice: null });
  });

  it("billing on goes to the checkout step with the plan and period, for new and signed-in users alike", () => {
    expect(afterSignin(true, { plan: "team", interval: "year" })).toEqual({ path: "/checkout/start?plan=team&interval=year", notice: null });
    expect(afterSignin(true, { plan: "pro" })).toEqual({ path: "/checkout/start?plan=pro&interval=month", notice: null });
    expect(afterSignin(true, {})).toEqual({ path: "/trainer", notice: null });
  });

  it("the register page forwards the whitelisted intent in the sign-up POST and uses afterSignin for both paths", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toContain("...intent,");
    expect(src).toContain("intentFromQuery(useSearchParams())");
    expect(src.match(/goAfterSignin\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    expect(src).not.toContain('router.replace("/trainer")');
  });
});

describe("one-time notice", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
  };

  it("shows once, then is gone", () => {
    const s = memory();
    rememberNotice("plans_soon", s);
    expect(takeNotice(s)).toBe("plans_soon");
    expect(takeNotice(s)).toBeNull();
  });

  it("ignores an unknown stored value", () => {
    const s = memory();
    s.setItem("ct.notice", "<b>hi</b>");
    expect(takeNotice(s)).toBeNull();
  });

  it("uses the approved wording", () => {
    expect(NOTICE_TEXT.plans_soon).toBe("You're on Free. Pro and Team open soon.");
    expect(NOTICE_TEXT.paid_soon).toBe("Paid plans open soon. You're on Free.");
  });
});
