import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PremiumVoiceControl, { type PremiumControlUsage } from "@/components/settings/PremiumVoiceControl";
import PremiumMinutes from "@/components/call/PremiumMinutes";
import { PREMIUM_COMING_SOON, PREMIUM_DISCLOSURE_PRO, PREMIUM_DISCLOSURE_TEAM, PREMIUM_NUDGE_PRO, PREMIUM_NUDGE_TEAM } from "@/lib/pricing";
import type { PremiumSnapshot } from "@/lib/billingUi";

const render = (usage: PremiumControlUsage | null, onSale: boolean) => renderToStaticMarkup(createElement(PremiumVoiceControl, { usage, onSale }));
const pro = (premium: PremiumControlUsage["premiumVoice"], billing: PremiumControlUsage["billing"] = {}): PremiumControlUsage => ({
  metered: true, plan: "pro", premiumVoice: premium, billing: { enabled: true, hasSubscription: true, seats: 1, renewsAt: "2026-12-05T00:00:00Z", ...billing },
});
const team = (premium: PremiumControlUsage["premiumVoice"], billing: PremiumControlUsage["billing"] = {}): PremiumControlUsage => ({
  metered: true, plan: "team", premiumVoice: premium, billing: { enabled: true, hasSubscription: true, seats: 5, renewsAt: "2026-12-05T00:00:00Z", ...billing },
});

describe("Premium control on /settings/billing", () => {
  it("off sale with nothing on the account: the coming-soon label and no buy controls", () => {
    for (const u of [null, pro({ enabled: false, configured: false, canBuy: true }), team({ enabled: false, configured: false, canBuy: true })]) {
      const html = render(u, false);
      expect(html).toContain(PREMIUM_COMING_SOON);
      expect(html).not.toMatch(/<button|<input|href=/);
    }
  });

  it("on sale, a Pro subscriber sees the add-on row with Add Premium voice and no per seat wording", () => {
    const html = render(pro({ enabled: false, configured: false, canBuy: true, minutesCap: 0, remaining: 0 }), true);
    expect(html).toContain("Add Premium voice");
    expect(html).toContain("Premium voice: +$20 a month. 40 Premium minutes, then Standard.");
    expect(html).toContain(PREMIUM_DISCLOSURE_PRO);
    expect(html).not.toContain("per seat a month");
  });

  it("on sale, a Team member who cannot buy is told to ask their admin and gets no button", () => {
    const html = render(team({ enabled: false, configured: false, canBuy: false }), true);
    expect(html).toContain("Ask your admin");
    expect(html).not.toContain(">Add Premium voice<");
  });

  it("entitled Team: pooled minutes left, seats, the Team disclosure, and Remove at period end", () => {
    const html = render(team({ enabled: true, configured: true, canBuy: true, minutesCap: 200, remaining: 150 }), true);
    expect(html).toContain("Premium: 150 of 200 min left");
    expect(html).toContain(PREMIUM_DISCLOSURE_TEAM);
    // Current plan and seat summary sits above the add-on actions (incident.io billing overview pattern).
    expect(html).toMatch(/Seats<\/dt><dd><span[^>]*>5<\/span>/);
    expect(html.indexOf(">Seats<")).toBeLessThan(html.indexOf("Remove at period end"));
    expect(html).toContain("Remove at period end");
  });

  it("off sale with the add-on still on the account: not available yet, Standard voice, removal still offered", () => {
    const html = render(pro({ enabled: false, configured: true, canBuy: true, minutesCap: 0, remaining: 0 }), false);
    expect(html).toContain("Not available yet");
    expect(html).toContain("calls use Standard voice");
    expect(html).not.toContain("Paused");
    expect(html).not.toContain(">Add Premium voice<");
    expect(html).toContain("Remove at period end");
  });

  it("a scheduled removal shows the fallback date; removal still shows while Premium is off sale", () => {
    const html = render(pro({ enabled: true, configured: true, canBuy: true, minutesCap: 40, remaining: 10, removeAt: "2026-12-05T00:00:00Z" }), false);
    expect(html).toContain("Falls back to Standard on Dec 5.");
    expect(html).not.toContain(PREMIUM_COMING_SOON);
    const notScheduled = render(pro({ enabled: true, configured: true, canBuy: true, minutesCap: 40, remaining: 10 }), false);
    expect(notScheduled).toContain("Remove at period end");
    expect(notScheduled).not.toContain("Add Premium voice");
  });

  it("past due: Premium shows as paused, calls use Standard", () => {
    const html = render(pro({ enabled: false, configured: true, canBuy: true, minutesCap: 0, remaining: 0 }), true);
    expect(html).toContain("Paused");
    expect(html).toContain("Calls use Standard voice");
  });

  it("renders outside the billing-enabled purchase section, so it shows in both states", () => {
    const src = readFileSync("src/components/settings/BillingClient.tsx", "utf8");
    const control = src.indexOf("<PremiumVoiceControl ");
    const purchase = src.indexOf("u?.billing.enabled && (");
    expect(control).toBeGreaterThan(-1);
    expect(control).toBeLessThan(purchase);
  });

  it("the checkout POST sends premium:true only from the new-buyer box while Premium is on sale", () => {
    const src = readFileSync("src/components/settings/BillingClient.tsx", "utf8");
    expect(src).toContain("premium: newBuyerPremium && addPremium");
    expect(src).toMatch(/const newBuyerPremium = premiumOnSale && usage\?\.plan === "free"/);
  });

  it("never shows a model id", () => {
    const html = render(team({ enabled: true, configured: true, canBuy: true, minutesCap: 200, remaining: 150 }), true);
    expect(html).not.toMatch(/gpt-|realtime-|model/i);
  });
});

