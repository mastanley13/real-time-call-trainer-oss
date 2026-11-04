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
