import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Briefing, { StartBar } from "@/components/call/Briefing";
import { restoreDismissFocus } from "@/lib/onboarding";

// jsdom and Testing Library are not installed, so the breakpoint is driven by stubbing the media-query store.
// "ssr" runs the real hook (server snapshot null: pre-hydration).
const bp = vi.hoisted(() => ({ value: "ssr" as "ssr" | boolean }));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  const uses = ((sub: never, get: never, server: never) => (bp.value === "ssr" ? actual.useSyncExternalStore(sub, get, server) : bp.value)) as typeof actual.useSyncExternalStore;
  return { ...actual, useSyncExternalStore: uses };
});
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import type { Capabilities } from "@/contexts/AuthContext";

const caps = { demoMode: true, elevenlabs: false, llm: false, database: false } as Capabilities;
const noop = () => {};

function briefing(over: { goal?: string; mode?: "voice" | "text"; error?: string } = {}) {
  const base = BUILT_IN_SCENARIOS[0];
  const scenario = { ...base, traineeGoal: over.goal ?? base.traineeGoal };
  return renderToStaticMarkup(createElement(Briefing, {
    scenario, capabilities: caps, mode: over.mode ?? "text", onModeChange: noop, engine: null, onEngineChange: noop,
    coachMode: "coached", onCoachModeChange: noop, onStart: noop, error: over.error,
  }));
}

const startButtons = (html: string) => [...html.matchAll(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?Start call<\/button>/g)].map((m) => m[0]);

describe("Briefing start bar", () => {
  it("puts the Your goal section before every Start button", () => {
    const html = briefing();
    const goal = html.indexOf('id="goal-h"');
    expect(goal).toBeGreaterThan(-1);
    for (const b of startButtons(html)) expect(html.indexOf(b)).toBeGreaterThan(goal);
  });

  it("renders the bar as the last Start in the markup, hidden at lg and up", () => {
    const html = briefing();
    const buttons = startButtons(html);
    expect(buttons).toHaveLength(2); // before hydration both exist; CSS shows exactly one per breakpoint
    expect(buttons[0]).toContain("max-lg:hidden"); // aside Start is hidden below lg
    const bar = html.slice(html.indexOf('aria-label="Start call bar"'));
    expect(bar).toContain("lg:hidden");
    expect(bar).toContain(buttons[1]);
    expect(buttons[1]).toContain("min-h-[48px]");
    expect(buttons[1]).toContain("w-full");
  });

  it("labels the region and hides the goal line from screen readers", () => {
    const html = renderToStaticMarkup(createElement(StartBar, { goal: "Book a demo", blocked: false, onStart: noop }));
    expect(html).toContain('role="region"');
    expect(html).toContain('aria-label="Start call bar"');
    expect(html).toMatch(/<p aria-hidden="true"[^>]*>Goal: Book a demo<\/p>/);
    expect(html.indexOf("Goal:")).toBeLessThan(html.indexOf("Start call</button>"));
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("shows muted 'No goal set' for an empty goal", () => {
    const html = renderToStaticMarkup(createElement(StartBar, { goal: "   ", blocked: false, onStart: noop }));
    expect(html).toMatch(/<p aria-hidden="true" class="[^"]*text-ink-muted[^"]*">No goal set<\/p>/);
    expect(html).not.toContain("Goal:");
  });

  it("truncates a long goal to one line", () => {
    const html = renderToStaticMarkup(createElement(StartBar, { goal: "x".repeat(320), blocked: false, onStart: noop }));
    expect(html).toMatch(/class="[^"]*\btruncate\b[^"]*">Goal: x{320}/);
  });

  it("disables Start when blocked and shows the error in the bar", () => {
    const html = renderToStaticMarkup(createElement(StartBar, { goal: "g", blocked: true, error: "Mic failed.", onStart: noop }));
    expect(startButtons(html)[0]).toMatch(/disabled=""/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Mic failed.");
  });

  it("keeps Call mode reachable when voice is blocked, before the bar in document order", () => {
    const html = briefing({ mode: "voice" });
    expect(html.indexOf('aria-label="Call mode"')).toBeLessThan(html.indexOf('aria-label="Start call bar"'));
    expect(startButtons(html).every((b) => /disabled=""/.test(b))).toBe(true);
  });
});

function findButton(node: ReactNode): ReactElement<{ onClick?: () => void; disabled?: boolean }> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) { const f = findButton(n); if (f) return f; }
    return null;
  }
  const el = node as ReactElement<{ children?: ReactNode }>;
  if (el.type === "button") return el as never;
  return findButton(el.props?.children);
}

