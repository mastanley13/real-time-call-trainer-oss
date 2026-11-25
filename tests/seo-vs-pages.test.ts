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

import AlternativesPage, { metadata as altMeta } from "@/app/alternatives/page";
import CompetePage from "@/app/compete/page";
import { metadata as homeMeta } from "@/app/page";
import sitemap from "@/app/sitemap";
import VsHyperboundPage, { metadata as hbMeta } from "@/app/vs/hyperbound/page";
import VsSecondNaturePage, { metadata as snMeta } from "@/app/vs/second-nature/page";
import VsYoodliPage, { metadata as yoMeta } from "@/app/vs/yoodli/page";
import PublicFooter from "@/components/landing/PublicFooter";
import { ALL_COMPARE_PAGES, ALTERNATIVES_PAGE, VS_PAGES, faqJsonLd, jsonLdScript, parseRich, richText } from "@/lib/comparisons";
import { FREE_VOICE_MIN, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT } from "@/lib/pricing";
import { COMPARISON_SLUGS } from "@/lib/publicPaths";

afterEach(() => vi.unstubAllEnvs());

const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const titleOf = (m: { title?: unknown }) => (m.title as { absolute: string }).absolute;
const ldBlocks = (html: string) =>
  [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]) as Record<string, unknown>);
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => decode(m[1]));
const dollars = (s: string) => new Set([...s.matchAll(/\$\s?\d[\d,.]*/g)].map((m) => m[0].replace(/[.,]$/, "")));

/** Call Trainer's own published amounts, the only dollar figures a /vs page may show besides drafted competitor figures. */
const OWN = ["$0", `$${PRICE.pro.month}`, `$${PRICE.pro.year}`, `$${PRICE.team.month}`, `$${PRICE.team.year}`];
/** Yoodli Pro and Advanced, from Yoodli's public pricing FAQ on 25 November 2026. */
const YOODLI_FAQ = ["$8", "$20"];

const PAGES = [
  {
    route: "/vs/second-nature", Page: VsSecondNaturePage, meta: snMeta, src: "vs-second-nature",
    title: "Call Trainer vs Second Nature | Pricing and Fit", h1: "Call Trainer vs Second Nature",
    description: "A fair look at Call Trainer and Second Nature, from public pages checked on 25 November 2026. Published prices, coaching, and who each one may fit.",
    allowed: OWN,
  },
  {
    route: "/vs/hyperbound", Page: VsHyperboundPage, meta: hbMeta, src: "vs-hyperbound",
    title: "Call Trainer vs Hyperbound | Pricing and Fit", h1: "Call Trainer vs Hyperbound",
    description: "A fair look at Call Trainer and Hyperbound, from public pages checked on 25 November 2026. Free starting points, published plans, and who each may fit.",
    allowed: OWN,
  },
  {
    route: "/vs/yoodli", Page: VsYoodliPage, meta: yoMeta, src: "vs-yoodli",
    title: "Call Trainer vs Yoodli | Pricing and Fit", h1: "Call Trainer vs Yoodli",
    description: "A fair look at Call Trainer and Yoodli, from public pages checked on 25 November 2026. Individual plans, team pricing, and who each one may fit.",
    allowed: [...OWN, ...YOODLI_FAQ],
  },
  {
    route: "/alternatives", Page: AlternativesPage, meta: altMeta, src: "alternatives",
    title: "AI Sales Roleplay Alternatives | Call Trainer", h1: "AI sales roleplay alternatives",
    description: "Compare Call Trainer with Hyperbound, Second Nature, and Yoodli. A short, fair hub from public pages checked on 25 November 2026.",
    allowed: [...OWN, ...YOODLI_FAQ],
  },
] as const;

/** Visible text plus JSON-LD: tags removed, entities decoded. */
const plain = (html: string, sep = "") => decode(html.replace(/<[^>]+>/g, sep));

