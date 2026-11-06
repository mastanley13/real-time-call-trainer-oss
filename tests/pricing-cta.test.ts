import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingCards, { tierAction } from "@/components/landing/PricingCards";
import PricingSummary from "@/components/landing/PricingSummary";
import PricingPage from "@/app/pricing/page";
import Home from "@/app/page";
import { OPEN_SOON_LINE, PREMIUM_CALL_LENGTH_NOTE, PREMIUM_COMING_SOON, PREMIUM_DISCLOSURE_BOTH, PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_TEAM, PREMIUM_NUDGE_PRO, isPremiumOnSale, premiumPriceLine } from "@/lib/pricing";
import { billingOn } from "@/lib/serverConfig";

const cards = (billingEnabled: boolean) => renderToStaticMarkup(createElement(PricingCards, { billingEnabled }));
const summary = (billingEnabled: boolean) => renderToStaticMarkup(createElement(PricingSummary, { src: "pricing", seg: "saas", billingEnabled }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
const count = (html: string, text: string) => html.split(text).length - 1;

afterEach(() => vi.unstubAllEnvs());

/** The visible text of every link to a paid plan's sign-up. */
const paidLinkLabels = (html: string) =>
  [...html.matchAll(/<a[^>]*href="\/register\?plan=(?:pro|team)[^"]*"[^>]*>([^<]*)<\/a>/g)].map((m) => m[1]);

describe("PricingCards, billing off", () => {
  const html = cards(false);

  it("never labels a paid plan Start free; Create account with one open-soon note both buttons point to", () => {
    expect(html).not.toContain("Start Pro");
    expect(html).not.toContain("Start with Team");
    const labels = paidLinkLabels(html);
    // Pro and Team, once in the table and once in the phone lists.
    expect(labels).toHaveLength(4);
    for (const l of labels) {
      expect(l).toBe("Create account");
      expect(l).not.toMatch(/start free/i);
    }
    expect(count(html, OPEN_SOON_LINE)).toBe(1);
    expect(count(html, 'aria-describedby="plans-open-soon"')).toBe(4);
    expect(html).toContain('id="plans-open-soon"');
  });

  it("links to /register with plan, interval and src", () => {
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&src=pricing", "/register?plan=team&interval=month&src=pricing"]));
    expect(html).not.toContain("/checkout/start");
  });

  it("has no waitlist or email form", () => {
    expect(html).not.toMatch(/<form|type="email"/);
  });
});

describe("PricingCards, billing on", () => {
  const html = cards(true);

  it("keeps the paid labels and drops the open-soon line", () => {
    expect(html).toContain("Start Pro");
    expect(html).toContain("Start with Team");
    expect(html).not.toContain(OPEN_SOON_LINE);
    expect(html).not.toContain("aria-describedby");
    expect(paidLinkLabels(html).sort()).toEqual(["Start Pro", "Start Pro", "Start with Team", "Start with Team"]);
  });

  it("carries the plan, the monthly interval and src", () => {
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&src=pricing", "/register?plan=team&interval=month&src=pricing"]));
  });

  it("the toggle drives the interval in the hrefs", () => {
    // Static markup cannot click, so check the link builder the toggle state feeds.
    expect(tierAction("pro", "Start Pro", true, "year").href).toBe("/register?plan=pro&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "year").href).toBe("/register?plan=team&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "month").href).toBe("/register?plan=team&interval=month&src=pricing");
    // Billing off keeps the selected period in the link too, so sign-up stores it. The label never says Start free.
    expect(tierAction("pro", "Start Pro", false, "year")).toMatchObject({ cta: "Create account", href: "/register?plan=pro&interval=year&src=pricing", soon: true });
    expect(tierAction("team", "Start with Team", false, "month")).toMatchObject({ cta: "Create account", href: "/register?plan=team&interval=month&src=pricing", soon: true });
    expect(tierAction("free", "Start free, no card", false, "year")).toMatchObject({ cta: "Start free, no card", href: "/register?src=pricing", soon: false });
  });
});

describe("Premium add-on on the pricing page", () => {
  const page = () => renderToStaticMarkup(createElement(PricingPage));
  const premiumSection = (html: string) => html.slice(html.indexOf('aria-labelledby="premium-h"'), html.indexOf("</section>", html.indexOf('aria-labelledby="premium-h"')));

  it("off sale: a coming-soon badge and a not-for-sale note, no price and no button", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
    const s = premiumSection(page());
    expect(s).toContain(`class="badge-tag border border-line">${PREMIUM_COMING_SOON}</span>`);
    expect(s).toContain("This add-on is not available to purchase. Standard voice is included in your plan.");
    expect(s).not.toMatch(/<a |<button|href=|\$/);
    // Nothing is for sale, so no purchase terms are listed.
    expect(s).not.toContain("data-premium-terms");
    for (const t of [PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_TEAM, PREMIUM_CALL_LENGTH_NOTE]) expect(s).not.toContain(t);
  });

  it("flag on but billing off: premiumOnSale is false, so it reads as off sale with no terms", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    const s = premiumSection(page());
    expect(s).toContain(PREMIUM_COMING_SOON);
    expect(s).not.toContain("data-premium-terms");
    expect(s).not.toContain(PREMIUM_DISCLOSURE_PRO);
  });

  it("on sale: allowance, Team pooling and the call cap stay, verbatim, with no price and no button", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    const s = premiumSection(page());
    expect(s).not.toContain(PREMIUM_COMING_SOON);
    expect(s).toContain("Add-on for Pro and Team");
    expect(s).toContain("Premium minutes come out of your plan minutes, not on top.");
    const terms = [...s.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    expect(terms).toEqual([`On Pro: ${PREMIUM_DISCLOSURE_PRO}`, `On Team: ${PREMIUM_DISCLOSURE_TEAM}`, PREMIUM_CALL_LENGTH_NOTE]);
    // Allowance (40 per Pro account, 40 per Team seat), pooling, and the remaining-minutes cap.
    expect(s).toContain("After 40 Premium minutes");
    expect(s).toContain("Premium minutes are pooled, 40 per seat.");
    expect(s).toContain("capped at your remaining Premium minutes");
    expect(s).toContain("capped at the Premium minutes left in your pool");
    expect(s).not.toMatch(/<a |<button|href=|\$/);
  });

  it.each(["", "true"])("publishes no $20, $40 or $200 Premium price anywhere on the page (on sale: %j)", (v) => {
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", v);
    const html = page();
    expect(html).not.toMatch(/\$(?:20|40|200)(?!\d)/);
    expect(html).not.toMatch(/\+\$\d/);
    expect(html).not.toMatch(/\$30|\$300|60%/);
  });
});

