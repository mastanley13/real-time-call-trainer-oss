import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import postcss from "postcss";
import tailwind from "tailwindcss";
import { createFakePrisma } from "./fakePrisma";

// Round 7: the UX fixes from the browser pass. Components that have no hooks are rendered to markup and read; the rest
// is pure helpers and the real /api/usage and /api/billing/checkout routes on the fake database.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import Briefing from "@/components/call/Briefing";
import MinutesLeft from "@/components/call/MinutesLeft";
import BillingAlert from "@/components/settings/BillingAlert";
import SeatsField from "@/components/settings/SeatsField";
import {
  ASK_ADMIN_MESSAGE, CAP_REACHED_MESSAGE, CHECKOUT_NETWORK_MESSAGE, CHECKOUT_UNAVAILABLE_MESSAGE, OUT_OF_MINUTES_MESSAGE, ROUND_UP_NOTE,
  SEATS_CLAMPED_NOTE, SEATS_HELP, SUPPORT_URL, TEXT_UNLIMITED_MESSAGE, checkoutFailure, seatsOnBlur, usageHeaderCopy, usageSnapshotFromUsage,
  voiceMinutesLeftLabel, type UsageSnapshot,
} from "@/lib/billingUi";
import { FREE_MINUTES, TEAM_MIN_SEATS, TEAM_MINUTES_PER_SEAT } from "@/lib/usagePlan";
import { resetPriceCache } from "@/lib/billing";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { GET as usageRoute } from "@/app/api/usage/route";
import { POST as checkoutRoute } from "@/app/api/billing/checkout/route";
import tailwindConfig from "../tailwind.config";

const read = (f: string) => readFileSync(join(process.cwd(), f), "utf8");
const DASH = new RegExp("[\\u2013\\u2014]");
const ANCHOR = new Date("2026-03-10T12:00:00Z");

/** The metered /api/usage numbers for a user, on the fake database with metering on. */
async function usageOf(userId: string) {
  mocks.authId = userId;
  return (await usageRoute(new NextRequest("http://localhost/api/usage"))).json();
}

function seedAccounts() {
  mocks.fake = createFakePrisma();
  mocks.fake.seed("organization", { id: "org-free", code: "111", createdAt: ANCHOR });
  mocks.fake.seed("organization", { id: "org-team", code: "222", createdAt: ANCHOR, planTier: "team", seatCount: 3 });
  const u = (id: string, org: string, role: string, extra: Record<string, unknown> = {}) =>
    mocks.fake.seed("user", { id, email: `${id}@example.test`, organizationId: org, usageAnchorAt: ANCHOR, createdAt: ANCHOR, role, ...extra });
  u("free-1", "org-free", "rep");
  u("pro-1", "org-free", "rep", { planTier: "pro" });
  u("team-rep", "org-team", "rep");
  u("team-owner", "org-team", "owner");
}

beforeEach(() => {
  seedAccounts();
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  // Checkout only asks Stripe about allowlisted price ids.
  vi.stubEnv("STRIPE_PRICE_PRO_MONTHLY", "price_test_pro_m");
  resetPriceCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.authId = "u-1";
});

// ---- 1. Minutes left near Start call ----------------------------------------------------------------

