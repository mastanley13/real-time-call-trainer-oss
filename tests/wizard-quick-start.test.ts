import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { WizardInputSchema, type FetchedPage, type WizardInput } from "@/lib/wizard-types";
import {
  buildQuickStartInput,
  formatFetchedPageContext,
  inferCallTypeForRole,
  inferRoleFromPage,
  normalizeWizardUrl,
} from "@/lib/wizardQuickStart";

const baseInput: WizardInput = {
  role: "sdr",
  industry: "",
  callType: "cold",
  difficulty: "medium",
  product: "",
  contexts: [],
  keepRealNames: true,
};

function makePage(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    url: "https://example.com/pricing",
    title: "Acme Cloud",
    description: "",
    suggestedIndustry: "",
    suggestedProduct: "",
    text: "Software for growing teams.",
    bytes: 18_432,
    ...overrides,
  };
}

describe("normalizeWizardUrl", () => {
  it("prepends https:// for bare domains and keeps explicit schemes", () => {
    expect(normalizeWizardUrl("acme.com/pricing")).toBe("https://acme.com/pricing");
    expect(normalizeWizardUrl("  https://acme.com  ")).toBe("https://acme.com");
    expect(normalizeWizardUrl("http://acme.com")).toBe("http://acme.com");
    expect(normalizeWizardUrl("   ")).toBe("");
  });
});

describe("inferRoleFromPage and inferCallTypeForRole", () => {
  it("infers industry-specific sales families from page signals", () => {
    expect(inferRoleFromPage(makePage({ title: "Apex Roofing & HVAC", suggestedIndustry: "Home services", text: "Emergency water heater and furnace repair." }))).toBe("home-services");
    expect(inferRoleFromPage(makePage({ title: "Summit Ford Dealership", suggestedIndustry: "", text: "Browse pre-owned vehicles and book a test drive." }))).toBe("auto");
    expect(inferRoleFromPage(makePage({ title: "SunPeak Solar", suggestedIndustry: "", text: "Rooftop solar panels and battery storage installation." }))).toBe("solar");
    expect(inferRoleFromPage(makePage({ title: "Harbor Insurance Group", suggestedIndustry: "", text: "Compare homeowners policy and auto coverage quotes." }))).toBe("insurance");
    expect(inferRoleFromPage(makePage({ title: "ClearRate Lending", suggestedIndustry: "", text: "Fast home loan and FHA mortgage refinancing." }))).toBe("mortgage");
    expect(inferRoleFromPage(makePage({ title: "Northstar Freight", suggestedIndustry: "Logistics", text: "3PL carrier network and dispatch platform." }))).toBe("logistics");
    expect(inferRoleFromPage(makePage({ title: "Beacon Staffing", suggestedIndustry: "", text: "Technical recruiting and executive search." }))).toBe("recruiting");
    expect(inferRoleFromPage(makePage({ title: "Acme Analytics", suggestedIndustry: "B2B SaaS", text: "Revenue dashboards for enterprise teams." }))).toBe("sdr");
  });

  it("picks inbound for consumer/local verticals and collections for collections", () => {
    expect(inferCallTypeForRole("home-services")).toBe("inbound");
    expect(inferCallTypeForRole("auto")).toBe("inbound");
    expect(inferCallTypeForRole("real-estate")).toBe("inbound");
    expect(inferCallTypeForRole("collections")).toBe("collections");
    expect(inferCallTypeForRole("sdr")).toBe("cold");
    expect(inferCallTypeForRole("logistics", "discovery")).toBe("discovery");
  });
});

describe("buildQuickStartInput", () => {
  it("builds a valid schema-bounded WizardInput from a single fetched URL", () => {
    const page = makePage({
      title: "Apex Roofing & Plumbing",
      suggestedIndustry: "Home services",
      suggestedProduct: "24/7 emergency plumbing and roof replacement.",
      text: "Licensed technicians serving residential homeowners.",
    });
    const out = buildQuickStartInput(page, baseInput);

    expect(WizardInputSchema.safeParse(out).success).toBe(true);
    expect(out.role).toBe("home-services");
    expect(out.callType).toBe("inbound");
    expect(out.industry).toBe("Home services");
    expect(out.product).toBe("24/7 emergency plumbing and roof replacement.");
    expect(out.keepRealNames).toBe(true);
    expect(out.contexts).toHaveLength(1);
    expect(out.contexts[0]).toEqual({
      kind: "url",
      text: formatFetchedPageContext(page),
      label: page.url,
    });
  });

  it("respects explicit user overrides and keeps extra context tabs", () => {
    const page = makePage({ title: "Apex Roofing", suggestedIndustry: "Home services", text: "Roofing and siding." });
    const out = buildQuickStartInput(
      page,
      {
        ...baseInput,
        role: "ae",
        callType: "discovery",
        industry: "Commercial roofing",
        product: "Multi-site preventative roof maintenance contracts",
      },
      {
        rolePicked: true,
        callTypePicked: true,
        extraContexts: [
          { kind: "crm", text: "Buyer manages 14 warehouses and had a leak last winter." },
          { kind: "url", text: "stale url context should be replaced" },
        ],
      },
    );

    expect(WizardInputSchema.safeParse(out).success).toBe(true);
    expect(out.role).toBe("ae");
    expect(out.callType).toBe("discovery");
    expect(out.industry).toBe("Commercial roofing");
    expect(out.product).toBe("Multi-site preventative roof maintenance contracts");
    expect(out.contexts).toHaveLength(2);
    expect(out.contexts[0].kind).toBe("url");
    expect(out.contexts[1]).toEqual({ kind: "crm", text: "Buyer manages 14 warehouses and had a leak last winter." });
  });

  it("truncates oversized page fields so WizardInputSchema always succeeds", () => {
    const page = makePage({
      url: `https://example.com/${"a".repeat(300)}`,
      suggestedIndustry: "I".repeat(150),
      suggestedProduct: "P".repeat(700),
      text: "T".repeat(12_000),
    });
    const out = buildQuickStartInput(page, baseInput);
    expect(WizardInputSchema.safeParse(out).success).toBe(true);
    expect(out.industry.length).toBeLessThanOrEqual(80);
    expect(out.product.length).toBeLessThanOrEqual(400);
    expect(out.contexts[0].text.length).toBeLessThanOrEqual(8000);
    expect((out.contexts[0].label ?? "").length).toBeLessThanOrEqual(200);
  });
});

describe("PersonaWizard and LibraryClient UI guardrails", () => {
  const files = [
    "src/components/library/PersonaWizard.tsx",
    "src/components/library/LibraryClient.tsx",
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