describe.each(PAGES)("$route", (p) => {
  const html = renderToStaticMarkup(createElement(p.Page));
  const text = plain(html);
  const links = hrefs(html);

  it("ships the drafted title, description and self-referencing canonical", () => {
    vi.stubEnv("APP_URL", "");
    expect(titleOf(p.meta)).toBe(p.title);
    expect(p.meta.description).toBe(p.description);
    expect(p.meta.alternates?.canonical).toBe(`https://calltrainer.tech${p.route}`);
    expect(p.meta.openGraph?.url).toBe(`https://calltrainer.tech${p.route}`);
  });

  it("server-renders one H1, the subhead, every section and every FAQ answer", () => {
    expect(h1s(html)).toEqual([p.h1]);
    expect(html).not.toMatch(/Loading/);
    const copy = ALL_COMPARE_PAGES.find((c) => c.path === p.route)!;
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

  it("emits one FAQPage and a page node, with no review or rating schema", () => {
    const blocks = ldBlocks(html);
    const types = blocks.flatMap((b) => (b["@graph"] ? (b["@graph"] as { "@type": string }[]).map((n) => n["@type"]) : [b["@type"] as string]));
    expect(types.filter((t) => t === "FAQPage")).toHaveLength(1);
    expect(types).toContain(p.route === "/alternatives" ? "CollectionPage" : "WebPage");
    const raw = JSON.stringify(blocks);
    expect(raw).not.toMatch(/Review|AggregateRating|ratingValue|reviewCount/);
    const faq = blocks.find((b) => b["@type"] === "FAQPage") as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
    const copy = ALL_COMPARE_PAGES.find((c) => c.path === p.route)!;
    expect(faq.mainEntity.map((q) => q.name)).toEqual(copy.faq.map((f) => f.q));
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text).not.toMatch(/[[\]`"]/);
  });

  it("shows no dollar amount beyond Call Trainer's prices and the drafted competitor figures", () => {
    expect([...dollars(text)].filter((d) => !(p.allowed as readonly string[]).includes(d))).toEqual([]);
  });

  it("uses no em or en dashes", () => expect(text).not.toMatch(/[\u2013\u2014]/));
});

describe("/vs pages", () => {
  it("each link back to /alternatives and /compete", () => {
    for (const Page of [VsSecondNaturePage, VsHyperboundPage, VsYoodliPage]) {
      const links = hrefs(renderToStaticMarkup(createElement(Page)));
      expect(links).toContain("/alternatives");
      expect(links).toContain("/compete");
    }
  });

  it("keep Second Nature unpriced and cite the failing pricing URL", () => {
    const html = renderToStaticMarkup(createElement(VsSecondNaturePage));
    const text = plain(html, " ");
    expect(text).toContain("returned HTTP 500 on 25 November 2026");
    expect(text).toContain("This page does not quote a Second Nature price.");
    // Every dollar figure on the page is one of Call Trainer's own.
    expect([...dollars(text)].every((d) => OWN.includes(d))).toBe(true);
    const ld = JSON.stringify(ldBlocks(html));
    expect([...dollars(ld)].every((d) => OWN.includes(d))).toBe(true);
    // The Second Nature column, and every paragraph, list item or FAQ answer that names Second Nature, has no dollar figure.
    const sn = VS_PAGES["second-nature"];
    const blocks = sn.sections.flatMap((s) => s.blocks);
    const column = blocks.flatMap((b) => ("table" in b ? b.table.rows.map((r) => r[2]) : []));
    const prose = [...blocks.flatMap((b) => ("p" in b ? [b.p] : "ul" in b ? b.ul : [])), ...sn.faq.flatMap((f) => [f.a, f.ld])];
    expect(column.filter((c) => /\$\d/.test(c))).toEqual([]);
    expect(prose.filter((s) => /Second Nature/.test(s) && /\$\d/.test(s))).toEqual([]);
  });

  it("quote no Hyperbound paid amount and no Yoodli Business amount", () => {
    const hb = plain(renderToStaticMarkup(createElement(VsHyperboundPage)), " ");
    expect([...dollars(hb)].every((d) => OWN.includes(d))).toBe(true);
    const yo = plain(renderToStaticMarkup(createElement(VsYoodliPage)), " ");
    expect(yo).toContain("No Business dollar amount was shown on the page we loaded.");
    expect(yo.match(/Business[^.]*\$\d/g)).toBeNull();
  });
});

describe("/alternatives hub", () => {
  it("links all three comparisons, the demo, sign-up and pricing", () => {
    const links = hrefs(renderToStaticMarkup(createElement(AlternativesPage)));
    for (const s of COMPARISON_SLUGS) expect(links).toContain(`/vs/${s}`);
    for (const h of ["/register?src=alternatives", "/pricing", "/demo"]) expect(links).toContain(h);
  });

  it("does not merge the comparison FAQs into its own", () => {
    // The hub keeps its own five questions; none of the competitor-specific comparison questions move onto it.
    const hub = new Set(ALTERNATIVES_PAGE.faq.map((f) => f.q));
    expect(hub.size).toBe(5);
    for (const s of COMPARISON_SLUGS) {
      for (const f of VS_PAGES[s].faq.filter((x) => /Second Nature|Hyperbound|Yoodli/.test(x.q))) expect(hub.has(f.q), f.q).toBe(false);
    }
  });
});

describe("comparison copy", () => {
  it("has a unique title, description and H1 on every page, different from the homepage", () => {
    const all = [...ALL_COMPARE_PAGES.map((c) => c.description), homeMeta.description];
    expect(new Set(all).size).toBe(all.length);
    expect(new Set(ALL_COMPARE_PAGES.map((c) => c.title)).size).toBe(ALL_COMPARE_PAGES.length);
    expect(new Set(ALL_COMPARE_PAGES.map((c) => c.h1)).size).toBe(ALL_COMPARE_PAGES.length);
  });

  it("matches the live Call Trainer plan numbers, so a price change forces a copy review", () => {
    const copy = JSON.stringify(ALL_COMPARE_PAGES);
    expect(copy).toContain(`Pro, $${PRICE.pro.month} a month or $${PRICE.pro.year} a year, ${PRO_VOICE_MIN} voice minutes a month`);
    expect(copy).toContain(`Team is $${PRICE.team.month} per seat per month or $${PRICE.team.year} per seat per year, with a ${TEAM_MIN_SEATS}-seat minimum`);
    expect(copy).toContain(`${TEAM_VOICE_MIN_PER_SEAT} pooled voice minutes per seat`);
    expect(copy).toContain(`Free plan, $0, no card, ${FREE_VOICE_MIN} voice minutes a month`);
  });

  it("dates every page to the 25 November 2026 recheck", () => {
    for (const c of ALL_COMPARE_PAGES) {
      expect(c.description).toContain("25 November 2026");
      expect(c.subhead).toContain("25 November 2026");
    }
  });

  it("keeps new source files free of em and en dashes", () => {
    for (const f of ["src/lib/comparisons.ts", "src/components/compare/ComparePage.tsx", "src/app/compete/page.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("parseRich", () => {
  it("splits links and code, and keeps links to the live site on the current host", () => {
    expect(parseRich("See [/pricing](https://calltrainer.tech/pricing), `/for` and [home](https://calltrainer.tech/).")).toEqual([
      { text: "See " }, { href: "/pricing", label: "/pricing" }, { text: ", " }, { code: "/for" }, { text: " and " }, { href: "/", label: "home" }, { text: "." },
    ]);
    expect(parseRich("[Yoodli pricing](https://yoodli.ai/pricing)")).toEqual([{ href: "https://yoodli.ai/pricing", label: "Yoodli pricing" }]);
    expect(parseRich("[x](https://calltrainer.tech.evil.example/a)")).toEqual([{ href: "https://calltrainer.tech.evil.example/a", label: "x" }]);
  });
});

describe("JSON-LD", () => {
  it("escapes < so the script tag cannot be closed early", () => {
    expect(jsonLdScript({ a: "</script>" })).toBe('{"a":"\\u003c/script>"}');
  });

  it("builds FAQPage straight from the drafted answers", () => {
    const ld = faqJsonLd(VS_PAGES.yoodli);
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity[3].acceptedAnswer.text).toBe(
      "The pricing FAQ loaded on 25 November 2026 states that Pro is $8/month billed annually and Advanced is $20/month billed annually. Starter is described as 5 lifetime sessions.",
    );
  });
});

describe("internal links", () => {
  it("adds Alternatives to the public footer", () => {
    const html = renderToStaticMarkup(createElement(PublicFooter));
    expect(hrefs(html)).toContain("/alternatives");
    expect(decode(html)).toContain(">Alternatives<");
  });

  it("links /compete to the hub and the three comparisons", () => {
    const links = hrefs(renderToStaticMarkup(createElement(CompetePage)));
    for (const h of ["/alternatives", "/vs/hyperbound", "/vs/second-nature", "/vs/yoodli"]) expect(links).toContain(h);
  });

  it("lists all four pages in the sitemap and keeps /library and /compete", () => {
    vi.stubEnv("APP_URL", "");
    const urls = sitemap().map((e) => e.url);
    for (const p of ["/alternatives", "/vs/second-nature", "/vs/hyperbound", "/vs/yoodli", "/library", "/compete"]) {
      expect(urls).toContain(`https://calltrainer.tech${p}`);
    }
    expect(new Set(urls).size).toBe(urls.length);
  });
});