describe("1. minutes left on the briefing, before Start", () => {
  const html = (usage: UsageSnapshot | null, mode: "voice" | "text", canUpgrade?: boolean) => renderToStaticMarkup(createElement(MinutesLeft, { usage, mode, canUpgrade }));

  it("Free with all 10 minutes: 10 of 10 voice minutes left, no upgrade prompt", () => {
    const out = html({ remaining: FREE_MINUTES, cap: FREE_MINUTES }, "voice");
    expect(out).toContain(`${FREE_MINUTES} of ${FREE_MINUTES} voice minutes left`);
    expect(out).not.toContain(OUT_OF_MINUTES_MESSAGE);
    expect(out).not.toContain("Upgrade");
  });

  it("Free with half a minute left: 0.5 of 10 voice minutes left", () => {
    const out = html({ remaining: 0.5, cap: FREE_MINUTES }, "voice");
    expect(out).toContain(`0.5 of ${FREE_MINUTES} voice minutes left`);
    expect(out).not.toContain(OUT_OF_MINUTES_MESSAGE);
  });

  it("Free with none left: Out of voice minutes this month, plus the Upgrade link to billing", () => {
    const out = html({ remaining: 0, cap: FREE_MINUTES }, "voice");
    expect(out).toContain("Out of voice minutes this month.");
    expect(out).toContain('href="/settings/billing"');
    expect(out).toContain("Upgrade");
    expect(out).not.toContain(ASK_ADMIN_MESSAGE);
    expect(out).toContain(`0 of ${FREE_MINUTES} voice minutes left`);
  });

  it("a Team pool member with none left is told to ask their team admin, with no link they cannot use", () => {
    const out = html({ remaining: 0, cap: TEAM_MINUTES_PER_SEAT * 3 }, "voice", false);
    expect(out).toContain("Out of voice minutes this month.");
    expect(out).toContain("Ask your team admin for more minutes.");
    expect(out).not.toContain("href=");
    expect(out).not.toContain("Upgrade");
  });

  it("text mode shows no count, only that text practice is unlimited, even with none left", () => {
    for (const remaining of [FREE_MINUTES, 0.5, 0]) {
      const out = html({ remaining, cap: FREE_MINUTES }, "text");
      expect(out).toContain("Text practice is unlimited.");
      expect(out).not.toContain("voice minutes left");
      expect(out).not.toContain(OUT_OF_MINUTES_MESSAGE);
    }
  });

  it("shows nothing when minutes are not metered", () => {
    expect(html(null, "voice")).toBe("");
    expect(html(null, "text")).toBe("");
  });

  describe("on the real briefing, with voice keys missing", () => {
    // No voice engines and no engine chosen: the "Voice calls need an OpenAI key" state.
    const noVoice = { demoMode: false, elevenlabs: false, voiceEngines: [], llm: false, database: true } as never;
    const render = (props: { mode: "voice" | "text"; usage?: UsageSnapshot | null; canUpgrade?: boolean; error?: string }) =>
      renderToStaticMarkup(createElement(Briefing, {
        scenario: BUILT_IN_SCENARIOS[0], capabilities: noVoice, engine: null, coachMode: "coached",
        onModeChange: () => {}, onEngineChange: () => {}, onCoachModeChange: () => {}, onStart: () => {}, ...props,
      }));

    it("still shows the count in Voice mode, next to Start call", () => {
      const out = render({ mode: "voice", usage: { remaining: 0.5, cap: FREE_MINUTES } });
      expect(out).toContain("Voice calls need an OpenAI key or ElevenLabs keys on the server");
      expect(out).toContain(`0.5 of ${FREE_MINUTES} voice minutes left`);
      expect(out.indexOf("voice minutes left")).toBeLessThan(out.indexOf("Start call"));
    });

    it("shows the out-of-minutes panel with Upgrade, or the admin line for a pool member", () => {
      const free = render({ mode: "voice", usage: { remaining: 0, cap: FREE_MINUTES } });
      expect(free).toContain("Out of voice minutes this month.");
      expect(free).toContain('href="/settings/billing"');
      const member = render({ mode: "voice", usage: { remaining: 0, cap: 900 }, canUpgrade: false });
      expect(member).toContain("Ask your team admin for more minutes.");
      expect(member).not.toContain('href="/settings/billing"');
    });

    it("Text mode says text practice is unlimited, and a count-less briefing (not metered) says nothing", () => {
      expect(render({ mode: "text", usage: { remaining: 0, cap: FREE_MINUTES } })).toContain("Text practice is unlimited.");
      const plain = render({ mode: "voice", usage: null });
      expect(plain).not.toContain("voice minutes left");
      expect(plain).not.toContain("Text practice is unlimited.");
    });

    it("a refusal from the server and the out-of-minutes panel are not both shown: the panel stays, with its details", () => {
      const out = render({ mode: "voice", usage: { remaining: 0, cap: FREE_MINUTES }, error: CAP_REACHED_MESSAGE });
      expect(out).toContain(OUT_OF_MINUTES_MESSAGE);
      expect(out).toContain(`0 of ${FREE_MINUTES} voice minutes left`);
      expect(out).not.toContain(CAP_REACHED_MESSAGE);
      expect(out.match(/href="\/settings\/billing"/g)).toHaveLength(1);
    });
  });

  describe("from /api/usage, with metering on", () => {
    it("a new Free account has all 10 minutes", async () => {
      const snap = usageSnapshotFromUsage(await usageOf("free-1"));
      expect(snap).toMatchObject({ remaining: FREE_MINUTES, cap: FREE_MINUTES });
      expect(html(snap, "voice")).toContain(voiceMinutesLeftLabel({ remaining: FREE_MINUTES, cap: FREE_MINUTES }));
    });

    it("a Free account at 9.5 of 10 used shows 0.5 of 10 left, and at 10 of 10 used shows out of minutes", async () => {
      await usageOf("free-1");
      const allowance = mocks.fake.rows("usageAllowance").find((a) => a.userId === "free-1")!;
      allowance.minutesUsed = FREE_MINUTES - 0.5;
      const half = await usageOf("free-1");
      expect(html(usageSnapshotFromUsage(half), "voice", half.billing.canUpgrade)).toContain(`0.5 of ${FREE_MINUTES} voice minutes left`);
      allowance.minutesUsed = FREE_MINUTES;
      const none = await usageOf("free-1");
      const out = html(usageSnapshotFromUsage(none), "voice", none.billing.canUpgrade);
      expect(out).toContain("Out of voice minutes this month.");
      expect(out).toContain('href="/settings/billing"');
    });

    it("a Team member at 0 of the pool is told to ask the admin; the owner at 0 gets Upgrade", async () => {
      await usageOf("team-rep");
      mocks.fake.rows("usageAllowance").find((a) => a.organizationId === "org-team")!.minutesUsed = TEAM_MINUTES_PER_SEAT * 3;
      const rep = await usageOf("team-rep");
      expect(rep).toMatchObject({ pooled: true, remaining: 0 });
      const repHtml = html(usageSnapshotFromUsage(rep), "voice", rep.billing.canUpgrade);
      expect(repHtml).toContain("Ask your team admin for more minutes.");
      expect(repHtml).not.toContain("href=");
      const owner = await usageOf("team-owner");
      const ownerHtml = html(usageSnapshotFromUsage(owner), "voice", owner.billing.canUpgrade);
      expect(ownerHtml).toContain('href="/settings/billing"');
      expect(ownerHtml).not.toContain(ASK_ADMIN_MESSAGE);
    });

    it("is absent without metering, so nothing is shown", async () => {
      vi.stubEnv("STRIPE_SECRET_KEY", "");
      expect(usageSnapshotFromUsage(await usageOf("free-1"))).toBeNull();
    });
  });

  it("reads only usable numbers from /api/usage", () => {
    expect(usageSnapshotFromUsage({ metered: true, remaining: 3, minutesCap: 10 })).toMatchObject({ remaining: 3, cap: 10 });
    expect(usageSnapshotFromUsage({ metered: true, remaining: -1, minutesCap: 10 })).toMatchObject({ remaining: 0, cap: 10 });
    expect(usageSnapshotFromUsage({ metered: true, remaining: 3, minutesCap: 10, periodEnd: "2026-11-10T12:00:00.000Z", billing: { enabled: false } }))
      .toEqual({ remaining: 3, cap: 10, resetsAt: "2026-11-10T12:00:00.000Z", billingEnabled: false });
    expect(usageSnapshotFromUsage({ metered: true, remaining: 3 })).toBeNull();
    expect(usageSnapshotFromUsage({ metered: false, billing: { enabled: false } })).toBeNull();
    expect(usageSnapshotFromUsage({ metered: true, remaining: Number.NaN, minutesCap: 10 })).toBeNull();
    expect(usageSnapshotFromUsage(null)).toBeNull();
  });

  it("the copy is plain and has no dashes", () => {
    for (const s of [OUT_OF_MINUTES_MESSAGE, TEXT_UNLIMITED_MESSAGE, voiceMinutesLeftLabel({ remaining: 0.5, cap: 10 })]) expect(s).not.toMatch(DASH);
  });
});

