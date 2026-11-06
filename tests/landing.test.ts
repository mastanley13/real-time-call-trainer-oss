import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import Home from "@/app/page";
import { FREE_LINE, HERO_HEADLINE } from "@/lib/homeCopy";
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
    "src/components/landing/PublicFooter.tsx", "src/app/page.tsx", "src/components/landing/HeroDeck.tsx", "src/lib/homeCopy.ts",
  ];
  it.each(files)("%s has no em or en dashes", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
  });
});

describe("home page (Practice Desk)", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const pageSrc = readFileSync("src/app/page.tsx", "utf8");
  const deckSrc = readFileSync("src/components/landing/HeroDeck.tsx", "utf8");
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

  it("shows the exact headline as the only h1", () => {
    expect(HERO_HEADLINE).toBe("Practice the price objection before your next call.");
    expect(html.match(/<h1[^>]*>([^<]*)<\/h1>/g)).toEqual([expect.stringContaining(`>${HERO_HEADLINE}</h1>`)]);
  });

  it("keeps the hosted sign-up path and the pricing link", () => {
    expect(hrefs).toContain(registerHref({ src: "home_hero" }));
    expect(hrefs).toContain("/register?src=home_hero");
    expect(hrefs).toContain("/pricing");
    expect(html).toContain(">Start free, no card<");
  });

  it("states the Free line from the locked plan numbers", () => {
    expect(FREE_VOICE_MIN).toBe(10);
    expect(FREE_LINE).toBe("Ten voice minutes monthly, unlimited text.");
    expect(html).toContain(FREE_LINE);
  });

  it("labels the transcript as an example session with speakers, one cue and no score", () => {
    expect(text).toContain("Example session");
    expect(text).toContain("Dana Whitfield");
    expect(text).toContain("What does a visit cost? Nobody mentioned a fee.");
    expect(html.match(/<li class="grid/g)).toHaveLength(3);
    for (const who of ["Dana", "You"]) expect(html).toContain(`>${who}</span>`);
    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(text).toContain("Name the fee before you offer a time slot.");
    // No final or provisional score, and no fabricated metrics.
    expect(text).not.toMatch(/\d+\s*\/\s*100|\b58\b|%|score ring/i);
    expect(deckSrc).not.toMatch(/overall|CoachResult|CriteriaTapes/);
  });

  it("follows with a real ordered Brief, Call, Debrief list", () => {
    const steps = html.slice(html.indexOf('id="how-h"'));
    const ol = steps.slice(steps.indexOf("<ol"), steps.indexOf("</ol>"));
    expect(ol).not.toBe("");
    expect(ol.match(/<li/g)).toHaveLength(3);
    expect(ol.replace(/<[^>]+>/g, "")).toMatch(/Brief.*Call.*Debrief/);
  });

  it("has no env var names, model chips, setup commands or raw keys", () => {
    for (const src of [pageSrc, deckSrc, html]) {
      expect(src).not.toMatch(/\bLLM_[A-Z_]+|\bOPENAI_[A-Z_]+|\bELEVENLABS_[A-Z_]+|\bREALTIME_[A-Z_]+/);
      expect(src).not.toMatch(/chip-model|Your chat model|npm (run|install)|git clone|\bsk-[A-Za-z0-9]/);
    }
    expect(html).not.toMatch(/<pre\b/);
  });

  it("makes every scroll region focusable and named", () => {
    const tags = [...html.matchAll(/<[a-z]+\b[^>]*class="[^"]*\boverflow-(?:[xy]-)?(?:auto|scroll)\b[^"]*"[^>]*>/g)].map((m) => m[0]);
    for (const tag of tags) {
      expect(tag, tag).toContain('tabindex="0"');
      expect(tag, tag).toMatch(/aria-label="[^"]+"/);
    }
  });

  it("is static: no client code, no microphone, no remote fonts", () => {
    for (const src of [pageSrc, deckSrc]) {
      expect(src).not.toMatch(/["']use client["']|getUserMedia|mediaDevices/);
    }
    expect(readFileSync("src/app/layout.tsx", "utf8")).not.toContain("next/font");
    expect(html).not.toMatch(/gradient|fonts\.googleapis/);
  });

  it("defines the shared semantic tokens once, in globals.css and the Tailwind config", () => {
    const css = readFileSync("src/app/globals.css", "utf8");
    const root = css.match(/:root \{([^}]*)\}/)?.[1] ?? "";
    for (const t of ["--bg: 255 255 255;", "--ink: 24 43 52;", "--ink-soft: 70 92 100;", "--primary: 18 104 93;", "--sunken: 237 244 243;", "--line: 203 216 217;", "--alert: 165 38 48;",
      "--radius-control: 7px;", "--radius-group: 10px;", "--radius-badge: 4px;", "--focus-ring-width: 3px;", "--focus-ring-offset: 4px;", "--content-max: 1240px;"]) {
      expect(root).toContain(t);
    }
    const tw = readFileSync("tailwind.config.ts", "utf8");
    expect(tw).toContain('control: "var(--radius-control)"');
    expect(tw).toContain('badge: "var(--radius-badge)"');
    for (const src of [pageSrc, deckSrc]) expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(\d|\b(?:slate|gray|red|teal|emerald)-\d/);
  });
});

describe("billing, cancellation and refund copy", () => {
  const pricing = readFileSync("src/app/pricing/page.tsx", "utf8");
  const terms = readFileSync("src/app/terms/page.tsx", "utf8");
  it("pricing FAQ says cancel from Settings > Billing, access to period end, no refunds except by law", () => {
    expect(pricing).toContain("Cancel anytime from Settings > Billing");
    expect(pricing).toContain("until the end of the period you paid for");
    expect(pricing).toContain("non-refundable except where the law requires");
  });
  it("terms has the billing, cancellation and refunds section", () => {
    expect(terms).toContain("Billing, cancellation and refunds");
    expect(terms).toContain("renew automatically, monthly or annually");
    expect(terms).toContain("cancel anytime from Settings &gt; Billing");
    expect(terms).toContain("non-refundable except where the law requires");
    expect(terms).toContain("Last updated: November 4, 2026");
  });
  it("terms says no refunds up top and keeps the legal carve-out in one place", () => {
    expect(terms).toContain("There are no refunds.");
    expect(terms.split("except where the law requires").length - 1).toBe(1);
  });
  it("neither page promises a money-back guarantee", () => {
    expect(pricing + terms).not.toMatch(/money[- ]back|guarantee/i);
    expect(terms).not.toMatch(/[–—]/);
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
