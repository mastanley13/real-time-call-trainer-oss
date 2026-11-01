import { describe, expect, it } from "vitest";
import { checkoutStartHref, PREMIUM_COMING_SOON, registerHref, sanitizeSignupIntent } from "@/lib/pricing";

describe("sanitizeSignupIntent", () => {
  it("keeps whitelisted values", () => {
    expect(sanitizeSignupIntent({ plan: "team", interval: "year", src: "pricing", seg: "insurance" })).toEqual({ plan: "team", interval: "year", src: "pricing", seg: "insurance" });
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
