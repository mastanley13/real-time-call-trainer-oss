import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Briefing, { StartBar } from "@/components/call/Briefing";
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