// ---- 2. Checkout failure message ----------------------------------------------------------------------

describe("2. checkout failure message", () => {
  it("server and config errors (5xx) say checkout is unavailable and the plan has not changed, with the help link", () => {
    for (const status of [500, 502, 503, 504]) {
      expect(checkoutFailure({ status, message: "Could not start checkout. Try again in a moment." })).toEqual({ message: CHECKOUT_UNAVAILABLE_MESSAGE, help: true });
    }
    expect(CHECKOUT_UNAVAILABLE_MESSAGE).toBe("Checkout is unavailable right now. Your plan has not changed.");
    // An answer that is not an error but has no checkout address is also on our side.
    expect(checkoutFailure({ status: undefined })).toEqual({ message: CHECKOUT_UNAVAILABLE_MESSAGE, help: true });
    expect(CHECKOUT_UNAVAILABLE_MESSAGE).not.toMatch(/try again/i);
  });

  it("Try again in a moment is kept only for a request that got no answer", () => {
    expect(checkoutFailure({ networkError: true })).toEqual({ message: CHECKOUT_NETWORK_MESSAGE, help: false });
    expect(CHECKOUT_NETWORK_MESSAGE).toMatch(/Try again in a moment\./);
  });

  it("a 4xx keeps the server's own sentence, which says what to fix", () => {
    const seats = "Team needs between 3 and 500 seats.";
    expect(checkoutFailure({ status: 400, message: seats })).toEqual({ message: seats, help: false });
    expect(checkoutFailure({ status: 409, message: "This account already has a paid plan. Use Manage billing to change it." }).help).toBe(false);
  });

  it("the banner stays an alert, and links to the issues page only when asked", () => {
    const plain = renderToStaticMarkup(createElement(BillingAlert, { message: CHECKOUT_NETWORK_MESSAGE }));
    expect(plain).toContain('role="alert"');
    expect(plain).toContain("banner-warn");
    expect(plain).not.toContain("<a ");

    const helped = renderToStaticMarkup(createElement(BillingAlert, { message: CHECKOUT_UNAVAILABLE_MESSAGE, help: true }));
    expect(helped).toContain('role="alert"');
    expect(helped).toContain("banner-warn");
    expect(helped).toContain(CHECKOUT_UNAVAILABLE_MESSAGE);
    expect(helped).toContain(`href="${SUPPORT_URL}"`);
    expect(helped).toContain('rel="noopener noreferrer"');
  });

  it("points at GitHub issues, not an email address, and has no dashes", () => {
    expect(SUPPORT_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/);
    for (const s of [CHECKOUT_UNAVAILABLE_MESSAGE, CHECKOUT_NETWORK_MESSAGE, SUPPORT_URL, renderToStaticMarkup(createElement(BillingAlert, { message: "x", help: true }))]) {
      expect(s).not.toContain("@");
      expect(s).not.toMatch(DASH);
    }
  });

  it("a placeholder Stripe key makes the real checkout route answer 502 with the new copy, which the page shows as an alert with the link", async () => {
    // Stripe refuses the placeholder key, as it does for a key that is not real.
    const stripe = vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API Key provided" } }), { status: 401 }));
    vi.stubGlobal("fetch", stripe);
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.authId = "free-1";
    const res = await checkoutRoute(new NextRequest("http://localhost/api/billing/checkout", { method: "POST", body: JSON.stringify({ plan: "pro", interval: "month" }), headers: { "content-type": "application/json" } }));
    expect(stripe).toHaveBeenCalled();
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toMatchObject({ error: "stripe_error", message: CHECKOUT_UNAVAILABLE_MESSAGE });
    // Nothing from Stripe's answer reaches the user.
    expect(JSON.stringify(body)).not.toMatch(/Invalid API Key/);

    const shown = checkoutFailure({ status: res.status, message: body.message });
    expect(shown).toEqual({ message: CHECKOUT_UNAVAILABLE_MESSAGE, help: true });
    const banner = renderToStaticMarkup(createElement(BillingAlert, shown));
    expect(banner).toContain('role="alert"');
    expect(banner).toContain(CHECKOUT_UNAVAILABLE_MESSAGE);
    expect(banner).toContain(SUPPORT_URL);
    // And no checkout was recorded for a purchase that never started.
    expect(mocks.fake.rows("user").find((x) => x.id === "free-1")!.stripeCheckoutSessionId ?? null).toBeNull();
  });

  it("the page uses it: a network failure and a bad answer take different paths", () => {
    const src = read("src/components/settings/BillingClient.tsx");
    expect(src).toMatch(/checkoutFailure\(\{ networkError: true \}\)/);
    expect(src).toMatch(/checkoutFailure\(\{ status: res\.ok \? undefined : res\.status, message: data\.message \}\)/);
    expect(src).toMatch(/<BillingAlert message=\{error\.message\} help=\{error\.help\} \/>/);
  });
});

