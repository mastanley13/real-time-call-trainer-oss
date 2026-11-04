import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingCards, { tierAction } from "@/components/landing/PricingCards";
import PricingSummary from "@/components/landing/PricingSummary";
import PricingPage from "@/app/pricing/page";
import Home from "@/app/page";
import { LANDINGS } from "@/lib/landing";
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
  it.each([false, true])("shows the coming-soon label, no price and no button (billing %s)", (on) => {
    const html = cards(on);
    const addon = html.slice(html.indexOf("Add-on: Premium AI voice"));
    expect(addon).toContain(PREMIUM_COMING_SOON);
    expect(addon).not.toMatch(/\+\$30|\$300/);
    expect(addon).not.toMatch(/<a |<button|href=/);
  });
});

describe("plan features match what each plan unlocks", () => {
  const html = cards(false);
  const tier = (id: string) => html.slice(html.indexOf(`id="tier-${id}"`), html.indexOf("</section>", html.indexOf(`id="tier-${id}"`)));

  it("Free lists the full library, the wizard, history and two-factor sign-in", () => {
    for (const f of ["Full persona library across every sales role", "Persona wizard for your own buyers", "Call history and score trends", "Two-factor sign-in (MFA)"]) expect(tier("free")).toContain(f);
    expect(html).not.toContain("Core persona library");
  });

  it("Pro adds minutes on top of Free, without relisting Free features or promising email support", () => {
    const pro = tier("pro");
    for (const f of ["200 voice minutes per month", "Everything in Free", "Reviewed persona packs (coming soon)"]) expect(pro).toContain(f);
    for (const f of ["Persona wizard", "Full persona library", "Call history", "MFA"]) expect(pro).not.toContain(f);
    expect(pro).not.toMatch(/email support/i);
  });

  it("uses Start with Pro and Start with Team, never Start Pro", () => {
    for (const html of [cards(true), summary(true)]) {
      expect(html).toContain(">Start with Pro<");
      expect(html).toContain(">Start with Team<");
      expect(html).not.toContain("Start Pro");
    }
  });

  it("Team says Team view and assignments are on any plan and claims no MFA enforcement", () => {
    const team = tier("team");
    for (const f of ["300 voice minutes per seat, pooled across the team", "Everything in Pro", "Priority email support", "Team view and assignments for managers, available on any plan"]) expect(team).toContain(f);
    expect(team).not.toMatch(/MFA|two-factor|Managed Team view/i);
  });

  it("the summary cards say the same", () => {
    const s = summary(false);
    expect(s).toContain("10 voice minutes a month, unlimited text sim, live coach, graded debriefs, full persona library, persona wizard, score trends, two-factor sign-in (MFA).");
    expect(s).toContain("200 voice minutes a month, everything in Free. Reviewed persona packs: coming soon.");
    expect(s).toContain("300 pooled voice minutes per seat, everything in Pro, priority email support. Managers get Team view and assignments on any plan.");
    expect(s).not.toMatch(/core persona/i);
  });
});

