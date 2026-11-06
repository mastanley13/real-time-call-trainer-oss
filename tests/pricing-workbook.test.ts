import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingPage from "@/app/pricing/page";
import { FREE_VOICE_MIN, MINUTES_ROUNDED_NOTE, PRICE, PRO_VOICE_MIN, TEAM_MIN_SEATS, TEAM_VOICE_MIN_PER_SEAT, checkoutStartHref } from "@/lib/pricing";
import {
  PLAN_CTA, TEAM_MIN_MONTHLY_BILL, TEAM_MIN_POOL, TEXT_NO_VOICE_NOTE, WORKBOOK_HEADLINE, planHeads, workbookCaption, workbookRows,
} from "@/lib/pricingWorkbook";

afterEach(() => vi.unstubAllEnvs());

/** Render /pricing with checkout on (a Stripe test key) or off (no key). Premium stays off sale. */
function page(billing: boolean): string {
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
  vi.stubEnv("STRIPE_SECRET_KEY", billing ? "sk_test_placeholder" : "");
  return renderToStaticMarkup(createElement(PricingPage));
}

const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const between = (html: string, start: string, end: string) => {
  const i = html.indexOf(start);
  return i < 0 ? "" : html.slice(i, html.indexOf(end, i) + end.length);
};
const tableOf = (html: string) => between(html, "<table", "</table>");
const listsOf = (html: string) => html.slice(html.indexOf('data-layout="lists"'));
/** [label, href] for every link, in document order. */
const links = (html: string) => [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>([^<]*)<\/a>/g)].map((m) => [m[2], m[1].replaceAll("&amp;", "&")]);
/** One chunk per phone plan card, split on the plan headings. A chunk runs up to the next card's heading. */
const planCards = (html: string) => listsOf(html).split('<h3 id="tier-').slice(1);
/** The class list of each phone plan card's own wrapper. */
const cardWrappers = (html: string) => [...listsOf(html).matchAll(/<div class="(min-w-0 rounded-panel[^"]*)"/g)].map((m) => m[1]);

describe("headline", () => {
  it("is the only h1 and reads Compare Free, Pro and Team.", () => {
    const html = page(true);
    expect(WORKBOOK_HEADLINE).toBe("Compare Free, Pro and Team.");
    const h1s = [...html.matchAll(/<h1\b[^>]*>(.*?)<\/h1>/g)].map((m) => text(m[1]));
    expect(h1s).toEqual([WORKBOOK_HEADLINE]);
  });
});

describe("desktop table", () => {
  const html = page(true);
  const table = tableOf(html);

  it("has a caption that names it uniquely", () => {
    const caption = table.match(/<caption[^>]*>(.*?)<\/caption>/)?.[1];
    expect(caption).toBe(workbookCaption("month"));
    expect(html.split(caption!).length - 1).toBe(1);
    expect(workbookCaption("year")).not.toBe(workbookCaption("month"));
  });

  it("uses column headers for the plans and row headers for the bill, in order", () => {
    const cols = [...table.matchAll(/<th scope="col"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]));
    expect(cols).toHaveLength(4);
    expect(cols.slice(1).map((c) => c.split(" ")[0])).toEqual(["Free", "Pro", "Team"]);
    const rows = [...table.matchAll(/<th scope="row"[^>]*>(.*?)<\/th>/g)].map((m) => text(m[1]));
    expect(rows.slice(0, 4)).toEqual(["Price", "Voice minutes", "Minimum seats", "Minimum total bill"]);
    expect(rows.at(-1)).toBe("Choose your plan");
    // Every body row starts with a row header and has one cell per plan.
    for (const tr of table.slice(table.indexOf("<tbody")).match(/<tr\b[^>]*>.*?<\/tr>/g)!) {
      expect(tr).toMatch(/^<tr[^>]*><th scope="row"/);
      expect(tr.match(/<td\b/g)).toHaveLength(3);
    }
  });

  it("only shows from lg up, so it never overflows; phones and high zoom get the lists", () => {
    const wrap = html.match(/<div data-layout="table" class="([^"]+)"/)![1].split(" ");
    expect(wrap).toEqual(expect.arrayContaining(["hidden", "lg:block"]));
    expect(wrap.join(" ")).not.toMatch(/overflow-x|min-w-\[/);
    expect(table).toContain("table-fixed");
    const lists = html.match(/<div data-layout="lists" class="([^"]+)"/)![1].split(" ");
    expect(lists).toContain("lg:hidden");
  });

  it("gives Pro the one restrained emphasis: a subtle fill on its column only, no halo", () => {
    const filled = [...table.matchAll(/<t[hd]\b[^>]*class="[^"]*\bbg-sunken\b[^"]*"[^>]*>/g)];
    // Header, price, the comparison rows and the button row.
    expect(filled).toHaveLength(workbookRows("month").length + 3);
    expect(text(between(table, filled[0][0], "</th>"))).toMatch(/^Pro\b/);
    expect(html.slice(html.indexOf('id="plans"'), html.indexOf('id="pool-h"'))).not.toMatch(/\b(?:shadow|ring)-|halo|glow/);
  });
});