// ---- 3. Seats under 3 ---------------------------------------------------------------------------------

describe("3. seats under 3 say so", () => {
  const field = (value: string, note: string | null, disabled = false) =>
    renderToStaticMarkup(createElement(SeatsField, { value, note, disabled, onChange: () => {}, onBlur: () => {} }));
  const describedBy = (html: string) => (html.match(/aria-describedby="([^"]*)"/) ?? [])[1]?.split(" ") ?? [];
  const idsIn = (html: string) => [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);

  it("always shows Team starts at 3 seats under the field, linked to it", () => {
    const out = field("3", null);
    expect(out).toContain("Team starts at 3 seats.");
    expect(SEATS_HELP).toBe(`Team starts at ${TEAM_MIN_SEATS} seats.`);
    expect(describedBy(out)).toEqual(["seats-help"]);
    expect(out).toMatch(/<p id="seats-help"[^>]*>Team starts at 3 seats\.<\/p>/);
  });

  it("type 2, Tab away: the box goes to 3, the note appears, and it is announced and linked", () => {
    const left = seatsOnBlur("2");
    expect(left).toEqual({ value: "3", note: "Set to 3, the Team minimum." });
    const out = field(left.value, left.note);
    expect(out).toContain('value="3"');
    expect(out).toMatch(/<p id="seats-note" role="status"[^>]*>Set to 3, the Team minimum\.<\/p>/);
    // aria-describedby names the help line and the note, and both exist in the page.
    expect(describedBy(out)).toEqual(["seats-help", "seats-note"]);
    for (const id of describedBy(out)) expect(idsIn(out)).toContain(id);
  });

  it("the status region is in the page before the note, so a screen reader announces it when the text arrives", () => {
    const before = field("3", null);
    expect(before).toMatch(/<p id="seats-note" role="status"[^>]*><\/p>/);
    expect(describedBy(before)).not.toContain("seats-note");
  });

  it("anything below 3, empty or not a number sets 3 and says so; 3 and up keep what was typed and say nothing", () => {
    for (const typed of ["1", "2", "0", "-4", "", "  ", "abc", "2.9"]) expect(seatsOnBlur(typed), JSON.stringify(typed)).toEqual({ value: "3", note: SEATS_CLAMPED_NOTE });
    expect(seatsOnBlur("3")).toEqual({ value: "3", note: null });
    expect(seatsOnBlur("10")).toEqual({ value: "10", note: null });
    expect(seatsOnBlur("500")).toEqual({ value: "500", note: null });
  });

  it("typing does not clamp or show the note: the page only stores the text and clears an old note", () => {
    const src = read("src/components/settings/BillingClient.tsx");
    expect(src).toMatch(/onChange=\{\(text\) => \{ setSeatsText\(text\); setSeatsNote\(null\); \}\}/);
    expect(src).toMatch(/onBlur=\{\(\) => \{ const left = seatsOnBlur\(seatsText\); setSeatsText\(left\.value\); setSeatsNote\(left\.note\); \}\}/);
    // Submit clamps too, and shows the note if it had to.
    expect(src).toMatch(/if \(kind === "team"\) \{ setSeatsText\(left\.value\); setSeatsNote\(left\.note\); \}/);
  });

  it("the copy has no dashes", () => {
    expect(SEATS_HELP).not.toMatch(DASH);
    expect(SEATS_CLAMPED_NOTE).not.toMatch(DASH);
  });
});

