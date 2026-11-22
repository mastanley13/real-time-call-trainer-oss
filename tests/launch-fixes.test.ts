import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import LandingPage from "@/components/landing/LandingPage";
import Link from "next/link";
import PricingCards, { SignedInAction } from "@/components/landing/PricingCards";
import PricingHeroCta, { PricingHeroCtaView } from "@/components/landing/PricingHeroCta";
import { PricingViewerContext } from "@/components/landing/PricingViewer";
import Briefing, { STICKY_START_BAR } from "@/components/call/Briefing";
import PricingPage from "@/app/pricing/page";
import { LANDINGS } from "@/lib/landing";
import * as landing from "@/lib/landing";
import {
  ASK_FOR_TEAM_NOTE, CURRENT_PLAN_LABEL, HERO_SIGNUP_CTA, OPEN_SOON_LINE, PRICES_TAX_NOTE, pricingViewerFromUsage, registerHref, signedInHeroCta,
  signedInTierAction, type PricingViewer,
} from "@/lib/pricing";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { CALL_MODE_KEY, initialCallMode } from "@/lib/trainerQuery";

// Launch fixes: partner terms off /for/coaches, true cap copy and the USD line on /pricing, signed-in plan buttons,
// the phone Start call bar, the first-time Text default, the in-call end button, /access copy and debrief padding.

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const DASH = new RegExp("[\\u2013\\u2014]");
const PARTNER_TERMS = /20%|net[- ]?30|free seat|recurring/i;
const hrefs = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replaceAll("&amp;", "&"));

afterEach(() => vi.unstubAllEnvs());

describe("/for/coaches has no partner payout promises", () => {
  it("the coaches landing data never says 20%, recurring, a free seat or net 30", () => {
    expect(JSON.stringify(LANDINGS.coaches)).not.toMatch(PARTNER_TERMS);
  });

  it("the benefits list is gone from the data and the page", () => {
    expect("PARTNER_BENEFITS" in landing).toBe(false);
    expect(read("src/components/landing/LandingPage.tsx")).not.toContain("PARTNER_BENEFITS");
    const html = renderToStaticMarkup(createElement(LandingPage, { l: LANDINGS.coaches, billingEnabled: false }));
    expect(html).not.toContain(">Benefits<");
    expect(html).not.toMatch(PARTNER_TERMS);
    expect(html).not.toContain("commission</h2>");
  });

  it("no public page or component source shows the old terms", () => {
    const files = ["src/app", "src/components"].flatMap((dir) =>
      (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f)));
    files.push("src/lib/landing.ts", "src/lib/pricing.ts");
    for (const f of files) expect(read(f), f).not.toMatch(/20% recurring|net[- ]?30|free seat|Earn 20%/i);
  });
});

describe("/pricing copy", () => {
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  const html = renderToStaticMarkup(createElement(PricingPage));

  it("the cap answer is true for every plan: voice pauses until the monthly minutes reset", () => {
    expect(html).toContain("Voice calls pause until your monthly minutes reset.");
    expect(html).not.toMatch(/billing cycle/i);
    expect(read("src/app/pricing/page.tsx")).not.toMatch(/billing cycle/i);
  });

  it("shows Prices in USD, before tax. as muted text after the plan cards, with prices unchanged", () => {
    expect(PRICES_TAX_NOTE).toBe("Prices in USD, before tax.");
    const at = html.indexOf(PRICES_TAX_NOTE);
    expect(at).toBeGreaterThan(html.indexOf('id="tier-team"'));
    expect(at).toBeLessThan(html.indexOf('id="compare-h"'));
    expect(html.slice(html.lastIndexOf("<p", at), at)).toContain("text-ink-muted");
    for (const s of ["$29", "$290", "$59", "$590", "$0"]) expect(html).toContain(s);
  });

  it("the new copy has no em or en dashes", () => {
    expect(read("src/app/pricing/page.tsx")).not.toMatch(DASH);
    expect(read("src/lib/pricing.ts")).not.toMatch(DASH);
  });
});

