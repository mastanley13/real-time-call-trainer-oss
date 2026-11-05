import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRAND_CSS, HOME_TITLE, META_DESCRIPTION, brand, isDefaultTenant, siteHost, tenant } from "@/lib/tenant";
import { DEFAULT_SITE_URL, GITHUB_URL, OG_ALT, pageMetadata, siteUrl } from "@/lib/seo";
import { CONTACT_LINK, LEGAL_LINKS } from "@/lib/legalLinks";
import { ISSUER } from "@/lib/mfa";
import { LIBRARY } from "@/lib/personas";
import { NAV, PRICING_NAV, PUBLIC_NAV, TEAM_NAV, navFor } from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import PublicFooter from "@/components/landing/PublicFooter";
import FooterCredit from "@/components/FooterCredit";
import { stripeStatus } from "@/lib/stripe";
import { googleConfig } from "@/lib/googleAuth";
import { jobFamilyLabel } from "@/lib/scenarios";

/**
 * These read the tenant this test run was generated for (src/generated/tenant.json). `npm test` uses the default
 * tenant; its tail, npm run test:example-tenant, runs this file again with TENANT_CONFIG_DIR=tenants/example.
 */
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const manager = { id: "m", email: "m@example.test", firstName: "M", lastName: "", role: "manager" as const, isPlatformAdmin: false };

describe.runIf(isDefaultTenant)("default tenant parity snapshot (calltrainer.tech)", () => {
  it("keeps the site URL, support email, share text and MFA issuer", () => {
    const prev = process.env.APP_URL;
    delete process.env.APP_URL;
    try {
      expect(siteUrl()).toBe("https://calltrainer.tech");
    } finally {
      if (prev !== undefined) process.env.APP_URL = prev;
    }
    expect(DEFAULT_SITE_URL).toBe("https://calltrainer.tech");
    expect(siteHost).toBe("calltrainer.tech");
    expect(CONTACT_LINK).toEqual({ href: "mailto:support@calltrainer.tech", label: "Contact" });
    expect(LEGAL_LINKS.map((l) => l.href)).toEqual(["/privacy", "/terms"]);
    expect(GITHUB_URL).toBe("https://github.com/mastanley13/real-time-call-trainer-oss");
    expect(OG_ALT).toBe("Real-Time Call Trainer: Practice the call before it costs you the deal");
    expect(ISSUER).toBe("Real-Time Call Trainer");
    expect(brand.operatorName).toBe("StrategixAI LLC");
  });

  it("keeps the home metadata", () => {
    expect(HOME_TITLE).toBe("Real-Time Call Trainer · Hosted AI sales call practice, no setup");
    expect(META_DESCRIPTION).toBe(
      "Hosted AI sales call practice. Talk to AI buyers who push back, get a live coach on every turn, and finish with a graded debrief that quotes your transcript. Start free, no setup. Also open source.",
    );
    const m = pageMetadata({ title: "T", description: "D", path: "/" });
    expect((m.openGraph as { siteName?: string }).siteName).toBe("Real-Time Call Trainer");
  });

  it("emits no brand CSS", () => expect(BRAND_CSS).toBe(""));

  it("ships today's library ids in order", () => {
    const ids = JSON.parse(readFileSync(join(process.cwd(), "tests/fixtures/calltrainer-library-ids.json"), "utf8"));
    expect(LIBRARY.map((s) => s.id)).toEqual(ids);
  });

  it("keeps the nav: Practice, Library, Progress, Team for managers, Pricing for everyone", () => {
    expect(NAV.map((l) => l.label)).toEqual(["Practice", "Library", "Progress"]);
    expect(navFor(null).map((l) => l.label)).toEqual(["Practice", "Library", "Progress"]);
    expect(navFor(manager)).toContain(TEAM_NAV);
    expect(PUBLIC_NAV).toEqual([PRICING_NAV]);
  });

  it("keeps the footers", () => {
    const site = html(createElement(SiteFooter));
    expect(site).toContain("<p>MIT licensed · by Mykel Stanley · originally based on OpenAI’s openai-realtime-agents demo</p>");
    expect(site).toContain('href="mailto:support@calltrainer.tech"');
    expect(site).not.toContain("powered by");
    const pub = html(createElement(PublicFooter, null, createElement(FooterCredit)));
    for (const label of [">Pricing<", ">Privacy<", ">Terms<", ">Contact<", ">GitHub<"]) expect(pub).toContain(label);
    expect(pub).toContain('href="https://github.com/mastanley13/real-time-call-trainer-oss"');
    expect(pub.indexOf(">Pricing<")).toBeLessThan(pub.indexOf(">Privacy<"));
  });

  it("leaves Stripe and Google sign-in to the environment", () => {
    expect(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("ready");
    expect(stripeStatus({})).toBe("disabled");
    expect(googleConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", APP_URL: "https://calltrainer.tech", DATABASE_URL: "postgresql://x" })).not.toBeNull();
  });
});

describe.runIf(tenant.id === "example")("example tenant build", () => {
  it("brands the site without the calltrainer.tech contact", () => {
    expect(brand.name).toBe("Larkspur Practice Desk");
    expect(CONTACT_LINK.href).toBe("mailto:support@example.com");
    expect(ISSUER).toBe("Larkspur Practice Desk");
    expect(BRAND_CSS).toContain("--primary:154 52 18");
    expect(HOME_TITLE).toBe("Larkspur Practice Desk · Practise live calls with an AI coach");
  });

  it("drops pricing, team-less nav stays, and footers say powered by", () => {
    expect(PUBLIC_NAV).toEqual([]);
    const site = html(createElement(SiteFooter));
    expect(site).toContain("Larkspur Practice Desk");
    expect(site).toContain("powered by");
    expect(site).toContain("operated by Larkspur Service Co. (fictional)");
    expect(site).toContain("Fictional example tenant");
    expect(site).not.toContain("Mykel Stanley");
    const pub = html(createElement(PublicFooter));
    expect(pub).not.toContain(">Pricing<");
    expect(pub).not.toContain(">GitHub<");
  });

  it("keeps billing and Google sign-in off even with their env set", () => {
    expect(stripeStatus({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe("disabled");
    expect(googleConfig({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "s", APP_URL: "https://practice.example.com", DATABASE_URL: "postgresql://x" })).toBeNull();
  });

  it("offers the filtered library with the tenant family label", () => {
    expect(new Set(LIBRARY.map((s) => s.role))).toEqual(new Set(["sdr", "cs", "home-services", "field-service"]));
    expect(jobFamilyLabel("field-service")).toBe("Field service");
    expect(jobFamilyLabel("sdr")).toBe("SDR cold calls");
  });
});
