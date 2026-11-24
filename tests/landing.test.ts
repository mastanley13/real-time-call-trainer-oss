import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import Home from "@/app/page";
import HeroDeck, { EXAMPLE_TURNS } from "@/components/landing/HeroDeck";
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
    "src/components/landing/PublicFooter.tsx", "src/app/page.tsx", "src/components/landing/HeroDeck.tsx", "src/components/landing/landing-desk.css",
  ];
  it.each(files)("%s has no em or en dashes", (f) => {
    expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
  });
});

describe("home page (Practice Desk layout, #90 copy)", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const decode = (s: string) => s.replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');
  const textOf = (s: string) => decode(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
  const text = textOf(html);
  const pageSrc = readFileSync("src/app/page.tsx", "utf8");
  const deckSrc = readFileSync("src/components/landing/HeroDeck.tsx", "utf8");
  const cssSrc = readFileSync("src/components/landing/landing-desk.css", "utf8");

  it("keeps every #90 string verbatim", () => {
    for (const s of [
      "Free tier · no card · text or voice",
      "Know which reps are ready before they're on a live call.",
      `Your reps practice against ${LIBRARY.length} AI buyers who push back. You read a graded debrief that quotes their own words, so you can see who is ready and what to coach next. Free to start, no card.`,
      "Start free, no card",
      "See pricing",
      "Managing 3 or more reps? Team adds a manager view and assignments: $59 a seat a month, 3-seat minimum.",
      "Start a Team",
      `${LIBRARY.length} AI buyers across 18 sales jobs`,
      "From SDR cold calls to insurance renewals, portal leads and past-due calls. Filter by role, industry, difficulty and the objection they throw.",
      "A live coach, not a script",
      "A live score on every turn, talk-track progress and a line your rep can use. Train Blind, Guided or Coached, so you choose how much help each rep gets.",
      "A debrief that quotes your rep's own words",
      "Every score cites what the rep actually said, checked against the transcript. Open a quote to see the moment, then retry the call from that turn.",
      "How it works",
      "Brief, call, debrief. Then go again.",
      "Pick a persona from the library. Read the goal, the objections to expect and the talk track.",
      "Talk or type. The caller stays in character; a coach rail only you can see scores each turn and whispers the next move.",
      "Every score cites your own words. Jump to the moment you lost points and retry the call from that turn.",
      "Open source · MIT · bring your own key",
      "Add the persona your team actually sells to",
      "Build one with the wizard, export the pack file, and open a pull request. Packs are checked against the same schema the app uses.",
      "Build a persona pack",
      "View on GitHub",
      "Run it locally",
    ]) expect(text, s).toContain(s);
    expect(LIBRARY.length).toBe(54);
  });

  it("drops #70's old copy and the add-on price", () => {
    for (const s of ["Practice the price objection before your next call.", "Ten voice minutes monthly, unlimited text.", "Know the buyer", "Try your answer", "Work from evidence", "Sales call practice, no setup required", "Premium"]) {
      expect(text, s).not.toContain(s);
    }
    expect(text).not.toMatch(/practise/i);
    for (const src of [pageSrc, deckSrc, cssSrc]) expect(src).not.toMatch(/practise/i);
  });

  it("keeps What runs each job between how it works and the features, with main's rows and note", () => {
    const how = html.indexOf('id="how-h"');
    const models = html.indexOf('id="models-h"');
    const feat = html.indexOf('id="feat-h"');
    expect(models).toBeGreaterThan(how);
    expect(feat).toBeGreaterThan(models);
    expect(html).toContain('aria-labelledby="models-h"');
    expect(html).toMatch(/<h2 id="models-h"[^>]*>What runs each job<\/h2>/);
    // Inline <span class="mono"> tags become spaces when stripped; drop the space that lands before punctuation.
    const section = textOf(html.slice(models, feat)).replace(/ ([,.])/g, "$1");
    expect(text).toContain("Under the hood");
    for (const [job, engine, note] of [
      ["Live coach", "Your chat model", "Per-turn cues and rubric estimate, as validated JSON"],
      ["Grading", "Your chat model", "Full-transcript rubric grade with verbatim evidence checks"],
      ["Persona wizard", "Your chat model", "Builds a persona, objections and rubric from your context"],
      ["Voice", "OpenAI Realtime", "Over WebRTC, the default when an OpenAI key is set. ElevenLabs Agents also supported"],
    ]) {
      expect(section, job).toContain(`${job} ${engine} ${note}`);
    }
    expect(section).toContain("Coaching, grades, wizard drafts and text-call replies say whether AI produced them or a rules-based fallback did. Point LLM_BASE_URL at any OpenAI-compatible API, with its own LLM_API_KEY, and set LLM_MODEL to swap models.");
    for (const env of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) expect(html).toContain(`<span class="mono">${env}</span>`);
  });

  it("has exactly one h1 and ordered headings", () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `h${levels[i - 1]} then h${levels[i]}`).toBeLessThanOrEqual(1);
  });

  it("sends Start free, no card to the hero register link with that exact label", () => {
    expect(registerHref({ src: "home_hero" })).toBe("/register?src=home_hero");
    // The form verify-headline.sh reads: the href, then the label as the anchor's only content.
    expect(html).toMatch(/href="\/register\?src=home_hero">Start free, no card<\/a>/);
    const hero = html.slice(0, html.indexOf('id="how-h"'));
    expect(hero).toContain('href="/pricing"');
    expect(hero).toContain('href="/register?src=home_hero&amp;plan=team&amp;interval=month"');
  });

  it("shows the example session transcript with one coach cue as a note and no score", () => {
    const deck = renderToStaticMarkup(createElement(HeroDeck));
    const deckText = textOf(deck);
    expect(html).toContain(deck);
    expect(deckText).toContain("Example session");
    expect(deckText).toContain("Dana Whitfield");
    expect(EXAMPLE_TURNS).toHaveLength(3);
    expect(deck.match(/<li\b/g)).toHaveLength(3);
    for (const t of EXAMPLE_TURNS) {
      expect(deckText).toContain(t.text);
      expect(deckText).toContain(t.at);
    }
    for (const who of ["Dana", "You"]) expect(deck).toContain(`>${who}</span>`);
    expect(deck.match(/role="note"/g)).toHaveLength(1);
    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(deckText).toContain("Name the fee before you offer a time slot.");
    // No live or final score and no metrics in the example.
    expect(deckText).not.toMatch(/\d+\s*\/\s*100|%|\bscore\b|estimate|\+\d/i);
    expect(deckSrc).not.toMatch(/CoachResult|CriteriaTapes|Instruments|overall/);
  });

  it("is a static server component: no client code, no microphone", () => {
    for (const src of [pageSrc, deckSrc]) {
      expect(src).not.toMatch(/["']use client["']/);
      expect(src).not.toMatch(/getUserMedia|mediaDevices|useState|useEffect|onClick/);
    }
    expect(deckSrc).not.toMatch(/from "@\/components\/call\//);
  });

  it("uses Lucide icons only, no decorative visuals and no color literals", () => {
    const icons = pageSrc.match(/import \{([^}]+)\} from "lucide-react"/)?.[1] ?? "";
    expect(icons).not.toMatch(/Sparkle|Wand|Star/);
    for (const src of [pageSrc, deckSrc]) {
      expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(\d|\b(?:slate|gray|zinc|red|teal|emerald|cyan)-\d|gradient|backdrop-blur|\bglass\b|shadow-glow/);
    }
    expect(cssSrc).not.toMatch(/#[0-9a-fA-F]{3,8}\b|gradient|blur\(/);
  });

  it("makes every scroll region focusable, named and inside the focus-ring scope", () => {
    const tags = [...html.matchAll(/<[a-z]+\b[^>]*class="[^"]*\boverflow-(?:[xy]-)?(?:auto|scroll)\b[^"]*"[^>]*>/g)].map((m) => m[0]);
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(tag, tag).toContain('tabindex="0"');
      expect(tag, tag).toMatch(/aria-label="[^"]+"/);
      expect(tag, tag).toMatch(/role="region"/);
    }
    expect(cssSrc).toMatch(/\.landing-desk :focus-visible \{[^}]*outline: var\(--focus-ring-width\) solid rgb\(var\(--primary\)\);[^}]*outline-offset: var\(--focus-ring-offset\);/);
  });

  describe("landing scope", () => {
    /** Every [selector, body] rule in a CSS file, @media rules flattened (bodies of at-rules are walked, not returned). */
    const rules = (css: string) =>
      [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);
    /** Splits a selector list on top-level commas only. */
    const selectors = (list: string) => {
      const out: string[] = [];
      let depth = 0, cur = "";
      for (const ch of list) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
      }
      return [...out, cur.trim()];
    };
    /** Flight Deck color tokens from globals.css. The home page uses them as-is, so none may be redefined here. */
    const COLOR_TOKENS = ["--bg", "--surface", "--sunken", "--ink", "--ink-soft", "--ink-muted", "--line", "--primary", "--primary-hover", "--primary-soft", "--on-primary", "--signal", "--ok", "--caution", "--alert", "--alert-soft", "--on-alert", "--shadow"];

    it("puts every rule of landing-desk.css under the .landing-desk wrapper", () => {
      const all = rules(cssSrc);
      expect(all.length).toBeGreaterThan(5);
      for (const [list] of all) for (const sel of selectors(list)) expect(sel, sel).toMatch(/(^|\s)\.landing-desk(\s|$|:|\.)/);
      expect(cssSrc).not.toMatch(/@import|@tailwind|@layer|@font-face/);
    });

    it("uses the Flight Deck colors and fonts: no token, theme or font override (the retired green-teal Practice Desk palette)", () => {
      for (const [sel, body] of rules(cssSrc)) {
        for (const t of COLOR_TOKENS) expect(body, `${sel} sets ${t}`).not.toMatch(new RegExp(`(^|[;\\s])${t}:`));
        expect(body, sel).not.toMatch(/--font-(?:sora|inter|mono):|font-family:/);
      }
      expect(cssSrc).not.toMatch(/Trebuchet|Segoe UI|data-theme|prefers-color-scheme/);
    });

    it("defines radii, gutters, content width and the focus ring on the wrapper, on the header's column", () => {
      const wrapper = rules(cssSrc).filter(([sel]) => sel === ".landing-desk").map(([, b]) => b).join("\n");
      // 1280 px with 16 / 24 px gutters is SiteHeader's max-w-7xl px-4 sm:px-6, so the logo and the hero share one edge.
      for (const t of ["--radius-control: 8px;", "--radius-group: 10px;", "--radius-badge: 6px;", "--focus-ring-width: 3px;", "--focus-ring-offset: 4px;", "--content-max: 1280px;", "--gutter: 16px;", "--gutter: 24px;"]) {
        expect(wrapper, t).toContain(t);
      }
      expect(cssSrc).toMatch(/\.landing-desk \.desk-btn \{[^}]*min-height: 48px;/);
    });

    it("leaves the global tokens, fonts, Tailwind theme and shared chrome as they were", () => {
      const globals = readFileSync("src/app/globals.css", "utf8");
      const root = globals.match(/:root \{([^}]*)\}/)?.[1] ?? "";
      for (const t of ["--bg: 245 247 251;", "--ink: 11 18 32;", "--primary: 14 116 144;", "--line: 220 227 238;", "--alert: 220 38 38;"]) expect(root).toContain(t);
      expect(globals).not.toMatch(/landing-desk|desk-|--radius-control|--content-max/);
      expect(readFileSync("src/app/layout.tsx", "utf8")).toContain('from "next/font/google"');
      const tw = readFileSync("tailwind.config.ts", "utf8");
      expect(tw).toContain('borderRadius: { panel: "10px", sheet: "14px" }');
      expect(tw).toContain('heading: ["var(--font-sora)"');
      // Only the home page loads the stylesheet.
      expect(pageSrc).toContain('import "@/components/landing/landing-desk.css";');
    });

    it("wraps the page content, not the shared footer, in .landing-desk", () => {
      const open = html.indexOf('<div class="landing-desk">');
      const footer = html.indexOf("<footer");
      expect(open).toBe(0);
      expect(footer).toBeGreaterThan(open);
      // The wrapper closes before the footer starts: the footer is a sibling, not a child.
      expect(html.slice(footer - "</div>".length, footer)).toBe("</div>");
      expect(html.slice(footer)).not.toContain("landing-desk");
      expect(html.slice(footer)).not.toMatch(/desk-/);
    });
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