describe("/pricing plan buttons", () => {
  it("anonymous visitors see exactly the sign-up buttons (no session, no provider)", () => {
    for (const billing of [false, true]) {
      const html = renderToStaticMarkup(createElement(PricingCards, { billingEnabled: billing }));
      expect(html).toContain(">Start free, no card<");
      expect(html).not.toContain(CURRENT_PLAN_LABEL);
      expect(html).not.toContain("Upgrade to");
      expect(html).not.toContain("/checkout/start");
      expect(hrefs(html)).toEqual(expect.arrayContaining(["/register?src=pricing", "/register?plan=pro&interval=month&src=pricing", "/register?plan=team&interval=month&src=pricing"]));
    }
  });

  it("reads the plan from a metered /api/usage answer only", () => {
    expect(pricingViewerFromUsage({ metered: true, plan: "pro", billing: { enabled: true } })).toEqual({ plan: "pro" });
    expect(pricingViewerFromUsage({ metered: true, plan: "team", billing: { canBuyTeam: false } })).toEqual({ plan: "team", canBuyTeam: false });
    expect(pricingViewerFromUsage({ metered: false, billing: { enabled: false } })).toEqual({ plan: null });
    expect(pricingViewerFromUsage({ metered: true, plan: "enterprise" })).toEqual({ plan: null });
    expect(pricingViewerFromUsage(null)).toEqual({ plan: null });
  });

  it("Free user: Current plan on Free, upgrade links to the checkout step on Pro and Team", () => {
    const v = { plan: "free" as const };
    expect(signedInTierAction("free", v, true, "month")).toEqual({ kind: "current", cta: "Current plan" });
    expect(signedInTierAction("pro", v, true, "month")).toEqual({ kind: "link", cta: "Upgrade to Pro", href: "/checkout/start?plan=pro&interval=month" });
    expect(signedInTierAction("team", v, true, "year")).toEqual({ kind: "link", cta: "Upgrade to Team", href: "/checkout/start?plan=team&interval=year" });
  });

  it("Pro user: Free is included, Pro is current, Team is an upgrade", () => {
    const v = { plan: "pro" as const };
    expect(signedInTierAction("free", v, true, "month")).toEqual({ kind: "included", cta: "Included in Pro" });
    expect(signedInTierAction("pro", v, true, "month").kind).toBe("current");
    expect(signedInTierAction("team", v, true, "month")).toMatchObject({ kind: "link", href: "/checkout/start?plan=team&interval=month" });
  });

  it("Team user: Team is current and nothing is offered below it", () => {
    const v = { plan: "team" as const };
    expect(signedInTierAction("team", v, true, "month").kind).toBe("current");
    expect(signedInTierAction("pro", v, true, "month")).toEqual({ kind: "included", cta: "Included in Team" });
    expect(signedInTierAction("free", v, true, "month")).toEqual({ kind: "included", cta: "Included in Team" });
  });

  it("unknown plan: upgrade buttons, no Current plan badge, and the trainer from the Free card instead of sign-up", () => {
    const v = { plan: null };
    const all = (["free", "pro", "team"] as const).map((id) => signedInTierAction(id, v, true, "month"));
    expect(all.some((a) => a.kind === "current")).toBe(false);
    expect(all[0]).toEqual({ kind: "link", cta: "Open the trainer", href: "/trainer" });
    expect(all[1]).toMatchObject({ kind: "link", cta: "Upgrade to Pro" });
    expect(all[2]).toMatchObject({ kind: "link", cta: "Upgrade to Team" });
  });

  it("billing off: the upgrade is a disabled button with the open-soon line; someone who cannot buy Team is told who can", () => {
    expect(signedInTierAction("pro", { plan: "free" }, false, "month")).toEqual({ kind: "disabled", cta: "Upgrade to Pro" });
    expect(signedInTierAction("team", { plan: "free", canBuyTeam: false }, true, "month")).toEqual({ kind: "note", cta: ASK_FOR_TEAM_NOTE });
    const off = renderToStaticMarkup(createElement(SignedInAction, { id: "pro", viewer: { plan: "free" }, billingEnabled: false, interval: "month" }));
    expect(off).toMatch(/<button[^>]*disabled[^>]*>Upgrade to Pro<\/button>/);
    expect(off).toContain(OPEN_SOON_LINE);
  });

  it("Current plan renders as an outlined, disabled button, never a link", () => {
    const html = renderToStaticMarkup(createElement(SignedInAction, { id: "pro", viewer: { plan: "pro" }, billingEnabled: true, interval: "month" }));
    expect(html).toMatch(/^<button type="button" class="btn-ghost" disabled="">Current plan<\/button>$/);
    expect(html).not.toContain("href=");
    const up = renderToStaticMarkup(createElement(SignedInAction, { id: "team", viewer: { plan: "pro" }, billingEnabled: true, interval: "month" }));
    expect(hrefs(up)).toEqual(["/checkout/start?plan=team&interval=month"]);
  });
});

