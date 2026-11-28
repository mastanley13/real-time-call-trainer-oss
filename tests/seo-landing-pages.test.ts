import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/compete",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/contexts/AuthContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/contexts/AuthContext")>()),
  useAuth: () => ({ capabilities: null, isAuthenticated: false, isLoading: true, user: null }),
}));

import AiSalesRoleplayPage, { metadata as roleplayMeta } from "@/app/ai-sales-roleplay/page";
import AltHyperboundPage, { metadata as altHbMeta } from "@/app/alternatives/hyperbound/page";
import AltYoodliPage, { metadata as altYoMeta } from "@/app/alternatives/yoodli/page";
import AlarmPage, { metadata as alarmMeta } from "@/app/use-cases/alarm-monitoring/page";
import Dispatch911Page, { metadata as dispatchMeta } from "@/app/use-cases/911-dispatch/page";
import { metadata as homeMeta } from "@/app/page";
import sitemap from "@/app/sitemap";
import PublicFooter from "@/components/landing/PublicFooter";
import { ALL_COMPARE_PAGES, jsonLdScript, richText } from "@/lib/comparisons";
import { FREE_VOICE_MIN, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT } from "@/lib/pricing";
import { SEO_LANDING_PAGES } from "@/lib/seoLandings";

afterEach(() => vi.unstubAllEnvs());

const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const titleOf = (m: { title?: unknown }) => (m.title as { absolute: string }).absolute;
const ldBlocks = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const dollars = (s: string) => new Set([...s.matchAll(/\$\s?\d[\d,.]*/g)].map((m) => m[0].replace(/[.,]$/, "")));
const plain = (html: string, sep = "") => decode(html.replace(/<[^>]+>/g, sep));

const OWN = ["$0", `$${PRICE.pro.month}`, `$${PRICE.pro.year}`, `$${PRICE.team.month}`, `$${PRICE.team.year}`];
const YOODLI_FAQ = ["$8", "$20"];

const PAGES = [
  {
    route: "/ai-sales-roleplay", Page: AiSalesRoleplayPage, meta: roleplayMeta, src: "ai-sales-roleplay",
    title: "AI Sales Roleplay Software | Call Trainer", h1: "AI sales roleplay software",
    ldType: "CollectionPage", allowed: OWN,
  },
  {
    route: "/alternatives/hyperbound", Page: AltHyperboundPage, meta: altHbMeta, src: "alternatives-hyperbound",
    title: "Hyperbound Alternative for Small Sales Teams | Call Trainer", h1: "A Hyperbound alternative you can start in minutes",
    ldType: "WebPage", allowed: OWN,
  },
  {
    route: "/alternatives/yoodli", Page: AltYoodliPage, meta: altYoMeta, src: "alternatives-yoodli",
    title: "Yoodli Alternative for Sales Call Practice | Call Trainer", h1: "A Yoodli alternative built for sales calls",
    ldType: "WebPage", allowed: [...OWN, ...YOODLI_FAQ],
  },
  {
    route: "/use-cases/alarm-monitoring", Page: AlarmPage, meta: alarmMeta, src: "use-alarm-monitoring",
    title: "Alarm Monitoring Call Center Training | Call Trainer", h1: "Practice the alarm monitoring calls that stall the night shift",
    ldType: "WebPage", allowed: OWN,
  },
  {
    route: "/use-cases/911-dispatch", Page: Dispatch911Page, meta: dispatchMeta, src: "use-911-dispatch",
    title: "911 Dispatcher Call-Taking Practice | Call Trainer", h1: "Practice 911 call-taking before the next live line",
    ldType: "WebPage", allowed: OWN,
  },
] as const;

