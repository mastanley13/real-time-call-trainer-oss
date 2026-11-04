import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingCards, { tierAction } from "@/components/landing/PricingCards";
import PricingSummary from "@/components/landing/PricingSummary";
import PricingPage from "@/app/pricing/page";
import Home from "@/app/page";
import { OPEN_SOON_LINE, PREMIUM_COMING_SOON } from "@/lib/pricing";
import { billingOn } from "@/lib/serverConfig";

const cards = (billingEnabled: boolean) => renderToStaticMarkup(createElement(PricingCards, { billingEnabled }));
const summary = (billingEnabled: boolean) => renderToStaticMarkup(createElement(PricingSummary, { src: "pricing", seg: "saas", billingEnabled }));
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));
const count = (html: string, text: string) => html.split(text).length - 1;

afterEach(() => vi.unstubAllEnvs());

describe("PricingCards, billing off", () => {
  const html = cards(false);

  it("reads Start free on Pro and Team with the open-soon line under each", () => {
    expect(html).not.toContain("Start with Pro");
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
    expect(html).toContain(">Start with Pro</a>");
    expect(html).toContain(">Start with Team</a>");
    expect(html).not.toContain(OPEN_SOON_LINE);
  });

  it("carries the plan, the monthly interval and src", () => {
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&src=pricing", "/register?plan=team&interval=month&src=pricing"]));
  });

  it("the toggle drives the interval in the hrefs", () => {
    // Static markup cannot click, so check the link builder the toggle state feeds.
    expect(tierAction("pro", "Start with Pro", true, "year").href).toBe("/register?plan=pro&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "year").href).toBe("/register?plan=team&interval=year&src=pricing");
    expect(tierAction("team", "Start with Team", true, "month").href).toBe("/register?plan=team&interval=month&src=pricing");
    // Billing off keeps the selected period in the link too, so sign-up stores it.
    expect(tierAction("pro", "Start with Pro", false, "year")).toMatchObject({ cta: "Start free", href: "/register?plan=pro&interval=year&src=pricing", soon: true });
    expect(tierAction("team", "Start with Team", false, "month")).toMatchObject({ cta: "Start free", href: "/register?plan=team&interval=month&src=pricing", soon: true });
  });
});

describe("Premium add-on card", () => {
  it.each([false, true])("shows the coming-soon label, the price and no button (billing %s)", (on) => {
    const html = cards(on);
    const addon = html.slice(html.indexOf("Add-on: Premium AI voice"));
    expect(addon).toContain(PREMIUM_COMING_SOON);
    expect(addon).toContain("+$30");
    expect(addon).not.toMatch(/<a |<button|href=/);
  });
});

describe("PricingSummary", () => {
  it("billing off: Start free with the open-soon line on Pro and Team", () => {
    const html = summary(false);
    expect(html).not.toContain("Start with Pro");
    expect(html).not.toContain("Start with Team");
    expect(count(html, OPEN_SOON_LINE)).toBe(2);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?plan=pro&interval=month&seg=saas&src=pricing", "/register?plan=team&interval=month&seg=saas&src=pricing"]));
  });

  it("billing on: the paid labels", () => {
    const html = summary(true);
    expect(html).toContain("Start with Pro");
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
    expect(renderToStaticMarkup(createElement(PricingPage))).not.toContain("Start with Pro");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    const on = renderToStaticMarkup(createElement(PricingPage));
    expect(on).toContain("Start with Pro");
    expect(on).toContain("Start with Team");
  });
});

describe("pricing page", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  const html = renderToStaticMarkup(createElement(PricingPage));

  it("billing off: no paid CTA text anywhere in the HTML", () => {
    expect(html).not.toContain("Start with Pro");
    expect(html).not.toContain("Start with Team");
  });

  it("the Premium row is No, No, No, label", () => {
    const row = html.slice(html.indexOf(">Premium AI voice</th>"));
    const cells = [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["Your keys", "No", "No", PREMIUM_COMING_SOON]);
  });

  it("the Premium FAQ starts with the label, says Team first and keeps the price", () => {
    const answer = html.slice(html.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).toMatch(new RegExp(`^<p[^>]*>${PREMIUM_COMING_SOON.replace(/[()]/g, "\\$&")}\\.`));
    expect(text).toContain("Team add-on first");
    expect(text).toContain("+$30 per seat per month ($300 per seat per year)");
  });

  it("the old open-soon copy is gone in both billing states", () => {
    for (const h of [html, cards(false), cards(true), summary(false), summary(true)]) expect(h).not.toMatch(/open soon/i);
  });

  it("plan copy names MFA as two-factor sign-in, never bare", () => {
    const text = (h: string) => h.replace(/<[^>]+>/g, "\n");
    for (const h of [html, cards(false), summary(false)]) {
      expect(h).toContain("wo-factor sign-in (MFA)");
      // Every MFA mention is the parenthetical after "two-factor sign-in".
      expect(text(h).match(/\bMFA\b/g)?.length).toBe(text(h).match(/[Tt]wo-factor sign-in \(MFA\)/g)?.length);
    }
    expect(cards(false)).toContain(">Two-factor sign-in (MFA)</li>");
    expect(html).toContain(">Two-factor sign-in (MFA)</th>");
  });

  it("never claims MFA is enforced: nothing in code enforces it", () => {
    for (const h of [html, cards(false), cards(true), summary(false), summary(true)]) expect(h).not.toMatch(/enforce/i);
    const row = html.slice(html.indexOf(">Two-factor sign-in (MFA)</th>"));
    const cells = [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["You configure it", "Available", "Available", "Available"]);
    expect(summary(false)).toContain("300 pooled voice minutes per seat, everything in Pro, priority email support. Managers get Team view and assignments on any plan.");
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

  it("keeps the model table off the hosted home page and links to the self-hosting docs", () => {
    expect(html).not.toMatch(/Under the hood|Which model does what|LLM_BASE_URL|gpt-4\.1-mini/);
    const oss = html.slice(html.indexOf("oss-h"));
    expect(oss).toContain('href="https://github.com/mastanley13/real-time-call-trainer-oss#which-model-does-what"');
    expect(oss).toContain(">Self-hosting</a>");
  });

  it("leaves one section gap between How it works and the features, not two", () => {
    const sectionClass = (id: string) => html.match(new RegExp(`<section class="([^"]*)" aria-labelledby="${id}"`))?.[1];
    expect(sectionClass("how-h")).toBe("page py-14 sm:py-16");
    // .page sets py-8 sm:py-10 itself, so the features section must zero its top padding explicitly.
    expect(sectionClass("feat-h")).toBe("page pt-0 pb-14 sm:pb-16");
  });

  it(".page still carries its own vertical padding, which pt-0 on the features section has to cancel", () => {
    expect(readFileSync("src/app/globals.css", "utf8")).toMatch(/\.page \{ @apply [^}]*\bpy-8\b[^}]*\bsm:py-10\b/);
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