describe("/pricing top button and every other sign-up CTA (SAL-1028)", () => {
  /** Text of every link and button in the markup: the calls to action, not descriptive copy like "Try it solo, no card." */
  const ctaTexts = (html: string) => [...html.matchAll(/<(a|button)\b[^>]*>(.*?)<\/\1>/g)].map((m) => m[2].replace(/<[^>]+>/g, "").trim());
  const asViewer = (viewer: PricingViewer | null, billingEnabled: boolean) => renderToStaticMarkup(
    createElement(PricingViewerContext.Provider, { value: viewer },
      createElement(PricingHeroCta, { billingEnabled }),
      createElement(PricingCards, { billingEnabled })));

  it("signed in: upgrade to Pro on Free when checkout is set up, otherwise open the trainer", () => {
    expect(signedInHeroCta({ plan: "free" }, true)).toEqual({ label: "Upgrade to Pro", href: "/checkout/start?plan=pro&interval=month" });
    expect(signedInHeroCta({ plan: "free" }, false)).toEqual({ label: "Open the trainer", href: "/trainer" });
    expect(signedInHeroCta({ plan: "pro" }, true)).toEqual({ label: "Open the trainer", href: "/trainer" });
    expect(signedInHeroCta({ plan: "team" }, true)).toEqual({ label: "Open the trainer", href: "/trainer" });
    expect(signedInHeroCta({ plan: null }, true)).toEqual({ label: "Open the trainer", href: "/trainer" });
  });

  it("anonymous: the top button is exactly the old sign-up link", () => {
    const old = renderToStaticMarkup(createElement(Link, { href: registerHref({ src: "pricing" }), className: "btn-primary btn-xl" }, "Start free, no card"));
    expect(HERO_SIGNUP_CTA).toEqual({ label: "Start free, no card", href: "/register?src=pricing" });
    expect(renderToStaticMarkup(createElement(PricingHeroCtaView, { viewer: null, billingEnabled: true }))).toBe(old);
    expect(renderToStaticMarkup(createElement(PricingHeroCtaView, { viewer: null, billingEnabled: false }))).toBe(old);
    // No provider at all also reads as signed out.
    expect(renderToStaticMarkup(createElement(PricingHeroCta, { billingEnabled: true }))).toBe(old);
  });

  it("anonymous: the page still leads with Start free, no card, and only the top button and the Free card say it", () => {
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    const html = renderToStaticMarkup(createElement(PricingPage));
    const hero = html.slice(0, html.indexOf('id="plans"'));
    expect(ctaTexts(hero)).toEqual(["Start free, no card", "Compare plans"]);
    expect(hrefs(hero)).toEqual(["/register?src=pricing", "#plans"]);
    expect(ctaTexts(html).filter((t) => /start free|no card/i.test(t))).toEqual(["Start free, no card", "Start free, no card", "Start free", "Start free"]);
  });

  it.each([
    ["Free, checkout on", { plan: "free" as const }, true],
    ["Free, checkout off", { plan: "free" as const }, false],
    ["Pro", { plan: "pro" as const }, true],
    ["Team", { plan: "team" as const }, true],
    ["plan unknown", { plan: null }, true],
    ["plan unknown, checkout off", { plan: null }, false],
  ])("signed in (%s): no CTA on /pricing says Start free or no card, or links to sign-up", (_name, viewer, billing) => {
    const html = asViewer(viewer, billing);
    expect(ctaTexts(html).filter((t) => /start free|no card/i.test(t))).toEqual([]);
    expect(hrefs(html).filter((h) => h.startsWith("/register"))).toEqual([]);
  });

  it("signed in on Free with checkout on: the top button upgrades through the checkout step", () => {
    const html = asViewer({ plan: "free" }, true);
    const top = html.slice(0, html.indexOf("</a>") + 4);
    expect(ctaTexts(top)).toEqual(["Upgrade to Pro"]);
    expect(hrefs(top)).toEqual(["/checkout/start?plan=pro&interval=month"]);
    expect(top).toContain('class="btn-primary btn-xl"');
  });

  it("the page has no hard-coded sign-up CTA left: every plan button reads the shared viewer", () => {
    const page = read("src/app/pricing/page.tsx");
    expect(page).not.toContain("registerHref");
    expect(page).not.toContain("Start free");
    expect(page).toContain("<PricingViewerProvider>");
    expect(page).toContain("<PricingHeroCta billingEnabled={billing} />");
    for (const f of ["src/components/landing/PricingHeroCta.tsx", "src/components/landing/PricingCards.tsx"]) expect(read(f)).toContain("usePricingViewer()");
    for (const f of ["src/components/landing/PricingHeroCta.tsx", "src/components/landing/PricingViewer.tsx"]) expect(read(f)).not.toMatch(DASH);
  });
});