describe("phone lists", () => {
  const html = page(true);
  const cards = planCards(html);

  it("stack one semantic definition list per plan, Free first and always shown", () => {
    expect(cards).toHaveLength(3);
    expect(cards.map((c) => c.slice(0, c.indexOf('"')))).toEqual(["free", "pro", "team"]);
    for (const c of cards) {
      const dl = between(c, "<dl", "</dl>");
      expect(dl).not.toBe("");
      const dts = [...dl.matchAll(/<dt[^>]*>(.*?)<\/dt>/g)].map((m) => m[1]);
      const dds = [...dl.matchAll(/<dd[^>]*>(.*?)<\/dd>/g)].map((m) => m[1]);
      expect(dts.slice(0, 3)).toEqual(["Voice minutes", "Minimum seats", "Minimum total bill"]);
      expect(dds).toHaveLength(dts.length);
    }
    expect(cardWrappers(html)[0]).not.toMatch(/hidden/);
  });

  it("borders only the Pro card in the primary color", () => {
    const wrappers = cardWrappers(html);
    expect(wrappers).toHaveLength(3);
    expect(wrappers.map((c) => c.split(" ").includes("border-primary"))).toEqual([false, true, false]);
  });

  it("shows each plan's minutes from the locked numbers", () => {
    expect(cards[0]).toContain(`${FREE_VOICE_MIN} a month`);
    expect(cards[1]).toContain(`${PRO_VOICE_MIN} a month`);
    expect(cards[2]).toContain("300 per seat a month, pooled (900 at 3 seats)");
  });
});

describe("copy and numbers", () => {
  it("match the constants in pricing.ts", () => {
    expect([FREE_VOICE_MIN, PRO_VOICE_MIN, TEAM_VOICE_MIN_PER_SEAT, TEAM_MIN_SEATS]).toEqual([10, 200, 300, 3]);
    expect([PRICE.pro.month, PRICE.team.month]).toEqual([29, 59]);
    expect(TEAM_MIN_MONTHLY_BILL).toBe(PRICE.team.month * TEAM_MIN_SEATS);
    expect(TEAM_MIN_MONTHLY_BILL).toBe(177);
    expect(TEAM_MIN_POOL).toBe(900);
    const m = planHeads("month");
    expect([m.free.price, m.pro.price, m.team.price]).toEqual(["$0", "$29", "$59"]);
  });

  it("shows the $177 Team minimum right beside the $59 unit price, at both widths", () => {
    const html = page(true);
    const teamPrice = between(tableOf(html), ">Price</th>", "</tr>").split("<td").at(-1)!;
    expect(text(teamPrice.slice(teamPrice.indexOf(">") + 1))).toBe("$59 per seat, per month $177 a month minimum");
    const teamCard = planCards(html)[2];
    expect(text(teamCard.slice(teamCard.indexOf(">") + 1, teamCard.indexOf("<dl")))).toMatch(/^Team \$59 per seat, per month \$177 a month minimum/);
    expect(between(tableOf(html), ">Minimum total bill</th>", "</tr>")).toContain("$177 a month");
  });

  it("states rounding and that unlimited text uses no voice minutes", () => {
    const html = page(true);
    expect(html).toContain(`${MINUTES_ROUNDED_NOTE} ${TEXT_NO_VOICE_NOTE}`);
    expect(TEXT_NO_VOICE_NOTE).toBe("Unlimited text practice uses no voice minutes.");
    expect(html).toContain("3 seats include 900 shared voice minutes a month. Team starts at $177 a month.");
  });

  it("publishes no $20 or $40 Premium price", () => {
    for (const on of [true, false]) expect(page(on)).not.toMatch(/\$(?:20|40|200)(?!\d)/);
  });

  it("annual view: prices from pricing.ts and no invented annual total", () => {
    const y = planHeads("year");
    expect([y.pro.price, y.team.price, y.team.minimum]).toEqual(["$290", "$590", "3-seat minimum"]);
    const min = workbookRows("year").find((r) => r.id === "minimum")!.cells;
    expect(min).toEqual({ free: "$0", pro: "$290 a year", team: "3 seats at $590 a year each" });
    expect(JSON.stringify(workbookRows("year"))).not.toMatch(/1,?770/);
  });
});

