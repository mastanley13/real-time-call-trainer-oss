import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { LANDINGS } from "@/lib/landing";
import { LIBRARY } from "@/lib/personas";
import { PRICING_NAV } from "@/components/SiteHeader";
import { FREE_SUMMARY, FREE_VOICE_MIN, MINUTES_ROUNDED_NOTE, registerHref } from "@/lib/pricing";
import { VERTICAL_SLUGS } from "@/lib/publicPaths";
import { pageMetadata, siteUrl } from "@/lib/seo";

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
    expect(LANDINGS["saas-sdr"].primaryHref).toBe("/register?seg=saas-sdr&src=saas-sdr");
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

describe("pricing copy", () => {
  it("states the Free 10 minute line exactly", () => {
    expect(FREE_VOICE_MIN).toBe(10);
    expect(FREE_SUMMARY).toBe("Free: 10 voice minutes a month, enough for a full graded call, plus unlimited text practice. No card.");
  });

  it("says calls are rounded up on Pro and Team only", () => {
    const src = readFileSync("src/app/pricing/page.tsx", "utf8");
    expect(MINUTES_ROUNDED_NOTE).toBe("Calls are counted in whole minutes, rounded up.");
    expect(src).toContain("pro: `${PRO_VOICE_MIN} a month. ${MINUTES_ROUNDED_NOTE}`");
    expect(src).toContain("team: `${TEAM_VOICE_MIN_PER_SEAT} per seat, pooled. ${MINUTES_ROUNDED_NOTE}`");
    expect(src).not.toMatch(/free: `[^`]*MINUTES_ROUNDED_NOTE/);
  });

  it("links Pricing from the header", () => {
    expect(PRICING_NAV.href).toBe("/pricing");
    expect(PRICING_NAV.label).toBe("Pricing");
    expect(PRICING_NAV.match("/pricing")).toBe(true);
  });
});

describe("copy rules", () => {
  const files = [
    "src/lib/landing.ts", "src/lib/pricing.ts", "src/app/pricing/page.tsx",    "src/components/landing/LandingPage.tsx", "src/components/landing/PricingCards.tsx", "src/components/landing/PricingSummary.tsx",
    "src/components/landing/PublicFooter.tsx",
  ];
  it.each(files)("%s has no em or en dashes", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
  });
});

describe("site origin", () => {
  const prev = { APP_URL: process.env.APP_URL, VERCEL_URL: process.env.VERCEL_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("falls back to calltrainer.tech and ignores VERCEL_URL", () => {
    delete process.env.APP_URL;
    process.env.VERCEL_URL = "preview-abc.vercel.app";
    expect(siteUrl()).toBe("https://calltrainer.tech");
    expect(pageMetadata({ title: "T", description: "D", path: "/pricing" }).openGraph?.url).toBe("https://calltrainer.tech/pricing");
  });

  it("uses APP_URL as the origin, even when VERCEL_URL is set", () => {
    process.env.APP_URL = "https://app.example.com/";
    process.env.VERCEL_URL = "preview-abc.vercel.app";
    expect(siteUrl()).toBe("https://app.example.com");
    expect(pageMetadata({ title: "T", description: "D", path: "/pricing" }).alternates?.canonical).toBe("https://app.example.com/pricing");
  });

  it("ignores an invalid APP_URL", () => {
    process.env.APP_URL = "not a url";
    expect(siteUrl()).toBe("https://calltrainer.tech");
  });

  it("sets metadataBase from siteUrl() and never reads VERCEL_URL in code", () => {
    expect(readFileSync("src/app/layout.tsx", "utf8")).toContain("metadataBase: new URL(siteUrl())");
    for (const f of ["src/app/layout.tsx", "src/app/sitemap.ts", "src/app/robots.ts", "src/lib/shareCard.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toContain("VERCEL_URL");
    }
    expect(readFileSync("src/lib/seo.ts", "utf8")).not.toContain("process.env.VERCEL_URL");
  });
});
