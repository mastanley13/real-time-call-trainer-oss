import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: "" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ capabilities: { billing: false, database: true, demoMode: false }, isAuthenticated: false, register: vi.fn() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));
vi.mock("@/components/GoogleButton", () => ({ default: () => null }));

import RegisterPage from "@/app/register/page";
import { defaultOrgName, ORG_NAME_MAX } from "@/lib/orgName";
import { signInHref } from "@/lib/safeNext";

const TRY_NEXT = "/trainer?scenario=auto-inbound-used-crossover-lead&mode=text";
const html = () => renderToStaticMarkup(createElement(RegisterPage));
const signInLink = (h: string) => /href="([^"]*)"[^>]*>Sign in</.exec(h)?.[1]?.replace(/&amp;/g, "&");

beforeEach(() => { mocks.query = ""; });

describe("defaultOrgName", () => {
  it("is \"<firstName>'s workspace\" with the name trimmed", () => {
    expect(defaultOrgName("Mia")).toBe("Mia's workspace");
    expect(defaultOrgName("  Ravi \t")).toBe("Ravi's workspace");
  });

  it("falls back to \"My workspace\" for a blank or missing name", () => {
    for (const v of ["", "   ", null, undefined]) expect(defaultOrgName(v)).toBe("My workspace");
  });

  it("stays within the 120-character limit", () => {
    const long = defaultOrgName("a".repeat(500));
    expect(long.length).toBe(ORG_NAME_MAX);
    expect(long.endsWith("'s workspace")).toBe(true);
  });
});

describe("signInHref", () => {
  it("carries a safe next, encoded", () => {
    expect(signInHref(TRY_NEXT)).toBe(`/login?next=${encodeURIComponent(TRY_NEXT)}`);
    expect(signInHref("/library")).toBe("/login?next=%2Flibrary");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com", "javascript:alert(1)", "/\t/evil.com", "", null, undefined])(
    "drops an unsafe or missing next (%j)",
    (bad) => {
      expect(signInHref(bad)).toBe("/login");
    },
  );
});

describe("register page for a solo rep", () => {
  it("shows the solo-friendly subtitle and an optional team name", () => {
    const h = html();
    expect(h).toContain("Practice on your own, start a team, or join one with a code.");
    expect(h).not.toContain("Start a team workspace");
    expect(h).toContain("Team name (optional)");
    const orgInput = /<input[^>]*id="org"[^>]*>/.exec(h)?.[0] ?? "";
    expect(orgInput).not.toBe("");
    expect(orgInput).not.toMatch(/\brequired\b/);
  });

  it("links Sign in with the safe next", () => {
    mocks.query = new URLSearchParams({ next: TRY_NEXT }).toString();
    expect(signInLink(html())).toBe(`/login?next=${encodeURIComponent(TRY_NEXT)}`);
  });

  it.each(["next=%2F%2Fevil.com", "next=https%3A%2F%2Fevil.com", ""])("links plain /login for ?%s", (q) => {
    mocks.query = q;
    expect(signInLink(html())).toBe("/login");
  });
});
