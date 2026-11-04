import { describe, expect, it } from "vitest";
import { cleanSignupIntent, googleLandingPath, parseSignupIntent, signupIntentQuery } from "@/lib/signupIntent";

const from = (qs: string) => {
  const sp = new URLSearchParams(qs);
  return parseSignupIntent((k) => sp.get(k));
};

describe("sign-up intent", () => {
  it("round-trips through the query string in a fixed order", () => {
    const intent = from("src=pricing&plan=pro&seg=sdr&interval=year");
    expect(intent).toEqual({ plan: "pro", interval: "year", src: "pricing", seg: "sdr" });
    expect(signupIntentQuery(intent)).toBe("plan=pro&interval=year&src=pricing&seg=sdr");
    expect(from(signupIntentQuery(intent))).toEqual(intent);
  });
  it("drops unknown keys and invalid values", () => {
    expect(from("plan=gold&interval=week&src=a%20b&seg=%2F%2Fevil&next=/x")).toEqual({});
    expect(from("seg=" + "x".repeat(41))).toEqual({});
    expect(signupIntentQuery({})).toBe("");
  });
  it("cleans objects that came back from a cookie", () => {
    expect(cleanSignupIntent({ plan: "team", extra: "x", src: 5 })).toEqual({ plan: "team" });
    expect(cleanSignupIntent(null)).toEqual({});
  });
  it("lands new accounts on /trainer with the intent, and everyone else on next", () => {
    expect(googleLandingPath({ next: "/library", intent: { plan: "pro", interval: "month" } }, true)).toBe("/trainer?plan=pro&interval=month");
    expect(googleLandingPath({ next: "/library", intent: { plan: "pro" } }, false)).toBe("/library");
    expect(googleLandingPath({ next: "/library", intent: {} }, true)).toBe("/library");
    expect(googleLandingPath({ next: "//evil.example" }, true)).toBe("/trainer");
  });
});