describe("Premium line on the call setup", () => {
  const snap = (p: Partial<PremiumSnapshot>): PremiumSnapshot => ({ enabled: false, remaining: 0, cap: 0, plan: "pro", onSale: false, canBuy: true, removeAt: null, ...p });
  const line = (p: PremiumSnapshot | null) => renderToStaticMarkup(createElement(PremiumMinutes, { premium: p }));

  it("entitled: Premium: N of 40 min left, Team scaled by the pool", () => {
    expect(line(snap({ enabled: true, remaining: 12, cap: 40 }))).toContain("Premium: 12 of 40 min left");
    expect(line(snap({ enabled: true, remaining: 95, cap: 120, plan: "team" }))).toContain("Premium: 95 of 120 min left");
  });

  it("used up: the nudge, calls continue on Standard", () => {
    // React escapes the apostrophe in "You've".
    const esc = (s: string) => s.replace(/'/g, "&#x27;");
    expect(line(snap({ enabled: true, remaining: 0, cap: 40 }))).toContain(esc(PREMIUM_NUDGE_PRO));
    expect(line(snap({ enabled: true, remaining: 0, cap: 120, plan: "team" }))).toContain(esc(PREMIUM_NUDGE_TEAM));
  });

  it("locked while on sale: Add Premium voice for a buyer, Ask your admin for a Team member", () => {
    expect(line(snap({ onSale: true }))).toContain("Add Premium voice");
    const member = line(snap({ onSale: true, canBuy: false, plan: "team" }));
    expect(member).toContain("Ask your admin");
    expect(member).not.toContain("href=");
  });

  it("nothing on Free, nothing when off sale and not on the plan", () => {
    expect(line(snap({ plan: "free", onSale: true }))).toBe("");
    expect(line(snap({ onSale: false }))).toBe("");
    expect(line(null)).toBe("");
  });
});

describe("checkout step after browser Back", () => {
  it("frees the busy state on a persisted pageshow, as the billing page does", () => {
    const src = readFileSync("src/components/CheckoutStartClient.tsx", "utf8");
    expect(src).toContain('addEventListener("pageshow"');
    expect(src).toContain("e.persisted");
    expect(src).toMatch(/started\.current = false;\s+setBusy\(false\);/);
  });

  it("the new-buyer Premium box is offered only while Premium is on sale, and Pro still starts at once when off", () => {
    const src = readFileSync("src/components/CheckoutStartClient.tsx", "utf8");
    expect(src).toContain("const premiumBox = premiumOnSale && (");
    expect(src).toContain('if (plan === "pro" && !capabilities.premiumOnSale) void go();');
  });

  it("the register page never offers Premium", () => {
    const src = readFileSync("src/app/register/page.tsx", "utf8");
    expect(src).not.toMatch(/premium/i);
  });
});
