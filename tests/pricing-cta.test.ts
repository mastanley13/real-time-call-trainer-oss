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

describe("PricingCards, billing off", () => {
  const html = cards(false);

  it("reads Start free on Pro and Team with the open-soon line under each", () => {
    expect(html).not.toContain("Start Pro");
    expect(html).not.toContain("Start with Team");
    expect(count(html, ">Start free<")).toBe(2);
    expect(count(html, OPEN_SOON_LINE)).toBe(2);
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
  });

  it("carries the plan, the monthly interval and src", () => {
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&src=pricing", "/register?plan=team&interval=month&src=pricing"]));
  });

  it("the toggle drives the interval in the hrefs", () => {
    // Static markup cannot click, so check the link builder the toggle state feeds.
    expect(tierAction("pro", "Start Pro", true, "year").href).toBe("/register?plan=pro&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "year").href).toBe("/register?plan=team&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "month").href).toBe("/register?plan=team&interval=month&src=pricing");
    // Billing off keeps the selected period in the link too, so sign-up stores it.
    expect(tierAction("pro", "Start Pro", false, "year")).toMatchObject({ cta: "Start free", href: "/register?plan=pro&interval=year&src=pricing", soon: true });
    expect(tierAction("team", "Start with Team", false, "month")).toMatchObject({ cta: "Start free", href: "/register?plan=team&interval=month&src=pricing", soon: true });
  });
});

describe("Premium add-on row", () => {
  it.each([false, true])("off sale: the coming-soon label, the $20 price, both plan lines and no button (billing %s)", (on) => {
    const html = cards(on);
    const addon = html.slice(html.indexOf("Add-on: Premium AI voice"));
    expect(addon).toContain(PREMIUM_COMING_SOON);
    expect(addon).toContain("+$20");
    expect(addon).toContain("Premium voice: +$20 a month. 40 Premium minutes, then Standard.");
    // Final Margin Team line (premium-voice-docs-input.md section 6), verbatim; rendered HTML escapes nothing in it.
    expect(addon).toContain("Premium voice for Team: +$20 per seat a month, 40 pooled minutes per seat.");
    expect(addon).not.toMatch(/<a |<button|href=/);
    expect(addon).not.toMatch(/\$30|\$300|60%/);
  });

  it("on sale: no coming-soon label, still one row under the three cards and no fourth card", () => {
    const html = renderToStaticMarkup(createElement(PricingCards, { billingEnabled: true, premiumOnSale: true }));
    expect(html).not.toContain(PREMIUM_COMING_SOON);
    expect(count(html, "<section")).toBe(3);
    expect(count(html, "Add-on: Premium AI voice")).toBe(1);
  });

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

  it("base cards keep Standard voice included", () => {
    expect(count(cards(true), "Standard voice included")).toBe(2);
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

  it("billing off: no paid CTA text anywhere in the HTML", () => {
    expect(html).not.toContain("Start Pro");
    expect(html).not.toContain("Start with Team");
  });

  it("off sale, the Premium row is Your keys, No, then the coming-soon label on Pro and Team", () => {
    const row = html.slice(html.indexOf(">Premium AI voice</th>"));
    const cells = [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["Your keys", "No", PREMIUM_COMING_SOON, PREMIUM_COMING_SOON]);
  });

  it("off sale, the Premium FAQ starts with the label, then the $20 / 40 minute terms with no overages", () => {
    const answer = html.slice(html.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).toMatch(new RegExp(`^<p[^>]*>${PREMIUM_COMING_SOON.replace(/[()]/g, "\\$&")}\\.`));
    expect(text).toContain("Pro: +$20/mo with 40 Premium minutes.");
    expect(text).toContain("Team: +$20/seat/mo with 40 Premium minutes per seat");
    expect(text).toContain("come out of your plan minutes, not on top");
    expect(text).toContain("No overages.");
    expect(text).not.toMatch(/\$30|\$300|60%|Team add-on first/);
  });

  it("on sale (PREMIUM_VOICE_ON_SALE=true with billing on), the row reads No, Add-on, Add-on and the FAQ drops the label", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    const on = renderToStaticMarkup(createElement(PricingPage));
    const row = on.slice(on.indexOf(">Premium AI voice</th>"));
    const cells = [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["Your keys", "No", "Add-on", "Add-on"]);
    const answer = on.slice(on.indexOf("What does Premium AI voice add?"));
    expect(answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"))).not.toContain(PREMIUM_COMING_SOON);
  });

  it("only the exact string true puts Premium on sale", () => {
    for (const v of ["TRUE", "1", "yes", " true", "false", ""]) expect(isPremiumOnSale({ PREMIUM_VOICE_ON_SALE: v })).toBe(false);
    expect(isPremiumOnSale({})).toBe(false);
    expect(isPremiumOnSale({ PREMIUM_VOICE_ON_SALE: "true" })).toBe(true);
  });

  it("prices are unchanged", () => {
    for (const s of ["$29", "$290", "$59", "$590", "3-seat"]) expect(html).toContain(s);
  });
});

describe("landing hero line", () => {
  const html = renderToStaticMarkup(createElement(Home));
  const hero = html.slice(0, html.indexOf("how-h"));

  it("leads with the hosted pitch and the two CTAs", () => {
    expect(hero).toContain("Sales call practice, <span");
    expect(hero.replace(/<[^>]+>/g, "")).toContain("Sales call practice, no setup required");
    expect(hero).toContain("Practice real sales calls against 54 AI buyer personas. No API keys, no database, just sign up and start talking.");
    expect(hrefs(hero)).toEqual(expect.arrayContaining(["/register?src=home_hero", "/pricing"]));
    expect(hero).toContain(">Start free <");
    expect(hero).toContain(">See pricing<");
  });

  it("keeps demo mode and bring your own key out of the hero", () => {
    expect(hero).not.toMatch(/demo mode|DEMO_MODE|bring your own key/i);
    expect(html).not.toContain("DEMO_MODE");
  });

  it("puts the open source message in the self-host section with a setup that has no demo mode", () => {
    const oss = html.slice(html.indexOf("oss-h"));
    expect(oss).toContain("bring your own key");
    expect(oss).toContain("npm run dev");
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
