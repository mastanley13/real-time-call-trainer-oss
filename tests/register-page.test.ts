import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: { capabilities: null as unknown, isAuthenticated: false, register: vi.fn() } }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("plan=pro&interval=year&src=pricing"),
}));

import RegisterPage from "@/app/register/page";

const html = () => renderToStaticMarkup(createElement(RegisterPage));
const submitDisabled = (h: string) => /<button[^>]*class="btn-primary w-full"[^>]*disabled|<button[^>]*disabled[^>]*class="btn-primary w-full"/.test(h);

beforeEach(() => {
  mocks.auth = { capabilities: null, isAuthenticated: false, register: vi.fn() };
});

describe("register page before /api/config answers", () => {
  it("disables Create account until the billing state is known", () => {
    expect(submitDisabled(html())).toBe(true);
  });

  it("enables it once capabilities are loaded, billing on or off", () => {
    for (const billing of [true, false]) {
      mocks.auth = { ...mocks.auth, capabilities: { billing, database: true, demoMode: false } };
      expect(submitDisabled(html())).toBe(false);
    }
  });
});
