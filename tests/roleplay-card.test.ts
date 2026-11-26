import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRolePlayCard } from "@/lib/callCard";
import { COMPETITION_TRACKS } from "@/lib/competition";
import { LIBRARY } from "@/lib/personas";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

describe("competition role-play entry cards", () => {
  it("gives every competition track a complete roleCard whose openingLine matches its canonical LIBRARY scenario", () => {
    expect(COMPETITION_TRACKS).toHaveLength(8);
    for (const track of COMPETITION_TRACKS) {
      const scenario = LIBRARY.find((s) => s.id === track.scenarioId);
      expect(scenario, track.slug).toBeDefined();
      expect(track.roleCard.yourRole.trim().length, `${track.slug} yourRole`).toBeGreaterThan(3);
      expect(track.roleCard.pitching.trim().length, `${track.slug} pitching`).toBeGreaterThan(10);
      expect(track.roleCard.situation.trim().length, `${track.slug} situation`).toBeGreaterThan(20);
      expect(track.roleCard.openingLine, `${track.slug} openingLine`).toBe(scenario!.aiPersona.openingLine);
    }
  });

  it("keeps AI buyer personas aligned with key numbers and context shown on the rep's role-play card", () => {
    const byId = (id: string) => LIBRARY.find((s) => s.id === id)!;
    expect(byId("quote-follow-up").aiPersona.behavior).toContain("$14,800");
    expect(byId("quote-follow-up").aiPersona.behavior).toContain("25-year");
    expect(byId("insurance-renewal-premium-jump").aiPersona.behavior).toContain("$2,310");
    expect(byId("solar-burned-homeowner-discovery").aiPersona.behavior).toContain("$149");
    expect(byId("auto-pickup-negotiation-rival-quote").aiPersona.behavior).toContain("$38,400");
    expect(byId("sdr-busy-ops-vp-freight-broker").aiPersona.behavior).toContain("Ketterhill Freight Partners");
    expect(byId("real-estate-expired-listing-cold-call").aiPersona.behavior).toContain("$389,000");
    expect(byId("mortgage-bank-heloc-account-review").aiPersona.behavior).toContain("3.75%");
    expect(byId("objection-handling").aiPersona.behavior).toContain("$1,200/month");
  });

  it("includes both retail HELOC and small-business banking scenarios without naming real banks", () => {
    const heloc = LIBRARY.find((s) => s.id === "mortgage-bank-heloc-account-review");
    const biz = LIBRARY.find((s) => s.id === "mortgage-bank-business-loc-refi");
    expect(heloc).toBeDefined();
    expect(biz).toBeDefined();
    expect(heloc!.status).toBe("draft");
    expect(biz!.status).toBe("draft");
    expect(JSON.stringify([heloc, biz])).not.toMatch(/first citizens/i);
  });

  it("grounds the Open Price Objection scenario (Priya Raman) in concrete proposal details", () => {
    const priya = BUILT_IN_SCENARIOS.find((s) => s.id === "objection-handling");
    expect(priya).toBeDefined();
    expect(priya!.aiPersona.role).toContain("$1,200/month");
    expect(priya!.aiPersona.behavior).toContain("$600/month");
    expect(priya!.aiPersona.behavior).toContain("90-day");
    expect(priya!.traineeGoal).toContain("Neutralize");
  });
});

describe("buildRolePlayCard", () => {
  it("uses the canonical competition roleCard for competition scenarios", () => {
    const priya = BUILT_IN_SCENARIOS.find((s) => s.id === "objection-handling")!;
    const card = buildRolePlayCard(priya);
    expect(card.yourRole).toBe("Account Executive · Operations Software");
    expect(card.pitching).toContain("$1,200/mo");
    expect(card.openingLine).toBe(priya.aiPersona.openingLine);
  });

  it("derives a spoiler-free card for library and custom scenarios without exposing aiPersona.behavior", () => {
    const custom = {
      id: "custom-test-1",
      role: "home-services",
      industry: "Plumbing",
      title: "Inbound lead: leaking water heater",
      callType: "inbound" as const,
      aiPersona: {
        name: "Dana Whitfield",
        role: "Homeowner calling about a leaking garage water heater",
        behavior: "SECRET_HIDDEN_FACT_DO_NOT_LEAK",
        openingLine: "Hi, my water heater is leaking all over the garage.",
      },
    };
    const card = buildRolePlayCard(custom);
    expect(card.yourRole).toContain("Home Services Specialist");
    expect(card.pitching).toBe("Leaking water heater");
    expect(card.situation).toContain("Dana Whitfield");
    expect(card.openingLine).toBe(custom.aiPersona.openingLine);
    expect(JSON.stringify(card)).not.toContain("SECRET_HIDDEN_FACT_DO_NOT_LEAK");
  });
});

describe("RolePlayCard and Compete UI guardrails", () => {
  const files = [
    "src/components/call/RolePlayCard.tsx",
    "src/components/call/Briefing.tsx",
    "src/components/compete/CompeteClient.tsx",
  ];

  it("uses Flight Deck tokens only (no hex literals, palette classes, dark: overrides, or em dashes)", () => {
    for (const rel of files) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf8");
      expect(src, `${rel} hex literal`).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(src, `${rel} palette class`).not.toMatch(/\b(?:bg|text|border)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/);
      expect(src, `${rel} dark: override`).not.toMatch(/\bdark:/);
      expect(src, `${rel} em dash`).not.toContain("\u2014");
    }
  });
});