describe("Premium copy constants (billing and checkout, not the pricing page)", () => {
  it("annual: $200, and Pro never says per seat", () => {
    expect(premiumPriceLine("pro", "year")).toBe("Premium voice: +$200 a year. 40 Premium minutes a month, then Standard.");
    expect(premiumPriceLine("team", "year")).toBe("Premium voice for Team: +$200 per seat a year, 40 pooled minutes per seat each month.");
    expect(premiumPriceLine("pro", "month")).not.toMatch(/seat/);
  });

  it("final copy (Margin sections 5 and 6, disclosures adapted for the Premium call cap, Prism u63 Medium 1)", () => {
    expect(premiumPriceLine("team", "month")).toBe("Premium voice for Team: +$20 per seat a month, 40 pooled minutes per seat.");
    expect(PREMIUM_DISCLOSURE_TEAM).toBe("Premium minutes are pooled, 40 per seat. After the pool is used, the next call starts on Standard voice. A Premium call is capped at the Premium minutes left in your pool, and we tell you before it starts. No overages.");
    expect(PREMIUM_DISCLOSURE_PRO).toBe("After 40 Premium minutes, the next call switches to Standard voice. A Premium call is capped at your remaining Premium minutes, and we tell you before it starts. You are never charged extra.");
    // Never promise an uninterrupted call of any length: the Premium call has a deadline (Prism u63 Medium 1).
    for (const s of [PREMIUM_DISCLOSURE_TEAM, PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_BOTH, PREMIUM_CALL_LENGTH_NOTE]) expect(s).not.toMatch(/never cut|in progress/);
    expect(PREMIUM_NUDGE_PRO).toBe("Premium minutes used. Your next call uses Standard voice, and nothing extra is charged. Premium resets on your billing date.");
    // Pro keeps no per-seat wording anywhere; Team says pooled.
    for (const s of [premiumPriceLine("pro", "month"), premiumPriceLine("pro", "year"), PREMIUM_DISCLOSURE_PRO, PREMIUM_NUDGE_PRO]) expect(s).not.toMatch(/seat/);
    expect(PREMIUM_DISCLOSURE_TEAM).toMatch(/pooled/);
    // The cap-specific note sits below the disclosure on setup and billing: no mid-call switch, and the call's deadline.
    expect(PREMIUM_CALL_LENGTH_NOTE).toMatch(/set to end when they run out/);
    for (const s of [PREMIUM_DISCLOSURE_TEAM, PREMIUM_DISCLOSURE_PRO, PREMIUM_NUDGE_PRO, PREMIUM_CALL_LENGTH_NOTE]) expect(s.includes(String.fromCharCode(0x2014))).toBe(false);
  });

  it("the pricing page says Standard voice is included", () => {
    expect(renderToStaticMarkup(createElement(PricingPage))).toContain("Standard voice is included in your plan.");
  });
});

describe("PricingSummary", () => {
  it("billing off: Start free with the open-soon line on Pro and Team", () => {
    const html = summary(false);
    expect(html).not.toContain("Start Pro");
    expect(html).not.toContain("Start with Team");
    expect(count(html, OPEN_SOON_LINE)).toBe(2);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&seg=saas&src=pricing", "/register?plan=team&interval=month&seg=saas&src=pricing"]));
  });

  it("billing on: the paid labels", () => {
    const html = summary(true);
    expect(html).toContain("Start Pro");
    expect(html).toContain("Start with Team");
    expect(html).not.toContain(OPEN_SOON_LINE);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&seg=saas&src=pricing", "/register?plan=team&interval=month&seg=saas&src=pricing"]));
  });
});

