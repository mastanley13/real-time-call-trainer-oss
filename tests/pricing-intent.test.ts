import { describe, expect, it } from "vitest";
import { checkoutStartHref, PREMIUM_COMING_SOON, planSummary, registerHref, sanitizeSignupIntent } from "@/lib/pricing";

describe("sanitizeSignupIntent", () => {
  it("keeps whitelisted values", () => {
    expect(sanitizeSignupIntent({ plan: "team", interval: "year", src: "pricing", seg: "insurance" })).toEqual({ plan: "team", interval: "year", src: "pricing", seg: "insurance" });
  });

  it("maps interval aliases to month or year", () => {
    expect(sanitizeSignupIntent({ interval: "annual" }).interval).toBe("year");
    expect(sanitizeSignupIntent({ interval: "Yearly" }).interval).toBe("year");
    expect(sanitizeSignupIntent({ interval: "monthly" }).interval).toBe("month");
    expect(sanitizeSignupIntent({ interval: "weekly" })).toEqual({});
  });

  it("drops inherited property names as plan and interval", () => {
    for (const v of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(sanitizeSignupIntent({ plan: v, interval: v })).toEqual({});
    }
  });

  it("planSummary differs by plan and interval, and is null without a plan", () => {
    expect(planSummary({})).toBeNull();
    expect(planSummary({ plan: "pro", interval: "year" })).toEqual({ name: "Pro", periodLabel: "Annual", price: "$290/yr" });
    expect(planSummary({ plan: "pro" })?.price).toBe("$29/mo");
    const team = planSummary({ plan: "team", interval: "month" });
    expect(team).toMatchObject({ name: "Team", periodLabel: "Monthly", price: "$59/seat/mo" });
    expect(team?.seats).toContain("3 seats");
  });

  it("drops anything else", () => {
    expect(sanitizeSignupIntent({ plan: "enterprise", interval: "week", src: "<script>alert(1)</script>", seg: "a".repeat(500) })).toEqual({});
    expect(sanitizeSignupIntent({ src: "a".repeat(41) })).toEqual({});
    expect(sanitizeSignupIntent({ plan: ["pro"], src: 5, seg: null })).toEqual({});
  });

  it("lowercases tags and accepts exactly 40 chars", () => {
    expect(sanitizeSignupIntent({ src: "Pricing" })).toEqual({ src: "pricing" });
    expect(sanitizeSignupIntent({ src: "a".repeat(40) }).src).toHaveLength(40);
  });
});

describe("links and labels", () => {
  it("registerHref carries the interval only with a plan", () => {
    expect(registerHref({ plan: "pro", interval: "year", src: "pricing" })).toBe("/register?plan=pro&interval=year&src=pricing");
    expect(registerHref({ plan: "team", src: "pricing" })).toBe("/register?plan=team&src=pricing");
    expect(registerHref({ interval: "year", src: "pricing" })).toBe("/register?src=pricing");
  });

  it("checkoutStartHref", () => {
    expect(checkoutStartHref("team", "year")).toBe("/checkout/start?plan=team&interval=year");
  });

  it("uses the approved Premium label verbatim", () => {
    expect(PREMIUM_COMING_SOON).toBe("Coming soon (not on sale yet)");
  });
});