// ---- 4. Round-up note on paid plans -------------------------------------------------------------------

describe("4. whole minutes, rounded up", () => {
  it("the Pro and Team billing intro says it; the Free intro does not", () => {
    expect(ROUND_UP_NOTE).toBe("Calls are counted in whole minutes, rounded up.");
    expect(usageHeaderCopy("pro")).toContain(ROUND_UP_NOTE);
    expect(usageHeaderCopy("team")).toContain(ROUND_UP_NOTE);
    expect(usageHeaderCopy("team", true)).toContain(ROUND_UP_NOTE);
    expect(usageHeaderCopy("free")).not.toContain(ROUND_UP_NOTE);
    expect(usageHeaderCopy("free")).not.toMatch(/rounded up|whole minutes/);
    expect(usageHeaderCopy(undefined)).not.toContain(ROUND_UP_NOTE);
  });

  it("the Free intro is unchanged except for the signup date fix", () => {
    expect(usageHeaderCopy("free")).toBe(
      `Free includes ${FREE_MINUTES} voice minutes a month. Voice calls are checked only when they start, so a call that begins with minutes left runs to its end and counts toward the month. Your minutes reset monthly from your signup date and do not roll over. Text practice is never limited, and there are no overage charges.`,
    );
  });

  it("paid intros keep their other wording", () => {
    expect(usageHeaderCopy("pro")).toBe(
      `Voice minutes reset every month on your signup date. Unused minutes do not roll over, and a call stops when its minutes run out. ${ROUND_UP_NOTE} Text practice is never limited, and there are no overage charges.`,
    );
    expect(usageHeaderCopy("team")).toBe(
      `Your team shares one pool of voice minutes. Voice minutes reset every month on your organization's start date. Unused minutes do not roll over, and a call stops when its minutes run out. ${ROUND_UP_NOTE} Text practice is never limited, and there are no overage charges.`,
    );
  });

  it("each plan's billing page gets its own intro from the usage the page loads", async () => {
    const pro = await usageOf("pro-1");
    expect(pro).toMatchObject({ plan: "pro" });
    expect(usageHeaderCopy(pro.plan, pro.pooled)).toContain(ROUND_UP_NOTE);
    const member = await usageOf("team-rep");
    expect(member).toMatchObject({ plan: "team", pooled: true });
    expect(usageHeaderCopy(member.plan, member.pooled)).toContain(ROUND_UP_NOTE);
    const free = await usageOf("free-1");
    expect(free).toMatchObject({ plan: "free" });
    expect(usageHeaderCopy(free.plan, free.pooled)).not.toContain(ROUND_UP_NOTE);
    // The page header renders exactly this text.
    expect(read("src/components/settings/BillingClient.tsx")).toMatch(/\{usageHeaderCopy\(u\?\.metered \? u\.plan : undefined, u\?\.pooled\)\}/);
  });

  it("the round-up is true: a Pro call at half a minute left runs its one reserved minute and ends at most half a minute over", async () => {
    const { beginCall, endCall, heartbeat } = await import("@/lib/usage");
    await usageOf("pro-1");
    const allowance = mocks.fake.rows("usageAllowance").find((a) => a.userId === "pro-1")!;
    allowance.minutesUsed = (allowance.minutesCap as number) - 0.5;
    const t0 = new Date();
    const begun = await beginCall("pro-1", { id: "quote-follow-up" }, t0);
    if (!begun.ok) throw new Error(begun.error);
    await heartbeat("pro-1", begun.callId, "connected", t0);
    await endCall("pro-1", begun.callId, "user_hangup", new Date(t0.getTime() + 20_000)); // 20 seconds counts as a whole minute
    expect(allowance.minutesUsed).toBe((allowance.minutesCap as number) + 0.5);
  });

  it("has no dashes", () => expect(ROUND_UP_NOTE).not.toMatch(DASH));
});

