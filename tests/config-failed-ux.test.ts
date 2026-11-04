import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  focus: vi.fn(),
  forceRetrying: false,
  setters: [] as { init: unknown; value: unknown }[],
}));

// Server rendering skips effects and has no DOM, so run effects inline, hand out a fake heading ref, and record state setters.
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useEffect: (fn: () => void) => { fn(); },
    useRef: (init: unknown) => (init === null ? { current: { focus: mocks.focus } } : actual.useRef(init)),
    useState: (init: unknown) => {
      if (mocks.forceRetrying && init === false) return [true, vi.fn()];
      return [init, (value: unknown) => { mocks.setters.push({ init, value }); }];
    },
  };
});

import { ConfigFailed } from "@/components/CheckoutStartClient";
import { AuthProvider } from "@/contexts/AuthContext";
import { SEATS_MAX_NOTE, seatsOnBlur } from "@/lib/billingUi";
import SeatsField from "@/components/settings/SeatsField";

beforeEach(() => {
  mocks.focus.mockReset();
  mocks.forceRetrying = false;
  mocks.setters = [];
  vi.stubGlobal("window", { location: { reload: vi.fn() } });
});

describe("checkout config failure screen", () => {
  it("moves focus to a programmatically focusable heading on load", () => {
    const h = renderToStaticMarkup(createElement(ConfigFailed));
    expect(h).toMatch(/<h1[^>]*tabindex="-1"/i);
    expect(mocks.focus).toHaveBeenCalledTimes(1);
  });

  it("shows a disabled, busy Trying again button while retrying", () => {
    mocks.forceRetrying = true;
    const h = renderToStaticMarkup(createElement(ConfigFailed));
    expect(h).toContain("Trying again...");
    expect(h).toMatch(/<button[^>]*disabled/);
    expect(h).toContain('aria-busy="true"');
  });

  it("wraps long text instead of scrolling sideways", () => {
    const h = renderToStaticMarkup(createElement(ConfigFailed));
    expect(h).toContain("min-w-0");
    expect(h).toContain("break-words");
  });
});

describe("AuthProvider when the config request cannot be made", () => {
  it("marks capabilities as failed instead of defaulting billing off", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() });
    renderToStaticMarkup(createElement(AuthProvider, null, null));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.setters).toContainEqual({ init: false, value: true });
    expect(mocks.setters).toContainEqual({ init: null, value: null });
    expect(mocks.setters.some((s) => typeof s.value === "object" && s.value !== null && "demoMode" in s.value)).toBe(false);
  });
});

describe("seat count above the maximum", () => {
  it("explains the clamp", () => {
    expect(seatsOnBlur("600")).toEqual({ value: "500", note: SEATS_MAX_NOTE });
    expect(SEATS_MAX_NOTE).toBe("Team plans go up to 500 seats here. Contact us for more.");
    expect(seatsOnBlur("500").note).toBeNull();
  });

  it("ties the note to the input in a polite live region", () => {
    const h = renderToStaticMarkup(createElement(SeatsField, { value: "500", note: SEATS_MAX_NOTE, onChange: () => {}, onBlur: () => {} }));
    expect(h).toContain('aria-describedby="seats-help seats-note"');
    expect(h).toMatch(/id="seats-note"[^>]*aria-live="polite"/);
    expect(h).toContain(SEATS_MAX_NOTE);
  });
});
