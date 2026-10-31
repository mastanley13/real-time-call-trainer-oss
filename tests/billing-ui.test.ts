import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePrisma } from "./fakePrisma";

const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import {
  CAP_REACHED_MESSAGE, CAP_STOPPED_MESSAGE, PRICE, clampSeats, formatMinutes, freeOverCapNotice, isCapMessage, minutesLeftFromUsage, minutesLeftLabel,
  planPriceLine, premiumLabel, proButtonLabel, teamButtonLabel, usageHeaderCopy,
} from "@/lib/billingUi";
import { stripeTestMode } from "@/lib/stripe";
import { capReached } from "@/lib/usageResponses";
import { GET as usageRoute } from "@/app/api/usage/route";

describe("billing page header copy (item 4)", () => {
  it("Free says calls are checked only at start, runs to its end, and resets monthly", () => {
    const t = usageHeaderCopy("free");
    expect(t).toMatch(/10 voice minutes a month/);
    expect(t).toMatch(/checked only when they start/);
    expect(t).toMatch(/runs to its end/);
    expect(t).toMatch(/reset each month/);
    expect(t).not.toMatch(/stops when its minutes run out/);
  });

  it("paid plans keep the accurate wording: a call stops when its minutes run out", () => {
    for (const plan of ["pro", "team"] as const) {
      const t = usageHeaderCopy(plan);
      expect(t).toMatch(/a call stops when its minutes run out/);
      expect(t).toMatch(/no overage charges/);
      expect(t).not.toMatch(/checked only when they start/);
    }
    expect(usageHeaderCopy("team")).toMatch(/shares one pool/);
  });

  it("says nothing about minutes when they are not tracked", () => {
    expect(usageHeaderCopy(undefined)).not.toMatch(/minutes/);
  });
});

