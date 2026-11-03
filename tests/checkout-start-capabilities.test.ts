import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {} as Record<string, unknown>,
  replace: vi.fn(),
  startCheckout: vi.fn(),
}));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, push: vi.fn() }),
  useSearchParams: () => new URLSearchParams("plan=pro&interval=year"),
}));
// Server rendering skips effects, so run them inline to exercise the redirect logic.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (fn: () => void) => { fn(); } }));
vi.mock("@/lib/checkoutStart", async (orig) => ({ ...(await orig<typeof import("@/lib/checkoutStart")>()), startCheckout: mocks.startCheckout }));

import CheckoutStartClient from "@/components/CheckoutStartClient";

const html = () => renderToStaticMarkup(createElement(CheckoutStartClient));

beforeEach(() => {
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { assign: vi.fn(), reload: vi.fn() } });
  mocks.replace.mockReset();
  mocks.startCheckout.mockReset();
  mocks.auth = { isAuthenticated: true, isLoading: false, capabilities: null, capabilitiesFailed: true };
});

describe("checkout when /api/config failed", () => {
  it("shows a retry state for a signed-in user and never starts checkout", () => {
    const h = html();
    expect(h).toContain("Checkout could not load right now");
    expect(h).toContain("Try again");
    expect(h).toContain('href="/pricing"');
    expect(mocks.startCheckout).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("sends a signed-out user to register", () => {
    mocks.auth = { ...mocks.auth, isAuthenticated: false };
    html();
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace.mock.calls[0][0]).toContain("/register");
    expect(mocks.startCheckout).not.toHaveBeenCalled();
  });

  it("keeps the skeleton while config is still loading", () => {
    mocks.auth = { ...mocks.auth, capabilitiesFailed: false };
    expect(html()).not.toContain("could not load");
    expect(mocks.replace).not.toHaveBeenCalled();
  });
});