describe("practice briefing", () => {
  const caps = { demoMode: true, elevenlabs: false, voiceEngines: [], llm: false, database: false } as never;
  const html = renderToStaticMarkup(createElement(Briefing, {
    scenario: BUILT_IN_SCENARIOS[0], capabilities: caps, engine: null, coachMode: "coached", mode: "text",
    onModeChange: () => {}, onEngineChange: () => {}, onCoachModeChange: () => {}, onStart: () => {},
  }));

  it("Start call sits in the card from sm up and in a sticky bottom bar below sm", () => {
    expect(html.match(/> Start call<\/button>/g)).toHaveLength(2);
    const card = html.indexOf('class="hidden sm:block"');
    expect(card).toBeGreaterThan(-1);
    expect(html.indexOf("Start call", card)).toBeGreaterThan(card);
    const bar = html.match(/<div class="([^"]*sticky[^"]*)"><button[^>]*btn-xl/);
    expect(bar).not.toBeNull();
    for (const c of ["sticky", "sm:hidden", "border-t", "border-line", "bg-surface"]) expect(bar![1].split(" ")).toContain(c);
    expect(bar![1]).toContain(STICKY_START_BAR);
  });

  it("the bar clears the bottom tab bar and the safe-area inset", () => {
    expect(STICKY_START_BAR).toContain("bottom-[calc(3.5rem+env(safe-area-inset-bottom))]");
  });
});

describe("first-time call mode", () => {
  it("a first-time rep starts in Text", () => {
    expect(initialCallMode({ textParam: false, saved: null, hasPracticed: false })).toBe("text");
  });

  it("a rep who has practiced here before keeps Voice, and ?mode=text still wins", () => {
    expect(initialCallMode({ textParam: false, saved: null, hasPracticed: true })).toBe("voice");
    expect(initialCallMode({ textParam: true, saved: "voice", hasPracticed: true })).toBe("text");
  });

  it("an explicit saved pick is kept; anything else stored is ignored", () => {
    expect(initialCallMode({ textParam: false, saved: "voice", hasPracticed: false })).toBe("voice");
    expect(initialCallMode({ textParam: false, saved: "text", hasPracticed: true })).toBe("text");
    expect(initialCallMode({ textParam: false, saved: "Voice", hasPracticed: false })).toBe("text");
  });

  it("the trainer saves the rep's own pick, but not a forced switch to Text", () => {
    const src = read("src/components/TrainerClient.tsx");
    expect(CALL_MODE_KEY).toBe("rtct.callMode");
    expect(src).toContain("localStorage.setItem(CALL_MODE_KEY, m)");
    expect(src).toContain("onModeChange={chooseMode}");
    expect(src).toContain('onUseText={() => setMode("text")}');
  });
});

describe("in-call end button", () => {
  const deck = read("src/components/call/Deck.tsx");

  it("the icon and the label cannot overlap", () => {
    expect(deck).toContain('<PhoneOff size={16} className="shrink-0" aria-hidden />');
    expect(deck).toMatch(/btn-danger[^"]*shrink-0[^"]*whitespace-nowrap/);
  });

  it("has an accessible name for each state and a short visible label on phones", () => {
    expect(deck).toContain('aria-label={text?.hungUp ? "Grade call" : "End and grade call"}');
    expect(deck).toContain('<span className="sm:hidden">{text?.hungUp ? "Grade" : "End"}</span>');
  });
});

describe("/access and the debrief", () => {
  it("/access no longer says invite-only", () => {
    const src = read("src/app/access/page.tsx");
    expect(src).not.toMatch(/invite-only/i);
    expect(src).toContain('subtitle="Enter your access code to continue."');
  });

  it("the debrief pads past the bottom tab bar on small screens", () => {
    expect(read("src/app/trainer/debrief/[sessionId]/page.tsx")).toContain("pb-[calc(5rem+env(safe-area-inset-bottom))] md:pb-10");
  });
});
