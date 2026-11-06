import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import PricingPage from "@/app/pricing/page";
import LegalLinks from "@/components/LegalLinks";
import SiteFooter from "@/components/SiteFooter";
import ComparePlans, { cellText } from "@/components/landing/ComparePlans";
import PublicFooter from "@/components/landing/PublicFooter";
import { CONTACT_LINK } from "@/lib/legalLinks";
import { AI_CHIP_LABEL, showModelChip } from "@/lib/modelChip";
import { PRICE } from "@/lib/pricing";
import { planHeads } from "@/lib/pricingWorkbook";
import { getCapabilities } from "@/lib/serverConfig";

afterEach(() => vi.unstubAllEnvs());

describe("compare table price row follows the billing period", () => {
  const price = { month: "$29/mo", year: "$290/yr" };

  it("picks the cell for the period and passes plain strings through", () => {
    expect(cellText(price, "month")).toBe("$29/mo");
    expect(cellText(price, "year")).toBe("$290/yr");
    expect(cellText("Full", "year")).toBe("Full");
  });

  it("renders monthly by default", () => {
    const html = renderToStaticMarkup(createElement(ComparePlans, { rows: [{ feature: "Price", self: "a", free: "$0", pro: price, team: "c" }] }));
    expect(html).toContain("$29/mo");
    expect(html).not.toContain("$290/yr");
  });

  it("the workbook takes its annual prices from pricing.ts and renders the monthly ones by default", () => {
    expect(PRICE.pro.year).toBe(290);
    expect(PRICE.team.year).toBe(590);
    const year = planHeads("year");
    expect([year.pro.price, year.pro.unit, year.team.price, year.team.unit]).toEqual(["$290", "per year", "$590", "per seat, per year"]);
    const html = renderToStaticMarkup(createElement(PricingPage));
    expect(html).toContain(">$29</span>");
    expect(html).toContain(">$59</span>");
    expect(html).toContain("per seat, per month");
    expect(html).toContain("$177 a month minimum");
  });
});

describe("footer Contact link", () => {
  it.each([
    ["SiteFooter", () => renderToStaticMarkup(createElement(SiteFooter))],
    ["PublicFooter", () => renderToStaticMarkup(createElement(PublicFooter))],
    ["LegalLinks", () => renderToStaticMarkup(createElement(LegalLinks))],
  ])("%s links Contact to support", (_name, render) => {
    expect(CONTACT_LINK.href).toBe("mailto:support@calltrainer.tech");
    expect(render()).toContain(`href="${CONTACT_LINK.href}"`);
    expect(render()).toContain(">Contact<");
  });
});

describe("header AI status chip", () => {
  const caps = { llm: true };

  it("shows on self-host for anyone", () => {
    expect(showModelChip({ ...caps, hosted: false }, null)).toBe(true);
    expect(showModelChip(caps, { isPlatformAdmin: false })).toBe(true);
  });

  it("hides on hosted for guests and normal users, shows for platform admins", () => {
    expect(showModelChip({ ...caps, hosted: true }, null)).toBe(false);
    expect(showModelChip({ ...caps, hosted: true }, { isPlatformAdmin: false })).toBe(false);
    expect(showModelChip({ ...caps, hosted: true }, { isPlatformAdmin: true })).toBe(true);
  });

  it("still needs an LLM key, and its label never names a model", () => {
    expect(showModelChip(null, null)).toBe(false);
    expect(showModelChip({ llm: false }, null)).toBe(false);
    expect(showModelChip({ llm: true }, null)).toBe(true);
    expect(AI_CHIP_LABEL).toBe("AI on");
  });

  it("capabilities report hosted from the Stripe config", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    expect(getCapabilities().hosted).toBe(false);
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    expect(getCapabilities().hosted).toBe(true);
  });
});

describe("copy", () => {
  it("has no dashes in the new files", () => {
    for (const f of ["src/components/landing/BillingContext.tsx", "src/lib/modelChip.ts", "src/lib/legalLinks.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/[–—]/);
    }
  });
});
