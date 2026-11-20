import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { capabilities: null as unknown, isAuthenticated: false, register: vi.fn() }, query: "plan=pro&interval=year&src=pricing" }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(mocks.query),
}));

import RegisterPage from "@/app/register/page";

const html = () => renderToStaticMarkup(createElement(RegisterPage));
const submitDisabled = (h: string) => /<button[^>]*class="btn-primary w-full"[^>]*disabled|<button[^>]*disabled[^>]*class="btn-primary w-full"/.test(h);

beforeEach(() => {
  mocks.auth = { capabilities: null, isAuthenticated: false, register: vi.fn() };
  mocks.query = "plan=pro&interval=year&src=pricing";
});

describe("register page plan summary", () => {
  it("shows Pro yearly with the yearly price", () => {
    const h = html();
    expect(h).toContain("Pro, Annual");
    expect(h).toContain("$290/yr");
  });

  it("shows Team monthly differently, with the seat minimum", () => {
    mocks.query = "plan=team&interval=month";
    const h = html();
    expect(h).toContain("Team, Monthly");
    expect(h).toContain("$59/seat/mo");
    expect(h).toContain("3 seats minimum");
  });

  it("shows no summary without a valid plan", () => {
    for (const q of ["", "plan=gold&interval=weekly", "interval=year"]) {
      mocks.query = q;
      expect(html()).not.toContain("Your plan");
    }
  });
});

describe("register page before /api/config answers", () => {
  it("disables Create account until the billing state is known", () => {
    expect(submitDisabled(html())).toBe(true);
  });

  it("stays enabled when /api/config answered with an error (access gate, no cookie), so sign-up is not blocked", () => {
    mocks.auth = { ...mocks.auth, capabilities: null, capabilitiesFailed: true } as typeof mocks.auth;
    expect(submitDisabled(html())).toBe(false);
  });

  it("enables it once capabilities are loaded, billing on or off", () => {
    for (const billing of [true, false]) {
      mocks.auth = { ...mocks.auth, capabilities: { billing, database: true, demoMode: false } };
      expect(submitDisabled(html())).toBe(false);
    }
  });
});

describe("register page team invite link", () => {
  it("opens on Join a team with the code filled in, and tells the rep to use email", () => {
    mocks.query = "code=123456";
    const h = html();
    expect(h).toContain("Joining a team: sign up with your email below. Google sign-up starts a separate team.");
    expect(h).toMatch(/aria-pressed="true"[^>]*>Join a team<|>Join a team<\/button>/);
    expect(h).toContain('id="code"');
    expect(h).toContain('value="123456"');
    expect(h).not.toContain('id="org"');
    expect(h).not.toContain("/api/auth/google/start");
  });

  it("keeps a plan summary when the invite link also carries a whitelisted plan", () => {
    mocks.query = "code=482917&plan=pro&interval=year&src=pricing";
    const h = html();
    expect(h).toContain("Pro, Annual");
    expect(h).toContain('value="482917"');
    expect(h).toContain("Joining a team: sign up with your email below. Google sign-up starts a separate team.");
  });

  it("ignores a code that is not 3 to 8 digits, so nothing else can ride in the query", () => {
    for (const q of ["code=12", "code=123456789", "code=abc123", "code=12345a", "code=1234-56", "code=1234%3Cx%3E"]) {
      mocks.query = q;
      const h = html();
      expect(h, q).not.toContain("Joining a team:");
      expect(h, q).toContain('id="org"');
      expect(h, q).not.toContain('id="code"');
    }
  });
});