describe("copy rules", () => {
  const all = [
    CAP_REACHED_MESSAGE, CAP_STOPPED_MESSAGE, usageHeaderCopy("free"), usageHeaderCopy("pro"), usageHeaderCopy("team"), usageHeaderCopy(undefined),
    planPriceLine("pro", "month"), planPriceLine("pro", "year"), planPriceLine("team", "month"), planPriceLine("team", "year"),
    premiumLabel("month"), premiumLabel("year"), proButtonLabel("team"), minutesLeftLabel(0.5),
  ];
  it("has no em or en dashes", () => {
    for (const s of all) expect(s).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  it("the cap refusal says practice, not practising, and still points to Text and upgrading", () => {
    expect(CAP_REACHED_MESSAGE).toMatch(/practice/);
    expect(CAP_REACHED_MESSAGE).not.toMatch(/practis/i);
    expect(CAP_REACHED_MESSAGE).toMatch(/Text/);
    expect(CAP_REACHED_MESSAGE).toMatch(/upgrade/i);
  });

  it("the API refusal uses the same message, so the UI can recognize it and add the Upgrade link", async () => {
    const res = capReached();
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.message).toBe(CAP_REACHED_MESSAGE);
    expect(isCapMessage(body.message)).toBe(true);
    expect(isCapMessage(CAP_STOPPED_MESSAGE)).toBe(true);
    expect(isCapMessage("Voice connection error")).toBe(false);
    expect(isCapMessage(undefined)).toBe(false);
  });

  it("no source file still says practising or practise in the cap, briefing or billing copy", () => {
    for (const f of ["src/lib/usageResponses.ts", "src/lib/billingUi.ts", "src/components/call/Briefing.tsx", "src/components/call/CallError.tsx", "src/components/settings/BillingClient.tsx"]) {
      expect(readFileSync(join(process.cwd(), f), "utf8"), f).not.toMatch(/practis(e|ing)/i);
    }
  });
});

describe("minutes left before Start (item 6)", () => {
  it("formats whole and half minutes", () => {
    expect(formatMinutes(10)).toBe("10");
    expect(formatMinutes(9.5)).toBe("9.5");
    expect(formatMinutes(0.1 + 0.2)).toBe("0.3");
    expect(minutesLeftLabel(10)).toBe("10 voice minutes left");
    expect(minutesLeftLabel(1)).toBe("1 voice minute left");
    expect(minutesLeftLabel(0.5)).toBe("0.5 voice minutes left");
  });

  it("reads the remaining minutes from /api/usage, and nothing when minutes are not metered", () => {
    expect(minutesLeftFromUsage({ metered: true, remaining: 7 })).toBe(7);
    expect(minutesLeftFromUsage({ metered: true, remaining: 0 })).toBe(0);
    expect(minutesLeftFromUsage({ metered: true, remaining: -2 })).toBe(0);
    expect(minutesLeftFromUsage({ metered: false, billing: { enabled: false } })).toBeNull();
    expect(minutesLeftFromUsage({ metered: true })).toBeNull();
    expect(minutesLeftFromUsage({ metered: true, remaining: "7" })).toBeNull();
    expect(minutesLeftFromUsage(null)).toBeNull();
  });
});

describe("seats input (item 7)", () => {
  it("clamps to 3 for empty, low and invalid input, and keeps 10", () => {
    expect(clampSeats("")).toBe(3);
    expect(clampSeats("   ")).toBe(3);
    expect(clampSeats("0")).toBe(3);
    expect(clampSeats("2")).toBe(3);
    expect(clampSeats("-4")).toBe(3);
    expect(clampSeats("abc")).toBe(3);
    expect(clampSeats("3")).toBe(3);
    expect(clampSeats("10")).toBe(10);
    expect(clampSeats("12.9")).toBe(12);
    expect(clampSeats("9999")).toBe(500);
  });

  it("the component only clamps on blur and on submit, never in onChange", () => {
    const src = readFileSync(join(process.cwd(), "src/components/settings/BillingClient.tsx"), "utf8");
    expect(src).toMatch(/onChange=\{\(e\) => setSeatsText\(e\.target\.value\)\}/);
    expect(src).toMatch(/onBlur=\{\(\) => setSeatsText\(String\(clampSeats\(seatsText\)\)\)\}/);
    expect(src).toMatch(/const seats = clampSeats\(seatsText\)/);
  });
});

describe("checkout buttons (item 8)", () => {
  const src = readFileSync(join(process.cwd(), "src/components/settings/BillingClient.tsx"), "utf8");

  it("every checkout and portal button is disabled while busy", () => {
    for (const call of ['go("pro")', 'go("team")', 'go("portal")']) {
      const line = src.split("\n").find((l) => l.includes(`onClick={() => ${call}}`));
      expect(line, call).toBeDefined();
      expect(line, call).toMatch(/disabled=\{!!busy/);
      expect(line, call).not.toMatch(/aria-disabled/);
    }
  });

  it("a second click in the same tick is ignored by a ref guard", () => {
    expect(src).toMatch(/if \(busyRef\.current\) return;\s+busyRef\.current = kind;/);
    expect(src).toMatch(/busyRef\.current = null;\s+setBusy\(null\);/);
  });
});

describe("annual prices (item 9)", () => {
  it("monthly and annual price lines match the locked prices", () => {
    expect(planPriceLine("pro", "month")).toMatch(/^\$29 per user per month\./);
    expect(planPriceLine("pro", "year")).toMatch(/^\$290 per user per year\./);
    expect(planPriceLine("team", "month")).toMatch(/^\$59 per seat per month, 3 seats minimum\./);
    expect(planPriceLine("team", "year")).toMatch(/^\$590 per seat per year, 3 seats minimum\./);
    expect(premiumLabel("month")).toBe("Add Premium Voice (+$30 per seat per month)");
    expect(premiumLabel("year")).toBe("Add Premium Voice (+$300 per seat per year)");
  });

  it("annual is ten months for twelve, as the Annual, 2 months free label says", () => {
    for (const p of ["pro", "team", "premium"] as const) expect(PRICE[p].year).toBe(PRICE[p].month * 10);
  });
});

describe("a Free user over the cap (Prism b)", () => {
  const reset = "11/10/2026";

  it("13 of 10 explains that the last call was allowed to finish, when voice resets, and that text is open", () => {
    const t = freeOverCapNotice({ plan: "free", used: 13, cap: 10, resetDate: reset })!;
    expect(t).toMatch(/last call was allowed to finish/);
    expect(t).toMatch(/13 of 10 voice minutes this month/);
    expect(t).toContain(`reset on ${reset}`);
    expect(t).toMatch(/Voice calls start again/);
    expect(t).toMatch(/Text practice is still open/);
    expect(t).not.toMatch(new RegExp("[\\u2013\\u2014]"));
  });

  it("shows a half minute as is, and says all minutes are used at exactly the cap", () => {
    expect(freeOverCapNotice({ plan: "free", used: 12.5, cap: 10, resetDate: reset })).toMatch(/12\.5 of 10/);
    const exact = freeOverCapNotice({ plan: "free", used: 10, cap: 10, resetDate: reset })!;
    expect(exact).toMatch(/used all 10 voice minutes this month/);
    expect(exact).not.toMatch(/last call was allowed/);
    expect(exact).toMatch(/Text practice is still open/);
  });

  it("says nothing while minutes are left, or on a paid plan", () => {
    expect(freeOverCapNotice({ plan: "free", used: 9.5, cap: 10, resetDate: reset })).toBeNull();
    expect(freeOverCapNotice({ plan: "free", used: 0, cap: 10, resetDate: reset })).toBeNull();
    expect(freeOverCapNotice({ plan: "pro", used: 250, cap: 200, resetDate: reset })).toBeNull();
    expect(freeOverCapNotice({ plan: "team", used: 1000, cap: 900, resetDate: reset })).toBeNull();
    expect(freeOverCapNotice({ plan: undefined, used: 13, cap: 10, resetDate: reset })).toBeNull();
  });

  it("still gives a usable sentence when the reset date is unknown", () => {
    expect(freeOverCapNotice({ plan: "free", used: 13, cap: 10, resetDate: "" })).toMatch(/Voice calls start again when your minutes reset next month\./);
  });

  it("the billing page renders the notice from the usage numbers", () => {
    const src = readFileSync(join(process.cwd(), "src/components/settings/BillingClient.tsx"), "utf8");
    expect(src).toMatch(/freeOverCapNotice\(\{ plan: u\.plan, used: u\.minutesUsed \?\? 0, cap: u\.minutesCap \?\? 0/);
    expect(src).toMatch(/\{overCap && <p className="banner-warn mt-3" role="status">\{overCap\}<\/p>\}/);
  });

  describe("from GET /api/usage", () => {
    beforeEach(() => {
      mocks.fake = createFakePrisma();
      mocks.fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-03-10T12:00:00Z") });
      mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", organizationId: "org-1", usageAnchorAt: new Date("2026-03-10T12:00:00Z"), createdAt: new Date("2026-03-10T12:00:00Z"), role: "rep" });
      vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
      vi.stubEnv("DEMO_MODE", "");
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
    });
    afterEach(() => vi.unstubAllEnvs());

    it("a Free account at 13 of 10 reports 13 used and none left, which is what the notice reads", async () => {
      const first = await (await usageRoute(new NextRequest("http://localhost/api/usage"))).json();
      expect(first).toMatchObject({ plan: "free", minutesCap: 10, minutesUsed: 0, remaining: 10 });
      mocks.fake.rows("usageAllowance")[0].minutesUsed = 13;
      const body = await (await usageRoute(new NextRequest("http://localhost/api/usage"))).json();
      expect(body).toMatchObject({ plan: "free", minutesCap: 10, minutesUsed: 13, remaining: 0 });
      const notice = freeOverCapNotice({ plan: body.plan, used: body.minutesUsed, cap: body.minutesCap, resetDate: reset });
      expect(notice).toMatch(/13 of 10/);
      expect(first.remaining).toBe(10);
      expect(freeOverCapNotice({ plan: first.plan, used: first.minutesUsed, cap: first.minutesCap, resetDate: reset })).toBeNull();
    });
  });
});

describe("plan buttons", () => {
  it("a Team user sees Included in Team on Pro", () => {
    expect(proButtonLabel("team")).toBe("Included in Team");
    expect(proButtonLabel("pro")).toBe("Current plan");
    expect(proButtonLabel("free")).toBe("Choose Pro");
    expect(proButtonLabel(undefined)).toBe("Choose Pro");
    expect(teamButtonLabel("team")).toBe("Current plan");
    expect(teamButtonLabel("pro")).toBe("Choose Team");
  });

  it("the success banner uses the success style, not the warning style", () => {
    const src = readFileSync(join(process.cwd(), "src/components/settings/BillingClient.tsx"), "utf8");
    const line = src.split("\n").find((l) => l.includes('checkout === "success"'))!;
    expect(line).toMatch(/banner-ok/);
    expect(line).not.toMatch(/banner-warn/);
    expect(readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8")).toMatch(/\.banner-ok \{ @apply [^}]*ok-soft/);
  });
});

describe("test mode note", () => {
  it("is on only for a Stripe test key", () => {
    expect(stripeTestMode({ STRIPE_SECRET_KEY: "sk_test_abc" })).toBe(true);
    expect(stripeTestMode({ STRIPE_SECRET_KEY: "sk_live_abc" })).toBe(false);
    expect(stripeTestMode({})).toBe(false);
    expect(stripeTestMode({ STRIPE_SECRET_KEY: "sk_test_abc", DEMO_MODE: "true" })).toBe(false);
  });

  describe("GET /api/usage", () => {
    beforeEach(() => {
      mocks.fake = createFakePrisma();
      mocks.fake.seed("organization", { id: "org-1", code: "123", createdAt: new Date("2026-03-10T12:00:00Z") });
      mocks.fake.seed("user", { id: "u-1", email: "u-1@example.test", organizationId: "org-1", usageAnchorAt: new Date("2026-03-10T12:00:00Z"), createdAt: new Date("2026-03-10T12:00:00Z"), role: "rep" });
      vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
      vi.stubEnv("DEMO_MODE", "");
    });
    afterEach(() => vi.unstubAllEnvs());
    const get = () => usageRoute(new NextRequest("http://localhost/api/usage"));

    it("reports testMode with a test key, and the page shows the note only then", async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
      const body = await (await get()).json();
      expect(body).toMatchObject({ metered: true, plan: "free", minutesCap: 10, remaining: 10, billing: { enabled: true, testMode: true } });
      const page = readFileSync(join(process.cwd(), "src/components/settings/BillingClient.tsx"), "utf8");
      expect(page).toMatch(/u\.billing\.testMode \? " Test mode only/);
      expect(page).not.toMatch(/\.<\/p>[^\n]*Test mode only: use Stripe test cards\.<\/p>/);
    });

    it("has no billing section data without a Stripe key", async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "");
      expect(await (await get()).json()).toEqual({ metered: false, billing: { enabled: false } });
    });
  });
});
