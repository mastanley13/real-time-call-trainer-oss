import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Briefing from "@/components/call/Briefing";
import BriefingDeck from "@/components/call/BriefingDeck";
import { buildRolePlayCard } from "@/lib/callCard";
import { competitionTrackBySlug } from "@/lib/competition";
import { LIBRARY } from "@/lib/personas";
import { talkTrackSteps } from "@/lib/scenarios";

const caps = { demoMode: true, elevenlabs: false, voiceEngines: ["openai"], llm: true, database: true, realtime: true } as never;

describe("BriefingDeck slide-deck pre-call brief", () => {
  it("opens on Card 1 (Setup) with plain-language role, pitch, situation, opening line, and Next button", () => {
    const track = competitionTrackBySlug("banking")!;
    const scenario = LIBRARY.find((s) => s.id === track.scenarioId)!;
    const html = renderToStaticMarkup(
      createElement(BriefingDeck, {
        scenario,
        roleCard: track.roleCard,
        steps: talkTrackSteps(scenario.callScript),
        watchOuts: track.watchOuts,
        isCompetition: true,
        goalRead: false,
        onGoalReadChange: () => {},
      }),
    );

    expect(html).toContain("Quick brief · Card 1 of 4");
    expect(html).toContain("What you are walking into");
    expect(html).toContain("Who you are");
    expect(html).toContain("Bank Branch Manager");
    expect(html).toContain("Home Equity Line of Credit (HELOC)");
    expect(html).toContain("Carmen Alvarez will answer with");
    expect(html).toContain("Next: How you win");
    expect(html).toContain("View all");
  });

  it("renders cleanly inside Briefing for both competition and regular practice calls", () => {
    const track = competitionTrackBySlug("price-objection")!;
    const scenario = LIBRARY.find((s) => s.id === track.scenarioId)!;
    const html = renderToStaticMarkup(
      createElement(Briefing, {
        scenario,
        capabilities: caps,
        mode: "voice",
        onModeChange: () => {},
        engine: "openai",
        onEngineChange: () => {},
        coachMode: "blind",
        onCoachModeChange: () => {},
        onStart: () => {},
        competition: { track, attemptNumber: 1, maxAttempts: 3, attemptsRemaining: 3 },
      }),
    );

    expect(html).toContain("Pre-call briefing deck");
    expect(html).toContain("Card 1 of 4");
    expect(html).toContain("$1,200/mo");
    expect(html).toContain("Start official call (Attempt 1 of 3)");
  });

  it("uses Flight Deck tokens only in BriefingDeck.tsx (no hex literals, palette classes, dark: overrides, or em dashes)", () => {
    const src = readFileSync(resolve(process.cwd(), "src/components/call/BriefingDeck.tsx"), "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(src).not.toMatch(/\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/);
    expect(src).not.toMatch(/\bdark:/);
    expect(src).not.toContain("\u2014");
    // Ensure buildRolePlayCard works cleanly alongside BriefingDeck.
    expect(buildRolePlayCard(LIBRARY[0]).openingLine).toBe(LIBRARY[0].aiPersona.openingLine);
  });
});
