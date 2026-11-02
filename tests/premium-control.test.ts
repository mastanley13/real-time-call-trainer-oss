import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PremiumVoiceControl from "@/components/settings/PremiumVoiceControl";
import { PREMIUM_COMING_SOON } from "@/lib/pricing";

describe("Premium control on /settings/billing", () => {
  it("shows the label on a checkbox that is disabled and unchecked", () => {
    const html = renderToStaticMarkup(createElement(PremiumVoiceControl));
    expect(html).toContain(PREMIUM_COMING_SOON);
    expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*disabled/);
    expect(html).not.toMatch(/checked=""/);
  });

  it("renders outside the billing-enabled purchase section, so it shows in both states", () => {
    const src = readFileSync("src/components/settings/BillingClient.tsx", "utf8");
    const control = src.indexOf("<PremiumVoiceControl />");
    const purchase = src.indexOf("u?.billing.enabled && (");
    expect(control).toBeGreaterThan(-1);
    expect(control).toBeLessThan(purchase);
  });

  it("the checkout POST never sends premium:true", () => {
    const src = readFileSync("src/components/settings/BillingClient.tsx", "utf8");
    expect(src).toContain("premium: false");
    expect(src).not.toMatch(/premium: premium|premium,/);
  });
});

describe("checkout step after browser Back", () => {
  it("frees the busy state on a persisted pageshow, as the billing page does", () => {
    const src = readFileSync("src/components/CheckoutStartClient.tsx", "utf8");
    expect(src).toContain('addEventListener("pageshow"');
    expect(src).toContain("e.persisted");
    expect(src).toMatch(/started\.current = false;\s+setBusy\(false\);/);
  });
});