describe("billing state", () => {
  it("a live key with no flag, no key and demo mode read as off; a test key reads as on", () => {
    expect(billingOn({ STRIPE_SECRET_KEY: "sk_live_placeholder" })).toBe(false);
    expect(billingOn({ STRIPE_SECRET_KEY: "sk_live_placeholder", BILLING_LIVE_ENABLED: "" })).toBe(false);
    expect(billingOn({})).toBe(false);
    expect(billingOn({ STRIPE_SECRET_KEY: "sk_test_placeholder", DEMO_MODE: "true" })).toBe(false);
    expect(billingOn({ STRIPE_SECRET_KEY: "sk_test_placeholder" })).toBe(true);
  });

  it("the page renders the billing-off UI with a live key and the billing-on UI with a test key", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_placeholder");
    expect(renderToStaticMarkup(createElement(PricingPage))).not.toContain("Start Pro");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    const on = renderToStaticMarkup(createElement(PricingPage));
    expect(on).toContain("Start Pro");
    expect(on).toContain("Start with Team");
  });
});

describe("pricing page", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  const html = renderToStaticMarkup(createElement(PricingPage));

  it("billing off: no paid CTA text anywhere in the HTML, and no paid link reads Start free", () => {
    expect(html).not.toContain("Start Pro");
    expect(html).not.toContain("Start with Team");
    for (const l of paidLinkLabels(html)) expect(l).not.toMatch(/start free/i);
  });

  it("the Premium table row is gone: Premium is a status note, not a comparison cell", () => {
    expect(html).not.toContain(">Premium AI voice</th>");
  });

  it("off sale, the Premium FAQ starts with the label and carries no price", () => {
    const answer = html.slice(html.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).toMatch(new RegExp(`^<p[^>]*>${PREMIUM_COMING_SOON.replace(/[()]/g, "\\$&")}\\.`));
    expect(text).toContain("not available to purchase");
    expect(text).not.toMatch(/\$|\/mo|Team add-on first/);
  });

  it("off sale, the Premium FAQ states no allowance or call cap", () => {
    const answer = html.slice(html.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).not.toMatch(/Premium minutes|pooled|capped/);
  });

  it("on sale (PREMIUM_VOICE_ON_SALE=true with billing on), the FAQ drops the label, keeps allowance, pooling and cap, and has no price", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    const on = renderToStaticMarkup(createElement(PricingPage));
    const answer = on.slice(on.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).not.toContain(PREMIUM_COMING_SOON);
    expect(text).toContain("Pro includes 40 Premium minutes a month.");
    expect(text).toContain("Team includes 40 Premium minutes per seat a month, pooled across the team.");
    expect(text).toContain("come out of your plan minutes, not on top");
    expect(text).toContain("A Premium call is capped at the Premium minutes left, and we tell you before it starts.");
    expect(text).toContain("No overages.");
    expect(text).not.toMatch(/\$/);
  });

  it("only the exact string true puts Premium on sale", () => {
    for (const v of ["TRUE", "1", "yes", " true", "false", ""]) expect(isPremiumOnSale({ PREMIUM_VOICE_ON_SALE: v })).toBe(false);
    expect(isPremiumOnSale({})).toBe(false);
    expect(isPremiumOnSale({ PREMIUM_VOICE_ON_SALE: "true" })).toBe(true);
  });

  it("prices are unchanged", () => {
    // Monthly in the workbook; annual figures in the annual billing FAQ answer.
    for (const s of ["$29", "$290", "$59", "$590", "3-seat"]) expect(html).toContain(s);
  });
});

describe("landing hero line", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const hero = html.slice(0, html.indexOf("how-h"));

  it("leads with the price-objection promise and the two CTAs", () => {
    expect(hero).toContain(">Practice the price objection before your next call.</h1>");
    expect(hero.replace(/<[^>]+>/g, "")).toContain("Sales call practice, no setup required");
    expect(hrefs(hero)).toEqual(expect.arrayContaining(["/register?src=home_hero", "/pricing"]));
    expect(hero).toContain(">Start free, no card<");
    expect(hero).toMatch(/>\s*See pricing\s*</);
    expect(hero).toContain("Ten voice minutes monthly, unlimited text.");
  });

  it("keeps demo mode and bring your own key out of the hero", () => {
    expect(hero).not.toMatch(/demo mode|DEMO_MODE|bring your own key/i);
    expect(html).not.toContain("DEMO_MODE");
  });

  it("moves self-host setup off the page and links developers to the guide", () => {
    expect(html).not.toContain("oss-h");
    expect(html).not.toMatch(/npm (run|install)|git clone|\.env/);
    expect(hrefs(html)).toContain("https://github.com/mastanley13/real-time-call-trainer-oss#setup");
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