describe("plan buttons", () => {
  it("billing on: Start free, no card, Start Pro and Start with Team, with the current sign-up links", () => {
    const html = page(true);
    const table = links(tableOf(html));
    expect(table).toEqual([
      [PLAN_CTA.free, "/register?src=pricing"],
      [PLAN_CTA.pro, "/register?plan=pro&interval=month&src=pricing"],
      [PLAN_CTA.team, "/register?plan=team&interval=month&src=pricing"],
    ]);
    expect(PLAN_CTA).toEqual({ free: "Start free, no card", pro: "Start Pro", team: "Start with Team" });
    // The phone lists carry the same labels and links.
    expect(links(listsOf(html)).slice(0, 3)).toEqual(table);
  });

  it("paid buttons never say Start free, with billing on or off", () => {
    for (const on of [true, false]) {
      const paid = links(page(on)).filter(([, href]) => /[?&]plan=(?:pro|team)/.test(href));
      expect(paid).toHaveLength(4);
      for (const [label] of paid) expect(label).not.toMatch(/start free/i);
    }
  });

  it("keeps the routes: sign-up links only, no new checkout links on this page", () => {
    const hrefs = links(page(true)).map(([, h]) => h);
    expect(hrefs.join(" ")).not.toContain(checkoutStartHref("pro").split("?")[0]);
  });
});

describe("landmarks and headings", () => {
  const html = page(true);

  it("gives every section and nav a unique, purposeful name", () => {
    const tags = [...html.matchAll(/<(?:section|nav|aside)\b[^>]*>|<[a-z]+\b[^>]*role="region"[^>]*>/g)].map((m) => m[0]);
    const names = tags.map((tag) => {
      const label = tag.match(/aria-label="([^"]+)"/)?.[1];
      if (label) return label;
      const id = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
      const h = id ? html.match(new RegExp(`<(h[1-6])\\b[^>]*id="${id}"[^>]*>(.*?)</\\1>`)) : null;
      return h ? text(h[2]) : null;
    });
    expect(names).not.toContain(null);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(expect.arrayContaining(["Plans and prices", "One pool for the team.", "Premium AI voice", "Questions", "Prefer to run it yourself?"]));
    expect(html).not.toContain('role="region"');
  });

  it("goes h1, h2, h3 without skipping a level, and #tier-free sits under the Plans h2", () => {
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1], `heading ${i}`).toBeLessThanOrEqual(1);
    const before = html.slice(0, html.indexOf('id="tier-free"'));
    expect(html).toMatch(/<h3 id="tier-free"/);
    expect([...before.matchAll(/<h([1-6])\b[^>]*>/g)].at(-1)![0]).toContain('id="plans-h"');
    expect(before.match(/<h2\b[^>]*id="plans-h"/)).not.toBeNull();
  });

  it("puts the page under the shared focus-strong ring", () => {
    expect(html.startsWith('<div class="focus-strong')).toBe(true);
  });
});

describe("design rules", () => {
  const files = ["src/app/pricing/page.tsx", "src/components/landing/PricingCards.tsx", "src/lib/pricingWorkbook.ts"];

  it.each(files)("%s has no color literals, palette classes, gradients, dashes, sparkle icons or remote fonts", (f) => {
    const src = readFileSync(f, "utf8");
    expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(\d|\b(?:slate|gray|red|teal|emerald|blue|green|amber)-\d/);
    expect(src).not.toMatch(/gradient|Sparkle|Star\b|Wand|fonts\.googleapis|next\/font/);
    expect(src).not.toMatch(/[–—]/);
  });

  it("renders no emoji, gradients or env names", () => {
    const html = page(true);
    // Built at runtime: tsconfig targets ES2017, which predates Unicode property escapes in regex literals.
    expect(html).not.toMatch(new RegExp("\\p{Extended_Pictographic}", "u"));
    expect(html).not.toMatch(/gradient/);
    expect(html).not.toMatch(/\b(?:LLM|OPENAI|ELEVENLABS|REALTIME|STRIPE|PREMIUM_VOICE)_[A-Z_]+/);
  });
});