// ---- 5. Focus rings -----------------------------------------------------------------------------------

describe("5. focus rings on the billing controls", () => {
  const page = read("src/components/settings/BillingClient.tsx");
  const css = read("src/app/globals.css");

  /** The RGB triplets of one token block in globals.css. */
  function tokens(block: RegExp): Record<string, [number, number, number]> {
    const body = css.match(block)?.[1] ?? "";
    return Object.fromEntries([...body.matchAll(/--([a-z-]+):\s*(\d+) (\d+) (\d+);/g)].map((m) => [m[1], [Number(m[2]), Number(m[3]), Number(m[4])] as [number, number, number]]));
  }
  const luminance = ([r, g, b]: [number, number, number]) => {
    const lin = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const light = tokens(/:root \{([^}]*)\}/);
  const dark = tokens(/\.deck,\s*:root\[data-theme="dark"\] \{([^}]*)\}/);

  it("the ring color (primary) is at least 3:1 against every surface it sits on, in light and dark", () => {
    for (const [name, set] of [["light", light], ["dark", dark]] as const) {
      expect(set.primary, name).toBeDefined();
      for (const surface of ["bg", "surface", "sunken", "primary-soft"]) {
        expect(set[surface], `${name} ${surface}`).toBeDefined();
        expect(contrast(set.primary, set[surface]), `${name}: primary on ${surface}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("the billing period radio is hidden, so its chip draws the ring when the radio has keyboard focus", () => {
    expect(page).toMatch(/<input type="radio" name="interval" className="sr-only"/);
    const chip = page.split("\n").find((l) => l.includes("chip cursor-pointer"))!;
    for (const cls of ["has-[:focus-visible]:outline", "has-[:focus-visible]:outline-2", "has-[:focus-visible]:outline-offset-2", "has-[:focus-visible]:outline-primary"]) expect(chip).toContain(cls);
  });

  it("the Premium Voice checkbox keeps the global focus ring: nothing removes its outline", () => {
    expect(css).toMatch(/:focus-visible \{ @apply outline-2 outline-offset-2 outline-primary; \}/);
    const box = page.split("\n").find((l) => l.includes('type="checkbox"'))!;
    expect(box).not.toMatch(/outline-(none|0)|appearance-none|sr-only/);
  });

  it("the seats field has an explicit 2px primary outline, because .input drops the outline and keeps only a border change", () => {
    expect(css).toMatch(/\.input \{[^}]*focus:outline-none/);
    const out = renderToStaticMarkup(createElement(SeatsField, { value: "3", note: null, onChange: () => {}, onBlur: () => {} }));
    const cls = out.match(/<input[^>]*class="([^"]*)"/)![1];
    for (const c of ["focus-visible:outline", "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-primary"]) expect(cls).toContain(c);
  });

  it("Tailwind really generates those focus styles (the has() variant is supported)", async () => {
    const classes = [
      ...(page.match(/has-\[:focus-visible\]:[a-z0-9-]+/g) ?? []),
      "focus-visible:outline", "focus-visible:outline-2", "focus-visible:outline-offset-2", "focus-visible:outline-primary",
    ].join(" ");
    const config = { ...(tailwindConfig as object), content: [{ raw: classes, extension: "html" }] };
    const out = await postcss([tailwind(config as never)]).process("@tailwind utilities;", { from: undefined });
    expect(out.css).toMatch(/:has\(:focus-visible\)/);
    expect(out.css).toMatch(/\.focus-visible\\:outline-primary:focus-visible/);
    expect(out.css).toMatch(/outline-width:\s*2px/);
  });
});