/** MFA is opt-in per user (nothing enforces it), and Team view and assignments are gated by role (canManageTeam), not plan. */
describe("Team and MFA copy matches the code", () => {
  const enforcedMfa = /(enforc|requir|mandator)\w*[^.]{0,40}(MFA|two-factor)|(MFA|two-factor)[^.]{0,40}(enforc|requir|mandator)/i;
  const planGatedTeam = /On Team, (yes|the Team view)|Managers on Team|Managed Team view/i;
  const pages = () => [
    renderToStaticMarkup(createElement(PricingPage)),
    cards(false),
    summary(false),
    renderToStaticMarkup(createElement(Home)),
    JSON.stringify(LANDINGS),
  ];

  it("no pricing or landing copy claims MFA is enforced or required", () => {
    for (const html of pages()) expect(html).not.toMatch(enforcedMfa);
  });

  it("no copy ties Team view or assignments to the Team plan", () => {
    for (const html of pages()) expect(html).not.toMatch(planGatedTeam);
  });

  it("the compare table shows Team view, assignments and MFA as available on every plan", () => {
    const html = renderToStaticMarkup(createElement(PricingPage));
    const cellsOf = (feature: string) => {
      const row = html.slice(html.indexOf(`>${feature}</th>`));
      return [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    };
    expect(cellsOf("Team view")).toEqual(["You host it", "Available to managers", "Available to managers", "Available to managers"]);
    expect(cellsOf("Assignments")).toEqual(["You host it", "Available to managers", "Available to managers", "Available to managers"]);
    expect(cellsOf("Two-factor sign-in (MFA)")).toEqual(["You configure it", "Available", "Available", "Available"]);
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

  it("the Premium FAQ starts with the label, says Team first and ends without a price", () => {
    const answer = html.slice(html.indexOf("What does Premium AI voice add?"));
    const text = answer.slice(answer.indexOf("<p"), answer.indexOf("</p>"));
    expect(text).toMatch(new RegExp(`^<p[^>]*>${PREMIUM_COMING_SOON.replace(/[()]/g, "\\$&")}\\.`));
    expect(text).toContain("Team add-on first");
    expect(text.endsWith("Pricing will be announced when it launches.")).toBe(true);
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

  it("shows no Premium price anywhere", () => {
    expect(html).not.toMatch(/\+\$30|\$300/);
  });

  it("states USD and tax under the plan cards", () => {
    const plans = html.slice(html.indexOf('id="plans"'), html.indexOf("compare-h"));
    expect(plans).toContain("Prices in USD. Sales tax or VAT may be added at checkout where required.");
  });

  it("explains when voice minutes reset on paid plans and on Free", () => {
    expect(html).toContain("Voice calls pause until your minutes reset: at your next billing cycle on paid plans, or monthly from your signup date on Free.");
  });

  it("keeps the no-refunds policy", () => {
    expect(html).toContain("There are no refunds. Payments to StrategixAI LLC are non-refundable except where the law requires.");
  });

  it("Free gets the full persona library and the persona wizard in the compare table", () => {
    const cellsOf = (feature: string) => {
      const row = html.slice(html.indexOf(`>${feature}</th>`));
      return [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    };
    expect(cellsOf("Persona library")).toEqual(["Yes", "Full", "Full", "Full"]);
    expect(cellsOf("Persona wizard")).toEqual(["Yes", "Yes", "Yes", "Yes"]);
  });

  it("the Support row promises Pro nothing beyond what Free gets", () => {
    const row = html.slice(html.indexOf(">Support</th>"));
    const cells = [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]);
    expect(cells).toEqual(["GitHub community", "Community", "Community", "Priority email"]);
  });

  it("the Free FAQ names the library and the wizard", () => {
    const answer = html.slice(html.indexOf("What do I get on Free?"));
    expect(answer.slice(0, answer.indexOf("</p>"))).toContain("It includes the full persona library, the persona wizard, the live coach and graded debriefs.");
  });

  it("says nothing about a core or partial persona set", () => {
    expect(html).not.toMatch(/core (persona|set)|Core set/i);
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

  it("describes the coach rail as a running estimate, talk track and Coached cues, not a per-turn score", () => {
    const how = html.slice(html.indexOf("how-h"), html.indexOf("models-h"));
    expect(how).toContain("A coach rail only you can see keeps a running score estimate and your talk-track progress, and in Coached mode cues your next move.");
    expect(html).not.toMatch(/scores each turn|scores every turn/);
  });

  it("the hero demo uses the real rail labels", () => {
    expect(hero).toContain("Live estimate");
    expect(hero).toContain("not final");
    expect(hero).toContain("Talk track");
  });

  it(".page still carries its own vertical padding, which pt-0 on the features section has to cancel", () => {
    expect(readFileSync("src/app/globals.css", "utf8")).toMatch(/\.page \{ @apply [^}]*\bpy-8\b[^}]*\bsm:py-10\b/);
  });

  it("uses no em dashes", () => {
    expect(html).not.toContain("—");
  });
});