describe.each(PAGES)("$route", (p) => {
  const html = renderToStaticMarkup(createElement(p.Page));
  const text = plain(html);
  const links = hrefs(html);
  const copy = SEO_LANDING_PAGES.find((c) => c.path === p.route)!;

  it("ships a unique title, description, H1 and self-referencing canonical", () => {
    vi.stubEnv("APP_URL", "");
    expect(titleOf(p.meta)).toBe(p.title);
    expect(p.meta.description).toBe(copy.description);
    expect(p.meta.description).not.toBe(homeMeta.description);
    expect(p.meta.alternates?.canonical).toBe(`https://calltrainer.tech${p.route}`);
    expect(p.meta.openGraph?.url).toBe(`https://calltrainer.tech${p.route}`);
    expect(p.meta.openGraph?.title).toBe(p.title);
    expect((p.meta.twitter as { card?: string }).card).toBe("summary_large_image");
  });

  it("server-renders one H1, the subhead, every section and every FAQ answer", () => {
    expect(h1s(html)).toEqual([p.h1]);
    expect(html).not.toMatch(/Loading/);
    expect(text).toContain(copy.subhead);
    for (const s of copy.sections) {
      if (s.heading) expect(text).toContain(s.heading);
      for (const b of s.blocks) {
        const items = "p" in b ? [b.p] : "ul" in b ? b.ul : b.table.rows.flat();
        for (const r of items) expect(text).toContain(richText(r));
      }
    }
    for (const f of copy.faq) {
      expect(text).toContain(f.q);
      expect(text).toContain(richText(f.a));
    }
  });

  it("links the kebab-case sign-up CTA and the pricing page", () => {
    expect(text).toContain("Start free, no card");
    expect(text).toContain("See Call Trainer pricing");
    expect(links).toContain(`/register?src=${p.src}`);
    expect(links).toContain("/pricing");
    expect(links.filter((h) => h.startsWith("/register")).every((h) => h === `/register?src=${p.src}`)).toBe(true);
  });

  it("emits one FAQPage with 4-6 questions and no review schema", () => {
    const blocks = ldBlocks(html);
    const types = blocks.flatMap((b) => (b["@graph"] ? (b["@graph"] as { "@type": string }[]).map((n) => n["@type"]) : [b["@type"] as string]));
    expect(types.filter((t) => t === "FAQPage")).toHaveLength(1);
    expect(types).toContain(p.ldType);
    expect(JSON.stringify(blocks)).not.toMatch(/Review|AggregateRating|ratingValue|reviewCount/);
    const faq = blocks.find((b) => b["@type"] === "FAQPage") as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
    expect(faq.mainEntity.length).toBeLessThanOrEqual(6);
    expect(faq.mainEntity.map((q) => q.name)).toEqual(copy.faq.map((f) => f.q));
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text).not.toMatch(/[[\]`"]/);
  });

  it("shows no dollar amount beyond Call Trainer's prices and the drafted competitor figures", () => {
    expect([...dollars(text)].filter((d) => !(p.allowed as readonly string[]).includes(d))).toEqual([]);
  });

  it("uses no em or en dashes", () => expect(text).not.toMatch(/[\u2013\u2014]/));
});

describe("SEO landing copy", () => {
  it("has a unique title, description and H1 on every new page, different from the homepage and /vs pages", () => {
    const titles = [...ALL_COMPARE_PAGES, ...SEO_LANDING_PAGES].map((c) => c.title);
    const h1 = [...ALL_COMPARE_PAGES, ...SEO_LANDING_PAGES].map((c) => c.h1);
    const descriptions = [...ALL_COMPARE_PAGES, ...SEO_LANDING_PAGES].map((c) => c.description);
    expect(new Set(titles).size).toBe(titles.length);
    expect(new Set(h1).size).toBe(h1.length);
    expect(new Set([...descriptions, homeMeta.description]).size).toBe(descriptions.length + 1);
  });

  it("matches the live Call Trainer plan numbers, so a price change forces a copy review", () => {
    const copy = JSON.stringify(SEO_LANDING_PAGES);
    expect(copy).toContain(`Pro is $${PRICE.pro.month} a month or $${PRICE.pro.year} a year`);
    expect(copy).toContain(`Team is $${PRICE.team.month} per seat per month or $${PRICE.team.year} per seat per year`);
    expect(copy).toContain(`${TEAM_MIN_SEATS}-seat minimum`);
    expect(copy).toContain(`${PRO_VOICE_MIN} voice minutes a month`);
    expect(copy).toContain(`${TEAM_VOICE_MIN_PER_SEAT} pooled voice minutes per seat`);
    expect(copy).toContain(`Free is $0, no card, with ${FREE_VOICE_MIN} voice minutes a month`);
  });

  it("does not invent a Hyperbound paid amount or cite reviews, logos or testimonials", () => {
    const hb = JSON.stringify(SEO_LANDING_PAGES.find((p) => p.path === "/alternatives/hyperbound"));
    expect(hb).not.toMatch(/\$40k|\$40,000|40k ACV|G2|testimonial|Trusted by/i);
    const all = JSON.stringify(SEO_LANDING_PAGES);
    expect(all).not.toMatch(/graded against APCO|graded against NENA|is certified by APCO|are certified by APCO/);
  });

  it("keeps new source files free of em and en dashes", () => {
    for (const f of [
      "src/lib/seoLandings.ts",
      "src/lib/comparisons.ts",
      "src/components/compare/ComparePage.tsx",
      "src/components/landing/PublicFooter.tsx",
      "src/app/ai-sales-roleplay/page.tsx",
      "src/app/alternatives/hyperbound/page.tsx",
      "src/app/alternatives/yoodli/page.tsx",
      "src/app/use-cases/alarm-monitoring/page.tsx",
      "src/app/use-cases/911-dispatch/page.tsx",
    ]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("911 dispatch claims", () => {
  it("says grades are coaching feedback and does not claim grading against standards", () => {
    const html = renderToStaticMarkup(createElement(Dispatch911Page));
    const text = plain(html, " ");
    expect(text).toContain("Grades are coaching feedback, not certification");
    expect(text).toContain("not affiliated with, endorsed by or certified by APCO, NENA, NFPA, the AHA");
    expect(text).not.toMatch(/graded against APCO|graded against NENA|graded against NFPA|graded against the AHA/i);
  });
});

describe("internal links", () => {
  it("adds the new SEO pages to the public footer", () => {
    const html = renderToStaticMarkup(createElement(PublicFooter));
    const links = hrefs(html);
    for (const h of ["/alternatives", "/ai-sales-roleplay", "/use-cases/alarm-monitoring", "/use-cases/911-dispatch"]) {
      expect(links).toContain(h);
    }
  });

  it("cross-links the hub, alternatives and use cases", () => {
    const hub = hrefs(renderToStaticMarkup(createElement(AiSalesRoleplayPage)));
    for (const h of ["/alternatives/hyperbound", "/alternatives/yoodli", "/alternatives", "/use-cases/alarm-monitoring", "/use-cases/911-dispatch", "/vs/hyperbound", "/vs/yoodli"]) {
      expect(hub).toContain(h);
    }
    expect(hrefs(renderToStaticMarkup(createElement(AltHyperboundPage)))).toContain("/vs/hyperbound");
    expect(hrefs(renderToStaticMarkup(createElement(AltYoodliPage)))).toContain("/vs/yoodli");
    expect(hrefs(renderToStaticMarkup(createElement(AlarmPage)))).toContain("/use-cases/911-dispatch");
    expect(hrefs(renderToStaticMarkup(createElement(Dispatch911Page)))).toContain("/use-cases/alarm-monitoring");
  });

  it("lists the five pages in the sitemap without duplicates", () => {
    vi.stubEnv("APP_URL", "");
    const urls = sitemap().map((e) => e.url);
    for (const p of ["/ai-sales-roleplay", "/alternatives/hyperbound", "/alternatives/yoodli", "/use-cases/alarm-monitoring", "/use-cases/911-dispatch"]) {
      expect(urls).toContain(`https://calltrainer.tech${p}`);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
});

describe("jsonLdScript", () => {
  it("still escapes < so the script tag cannot be closed early", () => {
    expect(jsonLdScript({ a: "</script>" })).toBe('{"a":"\\u003c/script>"}');
  });
});