describe("breakpoint logic after hydration", () => {
  beforeEach(() => { bp.value = "ssr"; });

  it("below lg renders only the bar's Start, after the goal", () => {
    bp.value = false;
    const html = briefing();
    const buttons = startButtons(html);
    expect(buttons).toHaveLength(1);
    expect(html.indexOf('id="goal-h"')).toBeLessThan(html.indexOf('aria-label="Start call bar"'));
    expect(html.indexOf('aria-label="Start call bar"')).toBeLessThan(html.indexOf(buttons[0]));
    expect(html).not.toContain("btn-xl");
  });

  it("at lg and up renders only the aside Start and no bar", () => {
    bp.value = true;
    const html = briefing();
    expect(startButtons(html)).toHaveLength(1);
    expect(html).not.toContain("Start call bar");
    expect(html).toContain("btn-xl");
    expect(html).not.toContain("max-lg:hidden");
  });

  it("shows the error once, in whichever place has Start", () => {
    for (const v of [false, true]) {
      bp.value = v;
      expect(briefing({ error: "Mic failed." }).match(/Mic failed\./g)).toHaveLength(1);
    }
  });

  it("blocked voice disables the single Start at both breakpoints", () => {
    for (const v of [true, false]) {
      bp.value = v;
      const b = startButtons(briefing({ mode: "voice" }));
      expect(b).toHaveLength(1);
      expect(b[0]).toMatch(/disabled=""/);
    }
  });
});

describe("bar height and Start activation", () => {
  beforeEach(() => { bp.value = "ssr"; });

  it("is sticky in flow, so a wrapped error grows its own space instead of covering content", () => {
    bp.value = false;
    const html = briefing({ error: "A long voice error. ".repeat(10) });
    const tag = html.match(/<div[^>]*aria-label="Start call bar"[^>]*>/)?.[0] ?? "";
    expect(tag).toMatch(/\bsticky\b/);
    expect(tag).not.toMatch(/\bfixed\b/);
    expect(html).not.toContain("h-[5.5rem]");
    expect(html.indexOf("Change persona")).toBeLessThan(html.indexOf('aria-label="Start call bar"'));
  });

  it("calls onStart when the bar's Start is activated, and is disabled when blocked", () => {
    const onStart = vi.fn();
    const ok = findButton(StartBar({ goal: "g", blocked: false, onStart }));
    expect(ok?.props.disabled).toBe(false);
    ok?.props.onClick?.();
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(findButton(StartBar({ goal: "g", blocked: true, onStart }))?.props.disabled).toBe(true);
  });
});

describe("restoreDismissFocus", () => {
  const el = (disabled = false) => ({ disabled, focus: vi.fn() });

  it("focuses the visible Start (the bar's on mobile) when enabled", () => {
    const start = el(), mode = el(), heading = el();
    expect(restoreDismissFocus({ start, modeToggle: mode, heading })).toBe("start");
    expect(start.focus).toHaveBeenCalledTimes(1);
    expect(mode.focus).not.toHaveBeenCalled();
  });

  it("falls back to the Call mode toggle when Start is disabled, so the user can switch to text", () => {
    const start = el(true), mode = el(), heading = el();
    expect(restoreDismissFocus({ start, modeToggle: mode, heading })).toBe("mode");
    expect(start.focus).not.toHaveBeenCalled();
    expect(mode.focus).toHaveBeenCalledTimes(1);
  });

  it("falls back to the heading when there is no Start and no toggle", () => {
    const heading = el();
    expect(restoreDismissFocus({ start: null, modeToggle: null, heading })).toBe("heading");
    expect(heading.focus).toHaveBeenCalledTimes(1);
  });
});
