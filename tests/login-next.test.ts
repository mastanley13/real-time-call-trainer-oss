// Why source checks: the repo has no DOM test library (no @testing-library, jsdom or happy-dom) and adding one is out of
// scope, so effects and submit handlers cannot run here. The routing decisions live in pure helpers in
// src/lib/safeNext.ts (tested directly below); the page tests check, from its source, that every post-sign-in
// navigation goes through those helpers, and render it once to check the Google button's next.
import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({ login: vi.fn(), completeMfaChallenge: vi.fn(), isAuthenticated: false, capabilities: { database: true, demoMode: false } }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));
// The real button renders nothing until /api/auth/google/status answers, so this stand-in shows the next it was given.
vi.mock("@/components/GoogleButton", () => ({
  GOOGLE_ERRORS: { google_failed: "Google sign-in failed." },
  default: ({ next }: { next?: string }) => createElement("a", { "data-testid": "google", "data-next": next ?? "(none)" }, "Google"),
}));

import LoginPage from "@/app/login/page";
import { loginDestination } from "@/lib/safeNext";

const TRY_NEXT = "/trainer?scenario=auto-inbound-used-crossover-lead&mode=text";
const html = () => renderToStaticMarkup(createElement(LoginPage));
const googleNext = (h: string) => /data-next="([^"]*)"/.exec(h)?.[1]?.replace(/&amp;/g, "&");
const SRC = readFileSync("src/app/login/page.tsx", "utf8");

/** The body of onSubmit, from its signature to the catch. */
function onSubmitBody(): string {
  const m = /async function onSubmit\(e: FormEvent\) \{([\s\S]*?)\} catch \(err\)/.exec(SRC);
  expect(m, "onSubmit not found in src/app/login/page.tsx").not.toBeNull();
  return m![1];
}

beforeEach(() => { mocks.query = ""; });

describe("loginDestination", () => {
  it("keeps safe same-site paths", () => {
    expect(loginDestination(TRY_NEXT)).toBe(TRY_NEXT);
    expect(loginDestination("/library")).toBe("/library");
  });

  it.each([
    "//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "JavaScript:alert(1)",
    "/\t/evil.com", "/\r\n/evil.com", "trainer", "", null, undefined, "/" + "a".repeat(250),
  ])("sends %j to /trainer", (bad) => {
    expect(loginDestination(bad)).toBe("/trainer");
  });
});

describe("login page source", () => {
  it("derives the destination from the current search params on every render, with no stored next", () => {
    expect(SRC).toContain('const nextParam = useSearchParams().get("next");');
    expect(SRC).toContain("const destination = loginDestination(nextParam);");
    expect(SRC).toContain("<GoogleButton next={validNextPath(nextParam) ?? undefined} />");
    // No state copy of next that could go stale on a client-side move to /login or /login?next=.
    expect(SRC).not.toMatch(/useState\([^)]*[Nn]ext/);
    expect(SRC).not.toMatch(/rawNext|nextFromQuery|followedNext/);
  });

  it("the Google-return cleanup clears error and the fragment but keeps a validated next", () => {
    const effect = /useEffect\(\(\) => \{\s*const url = new URL\(window\.location\.href\);([\s\S]*?)\}, \[\]\);/.exec(SRC)?.[1];
    expect(effect, "Google-return effect not found").toBeTruthy();
    expect(effect).toContain('const keepNext = validNextPath(url.searchParams.get("next"));');
    expect(effect).toContain(
      'if (err || mfa || reset) window.history.replaceState(null, "", keepNext ? `${url.pathname}?next=${encodeURIComponent(keepNext)}` : url.pathname);',
    );
    // Only that one replaceState, and nothing else from the old query or the hash is copied into the URL.
    expect(effect!.match(/replaceState\(/g)).toHaveLength(1);
    expect(effect).not.toMatch(/url\.search\b|url\.hash\b[^.]|url\.href/);
  });

  it("the already-signed-in effect replaces to destination", () => {
    expect(SRC).toMatch(/useEffect\(\(\) => \{\s*if \(isAuthenticated\) router\.replace\(destination\);\s*\}, \[isAuthenticated, router, destination\]\);/);
  });

  it("onSubmit has exactly one navigation, router.push(destination), reached after both completeMfaChallenge and the password login", () => {
    const body = onSubmitBody();
    expect(body.match(/router\.(push|replace)\(/g)).toEqual(["router.push("]);
    // The MFA branch and the password branch close, then the single push runs for both.
    // completeMfaChallenge may take a third argument: the authenticator or recovery code choice.
    expect(body).toMatch(
      /if \(challenge\) \{\s*await completeMfaChallenge\(challenge, code(?:, [^;]*)?\);\s*\} else \{\s*const mfa = await login\(\{ email, password \}\);\s*if \(mfa\) \{[^}]*return; \}\s*\}\s*router\.push\(destination\);/,
    );
  });

  it("a recovery code goes through the same completeMfaChallenge call, so it lands on the same safe destination", () => {
    const body = onSubmitBody();
    expect(body.match(/completeMfaChallenge\(/g)).toHaveLength(1);
    expect(body).toMatch(/completeMfaChallenge\(challenge, code, useRecovery \? "recovery" : "totp"\)/);
  });

  it("has only those two navigations and no hardcoded /trainer", () => {
    expect(SRC.match(/router\.(push|replace)\([^)]*\)/g)).toEqual(["router.replace(destination)", "router.push(destination)"]);
    expect(SRC).not.toMatch(/["'`]\/trainer/);
  });
});

describe("login page render", () => {
  it("passes a safe next to the Google button", () => {
    mocks.query = new URLSearchParams({ next: TRY_NEXT }).toString();
    expect(googleNext(html())).toBe(TRY_NEXT);
  });

  it.each(["next=%2F%2Fevil.com", "next=https%3A%2F%2Fevil.com", "next=%2F%5Cevil.com", "next=javascript%3Aalert(1)", ""])(
    "passes no next to the Google button for ?%s",
    (q) => {
      mocks.query = q;
      expect(googleNext(html())).toBe("(none)");
    },
  );
});
