import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import MobileMenu from "@/components/MobileMenu";
import ComparePlans, { CompareFades, CompareHint } from "@/components/landing/ComparePlans";
import { FOCUSABLE_SELECTOR, MOBILE_MENU_ID, MOBILE_MENU_QUERY, closeMenu, dismissOutside, focusFirstLink, handleMenuKey, leaveMobileRange, menuButtonLabel } from "@/lib/mobileMenu";
import { NO_SCROLL_CUE, scrollCue } from "@/lib/scrollCue";

const items = [{ href: "/pricing", label: "Pricing", active: true }];
const menu = (guest: boolean) => renderToStaticMarkup(createElement(MobileMenu, { items, guest, pathname: "/pricing" }));

describe("mobile menu", () => {
  it("renders a closed 44px button with name, aria-expanded and aria-controls", () => {
    const html = menu(true);
    expect(html).toMatch(/<button[^>]*aria-label="Open menu"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(`aria-controls="${MOBILE_MENU_ID}"`);
    expect(html).toContain(`id="${MOBILE_MENU_ID}"`);
    expect(html).toMatch(/id="mobile-menu"[^>]*hidden/);
    expect(html).toContain("!min-h-[44px]");
    expect(html).toContain("!min-w-[44px]");
    expect(html).toContain("focus-visible:outline-primary");
  });

  it("only shows below 428px", () => {
    expect(menu(true)).toContain("hidden max-[427px]:block");
  });

  it("lists Pricing, Sign in and Get started for guests", () => {
    const html = menu(true);
    expect(html).toContain('href="/pricing"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/login"');
    expect(html).toContain(">Get started<");
  });

  it("omits the sign-in links when signed in", () => {
    const html = menu(false);
    expect(html).toContain('href="/pricing"');
    expect(html).not.toContain('href="/login"');
    expect(html).not.toContain(">Get started<");
  });

  it("names the button for each state", () => {
    expect(menuButtonLabel(false)).toBe("Open menu");
    expect(menuButtonLabel(true)).toBe("Close menu");
  });

  it("closes on Escape only while open", () => {
    const close = vi.fn();
    expect(handleMenuKey("Escape", false, close)).toBe(false);
    expect(handleMenuKey("Enter", true, close)).toBe(false);
    expect(close).not.toHaveBeenCalled();
    expect(handleMenuKey("Escape", true, close)).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the button on close and to the first link on open", () => {
    const setOpen = vi.fn();
    const button = { focus: vi.fn() };
    closeMenu(setOpen, button);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
    expect(() => closeMenu(setOpen, null)).not.toThrow();

    const first = { focus: vi.fn() };
    const second = { focus: vi.fn() };
    focusFirstLink([first, second]);
    expect(first.focus).toHaveBeenCalledTimes(1);
    expect(second.focus).not.toHaveBeenCalled();
    expect(() => focusFirstLink([])).not.toThrow();
  });

  it("restores focus to the button after an outside click on a non-focusable area", () => {
    const setOpen = vi.fn();
    const button = { focus: vi.fn() };
    dismissOutside({ closest: () => null }, setOpen, button);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(button.focus).toHaveBeenCalledTimes(1);
  });

  it("leaves focus alone after an outside click on a focusable target", () => {
    const setOpen = vi.fn();
    const button = { focus: vi.fn() };
    const closest = vi.fn(() => ({}));
    dismissOutside({ closest }, setOpen, button);
    expect(closest).toHaveBeenCalledWith(FOCUSABLE_SELECTOR);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(button.focus).not.toHaveBeenCalled();
  });

  it("resets and moves focus to a visible control when leaving the phone range", () => {
    const setOpen = vi.fn();
    const fallback = { focus: vi.fn() };
    leaveMobileRange(setOpen, true, fallback);
    expect(setOpen).toHaveBeenCalledWith(false);
    expect(fallback.focus).toHaveBeenCalledTimes(1);

    const other = { focus: vi.fn() };
    leaveMobileRange(setOpen, false, other);
    expect(other.focus).not.toHaveBeenCalled();
    expect(() => leaveMobileRange(setOpen, true, null)).not.toThrow();
  });

  it("watches the same range the button is shown in", () => {
    expect(MOBILE_MENU_QUERY).toBe("(max-width: 427px)");
    expect(readFileSync("src/components/MobileMenu.tsx", "utf8")).toContain("max-[427px]:block");
  });

  it("is wired into the header with the guest buttons hidden at narrow widths", () => {
    const src = readFileSync("src/components/SiteHeader.tsx", "utf8");
    expect(src).toContain("<MobileMenu");
    expect(src).toContain("max-[427px]:hidden");
  });
});

describe("compare plans scroll cue", () => {
  const box = (scrollLeft: number, scrollWidth: number, clientWidth: number) => ({ scrollLeft, scrollWidth, clientWidth });

  it("is off when the table fits", () => {
    expect(scrollCue(box(0, 640, 700))).toEqual(NO_SCROLL_CUE);
    expect(scrollCue(box(0, 640, 640))).toEqual(NO_SCROLL_CUE);
    expect(scrollCue(box(0, 640.5, 640))).toEqual(NO_SCROLL_CUE);
  });

  it("fades the end, then both sides, then only the start while scrolling", () => {
    expect(scrollCue(box(0, 640, 343))).toEqual({ overflows: true, fadeStart: false, fadeEnd: true });
    expect(scrollCue(box(100, 640, 343))).toEqual({ overflows: true, fadeStart: true, fadeEnd: true });
    expect(scrollCue(box(297, 640, 343))).toEqual({ overflows: true, fadeStart: true, fadeEnd: false });
  });

  it("hides the hint and fades when not overflowing", () => {
    expect(renderToStaticMarkup(createElement(CompareHint, { cue: NO_SCROLL_CUE }))).toBe("");
    expect(renderToStaticMarkup(createElement(CompareFades, { cue: NO_SCROLL_CUE }))).toBe("");
  });

  it("shows the hint and the overflowing side's fade when overflowing", () => {
    const cue = scrollCue(box(0, 640, 343));
    expect(renderToStaticMarkup(createElement(CompareHint, { cue }))).toContain("Scroll for more plans");
    const fades = renderToStaticMarkup(createElement(CompareFades, { cue }));
    expect(fades).toContain('data-fade="end"');
    expect(fades).not.toContain('data-fade="start"');
  });

  it("renders an accessible, focusable region with no cue before measuring", () => {
    const html = renderToStaticMarkup(createElement(ComparePlans, { rows: [{ feature: "Price", self: "a", free: "$0", pro: "b", team: "c" }] }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Compare plans"');
    expect(html).toContain('tabindex="0"');
    expect(html).not.toContain("Scroll for more plans");
    expect(html).not.toContain("data-fade");
  });

  it("keeps the new copy free of dashes", () => {
    for (const f of ["src/components/MobileMenu.tsx", "src/components/landing/ComparePlans.tsx", "src/lib/mobileMenu.ts", "src/lib/scrollCue.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
    }
  });
});
