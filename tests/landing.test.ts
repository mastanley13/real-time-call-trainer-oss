import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LANDINGS } from "@/lib/landing";
import { LIBRARY } from "@/lib/personas";
import { registerHref } from "@/lib/pricing";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { pageMetadata } from "@/lib/seo";

const personaNames = new Set(LIBRARY.map((s) => s.aiPersona.name));

describe("landing pages", () => {
  it("has one entry per public vertical", () => {
    expect(Object.keys(LANDINGS).sort()).toEqual([...VERTICAL_SLUGS].sort());
  });

  it("only lists personas that exist in the library", () => {
    for (const l of Object.values(LANDINGS)) for (const p of l.personas) expect(personaNames.has(p.name), `${l.slug}: ${p.name}`).toBe(true);
  });

  it("sends sign-up CTAs to /register with the spec query params", () => {
    expect(LANDINGS.insurance.primaryHref).toBe("/register?seg=insurance&src=insurance");
    expect(LANDINGS["saas-sdr"].primaryHref).toBe("/register?seg=saas&src=saas-sdr");
    expect(LANDINGS.coaches.secondary.href).toBe("/register?src=coaches");
    expect(registerHref({ plan: "team", src: "pricing" })).toBe("/register?plan=team&src=pricing");
    for (const l of Object.values(LANDINGS)) expect(l.primaryHref).not.toContain("/start");
  });
});

describe("page metadata", () => {
  it("sets canonical, Open Graph and a large Twitter card", () => {
    const m = pageMetadata({ title: "T", description: "D", path: "/pricing" });
    expect(m.alternates?.canonical).toBe("https://calltrainer.tech/pricing");
    expect(m.openGraph?.url).toBe("https://calltrainer.tech/pricing");
    expect((m.twitter as { card?: string }).card).toBe("summary_large_image");
    expect(pageMetadata({ title: "T", description: "D", path: "/" }).alternates?.canonical).toBe("https://calltrainer.tech");
  });
});

describe("copy rules", () => {
  const files = [
    "src/lib/landing.ts", "src/lib/pricing.ts", "src/app/pricing/page.tsx", "src/app/privacy/page.tsx", "src/app/terms/page.tsx",
    "src/components/landing/LandingPage.tsx", "src/components/landing/PricingCards.tsx", "src/components/landing/PricingSummary.tsx",
    "src/components/landing/PublicFooter.tsx",
  ];
  it.each(files)("%s has no em or en dashes", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
  });
  it("legal pages carry the pending-review comment and the date", () => {
    for (const f of ["src/app/privacy/page.tsx", "src/app/terms/page.tsx"]) {
      const s = readFileSync(f, "utf8");
      expect(s.startsWith("// Legal copy pending owner review.")).toBe(true);
      expect(s).toContain("Last updated: October 31, 2026");
    }
  });
});
