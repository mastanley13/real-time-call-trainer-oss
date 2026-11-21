import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ capabilities: { billing: false, database: true, demoMode: false }, isAuthenticated: false, register: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));
// The real button renders nothing until /api/auth/google/status answers, so this stand-in shows the next it was given.
vi.mock("@/components/GoogleButton", () => ({
  default: ({ next }: { next?: string }) => createElement("a", { "data-testid": "google", "data-next": next ?? "(none)" }, "Google"),
}));

import RegisterPage from "@/app/register/page";
import { afterSignin, afterSigninTo } from "@/lib/checkoutStart";
import { checkoutStartHref } from "@/lib/pricing";
import { validNextPath } from "@/lib/safeNext";

const TRY_NEXT = "/trainer?scenario=auto-inbound-used-crossover-lead&mode=text";

/** Unsafe next values, as they arrive after URLSearchParams decoding. */
const UNSAFE = [
  "https://evil.example", "http://evil.example/trainer", "//evil.example", "///evil.example", "/\\evil.example", "\\\\evil.example",
  "javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,x", "trainer", "", " /trainer",
  "/\t/evil.example", "/\n/evil.example", "/\r\n/evil.example", "/\u0000/evil.example",
  decodeURIComponent("%2F%09%2Fevil.example"), decodeURIComponent("%2F%5Cevil.example"), decodeURIComponent("%2F%2Fevil.example"),
  // Double-encoded: one decode leaves "%2F%2F...", which does not start with "/".
  decodeURIComponent("%252F%252Fevil.example"),
  "/" + "a".repeat(250),
];

const googleNext = (h: string) => /data-next="([^"]*)"/.exec(h)?.[1]?.replace(/&amp;/g, "&");
const html = () => renderToStaticMarkup(createElement(RegisterPage));

beforeEach(() => { mocks.query = ""; });

describe("validNextPath", () => {
  it("keeps the /try landing next", () => {
    expect(validNextPath(TRY_NEXT)).toBe(TRY_NEXT);
    expect(validNextPath("/library")).toBe("/library");
  });
  it.each(UNSAFE.map((v) => [JSON.stringify(v), v]))("rejects %s", (_, bad) => {
    expect(validNextPath(bad)).toBeNull();
  });
  it("rejects missing values", () => {
    expect(validNextPath(null)).toBeNull();
    expect(validNextPath(undefined)).toBeNull();
  });
});

describe("afterSigninTo", () => {
  it("honors a safe next after sign-up", () => {
    expect(afterSigninTo(false, {}, TRY_NEXT)).toEqual({ path: TRY_NEXT, notice: null });
    expect(afterSigninTo(true, {}, TRY_NEXT)).toEqual({ path: TRY_NEXT, notice: null });
  });

  it.each(UNSAFE.map((v) => [JSON.stringify(v), v]))("falls back to the normal destination for %s", (_, bad) => {
    expect(afterSigninTo(false, {}, bad)).toEqual({ path: "/trainer", notice: null });
    expect(afterSigninTo(true, {}, bad)).toEqual(afterSignin(true, {}));
  });

  it("is afterSignin exactly when next is absent", () => {
    for (const billing of [true, false]) {
      for (const intent of [{}, { plan: "pro" as const, interval: "year" as const }, { plan: "team" as const }, { src: "pricing" }]) {
        expect(afterSigninTo(billing, intent, null)).toEqual(afterSignin(billing, intent));
        expect(afterSigninTo(billing, intent, undefined)).toEqual(afterSignin(billing, intent));
      }
    }
  });

  it("never lets a next take over a paid plan checkout while billing is on", () => {
    expect(afterSigninTo(true, { plan: "pro", interval: "year" }, TRY_NEXT)).toEqual({ path: checkoutStartHref("pro", "year"), notice: null });
    expect(afterSigninTo(true, { plan: "team" }, TRY_NEXT)).toEqual({ path: checkoutStartHref("team", "month"), notice: null });
  });

  it("with a plan but billing off, goes to the safe next and keeps the open-soon notice", () => {
    expect(afterSigninTo(false, { plan: "pro" }, TRY_NEXT)).toEqual({ path: TRY_NEXT, notice: "plans_soon" });
  });
});

describe("register page next", () => {
  it("passes a safe next to the Google button", () => {
    mocks.query = new URLSearchParams({ next: TRY_NEXT, utm_source: "email" }).toString();
    expect(googleNext(html())).toBe(TRY_NEXT);
  });

  it.each([
    "next=https%3A%2F%2Fevil.example", "next=%2F%2Fevil.example", "next=%2F%5Cevil.example", "next=%2F%09%2Fevil.example",
    "next=javascript%3Aalert(1)", "next=%252F%252Fevil.example", "next=%2F%0D%0A%2Fevil.example", "",
  ])("passes no next to the Google button for ?%s", (q) => {
    mocks.query = q;
    expect(googleNext(html())).toBe("(none)");
  });

  it("routes sign-up and the signed-in redirect through afterSigninTo with the raw next", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).toContain("afterSigninTo(billingEnabled, intent, rawNext)");
    expect(src).toContain("<GoogleButton carryIntent next={nextPath ?? undefined} />");
    expect(src).not.toMatch(/\bafterSignin\(/);
  });
});
