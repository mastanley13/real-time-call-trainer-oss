import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// #63 Triage (B2, B3) and Prism (findings 1 to 6) regressions. Only the database and the session check are replaced; the
// OpenAI endpoint is a stubbed fetch. Nothing reaches Stripe or OpenAI.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall } from "@/lib/usage";
import {
  PREMIUM_NEEDS_GRADED_CALL, TRIAL_CALL_NOTICE, VOICE_CHOICE_KEY, callLengthLabel, liveCallLimitNotice, premiumCallLimitMinutes, premiumCallLimitNotice,
  premiumChoiceAvailable, premiumSetupState, readVoiceChoice, voiceOfListEntry, type PremiumSnapshot,
} from "@/lib/billingUi";
import { PREMIUM_CALL_LENGTH_NOTE } from "@/lib/pricing";
import PremiumVoiceControl, { PREMIUM_AFTER_TRIAL, nextSeatsText, type PremiumControlUsage } from "@/components/settings/PremiumVoiceControl";
import { VoiceChoiceField } from "@/components/call/Briefing";
import { liveVoiceNotice } from "@/components/call/Deck";
import { voiceInfoFrom } from "@/components/call/RealtimeVoiceSession";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { GET as usageRoute } from "@/app/api/usage/route";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { GET as listTranscripts } from "@/app/api/transcripts/route";
import { GET as elevenLabsToken } from "@/app/api/elevenlabs/token/route";

const ROOT = process.cwd();
const src = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
const MODEL_ID = /gpt-|model-premium-test|model-standard-test|realtimeModel|"model"/;
const FAR = new Date("2030-01-01T00:00:00Z");
const MAR10 = new Date("2026-03-10T12:00:00Z");

let fake: ReturnType<typeof createFakePrisma>;
let models: string[];

const addOrg = (id: string, extra: Record<string, unknown> = {}) => fake.seed("organization", { id, code: `c-${id}`, createdAt: MAR10, ...extra });
const addUser = (id: string, organizationId: string | null, extra: Record<string, unknown> = {}) =>
  fake.seed("user", { id, email: `${id}@example.test`, organizationId, usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
const proPremium = (extra: Record<string, unknown> = {}) => ({
  planTier: "pro", premiumVoice: true, premiumVoiceQuantity: 1, stripeSubscriptionId: "sub_test_pro", stripeCustomerId: "cus_test_pro",
  subscriptionStatus: "active", subscriptionPeriodEnd: FAR, ...extra,
});
const gradedCall = (userId: string, organizationId: string | null, overallScore: number | null = 72) =>
  fake.seed("trainerSession", { userId, organizationId, scenarioId: "quote-follow-up", transcript: [{ role: "user", text: "Hi" }], overallScore, grade: overallScore == null ? null : "C" });
const usage = async (id = "u-1") => {
  mocks.authId = id;
  const res = await usageRoute(new NextRequest("http://localhost/api/usage"));
  return (await res.json()) as { premiumVoice: Record<string, unknown>; billing: Record<string, unknown> };
};
const mint = async (userId: string, body: Record<string, unknown> = {}) => {
  mocks.authId = userId;
  const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0], ...body }), headers: { "content-type": "application/json" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const session = (id: string) => fake.rows("trainerSession").find((s) => s.id === id)!;
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;

let shift = 0;
beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  // Each test on its own clock window, so the in-memory per-IP and per-user mint limits never carry over.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(Date.parse("2026-10-15T12:00:00Z") + ++shift * 2 * 3_600_000));
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("JWT_SECRET", "test-only-not-a-secret-0123456789abcdef");
  vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
  vi.stubEnv("PREMIUM_TRIAL_SAMPLE_ON", "");
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  vi.stubEnv("REALTIME_MODEL", "");
  vi.stubEnv("REALTIME_MODEL_PREMIUM", "model-premium-test");
  vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
  models = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    models.push(JSON.parse(init.body as string).session.model);
    return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
  }));
  addOrg("org-1");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- B2: paid Premium is active-only ------------------------------------------------------------------------------

describe("B2: a Stripe trial gets the base plan but no paid Premium", () => {
  it("/api/usage for a trialing Pro with the add-on: premium not enabled, nothing to buy", async () => {
    addUser("u-1", "org-1", proPremium({ subscriptionStatus: "trialing" }));
    gradedCall("u-1", "org-1");
    const u = await usage();
    expect(u.premiumVoice).toMatchObject({ enabled: false, minutesCap: 0, canBuy: false, canManage: true });
    expect(u.billing).toMatchObject({ status: "trialing" });
    // The same account once active: enabled, and (with a graded call) able to buy more seats or manage it.
    fake.rows("user")[0].subscriptionStatus = "active";
    expect((await usage()).premiumVoice).toMatchObject({ enabled: true, minutesCap: 40 });
  });

  it("billing control: a trialing plan sees the after-trial line and no Add button", () => {
    const html = renderToStaticMarkup(createElement(PremiumVoiceControl, {
      usage: { metered: true, plan: "pro", premiumVoice: { enabled: false, configured: false, canBuy: false, canManage: true, offerReady: true, minutesCap: 0, remaining: 0 }, billing: { enabled: true, hasSubscription: true, seats: 1, status: "trialing" } },
      onSale: true,
    }));
    expect(html).toContain(PREMIUM_AFTER_TRIAL);
    expect(html).not.toContain(">Add Premium voice<");
  });
});

// ---- B3: the first graded call, organization-wide, server-side ----------------------------------------------------

describe("B3: Premium is offered only after the organization's first graded call", () => {
  it("first registered, no calls: offerReady false and canBuy false; removal and seats stay manageable", async () => {
    addUser("u-1", "org-1", proPremium({ premiumVoice: false, premiumVoiceQuantity: 0 }));
    const u = await usage();
    expect(u.premiumVoice).toMatchObject({ offerReady: false, canBuy: false, canManage: true });
  });

  it("an ungraded session is not enough", async () => {
    addUser("u-1", "org-1", proPremium({ premiumVoice: false, premiumVoiceQuantity: 0 }));
    gradedCall("u-1", "org-1", null);
    expect((await usage()).premiumVoice).toMatchObject({ offerReady: false, canBuy: false });
  });

  it("another member's graded call counts for the whole organization", async () => {
    addUser("u-1", "org-1", proPremium({ premiumVoice: false, premiumVoiceQuantity: 0 }));
    addUser("rep-2", "org-1");
    gradedCall("rep-2", "org-1");
    expect((await usage()).premiumVoice).toMatchObject({ offerReady: true, canBuy: true });
  });

  it("the premiumVoice answer is an exact allowlist of neutral fields: no counts, no session data, no model", async () => {
    addUser("u-1", "org-1", proPremium());
    gradedCall("u-1", "org-1");
    const u = await usage();
    expect(Object.keys(u.premiumVoice).sort()).toEqual(["canBuy", "canManage", "comped", "configured", "enabled", "minutesCap", "minutesUsed", "offerReady", "onSale", "remaining", "removeAt", "units"]);
    expect(JSON.stringify(u)).not.toMatch(MODEL_ID);
  });

  it("billing control before the first graded call: the neutral line, no price, no Add button; removal still offered", () => {
    const base = { metered: true, plan: "pro" as const, billing: { enabled: true, hasSubscription: true, seats: 1, status: "active" } };
    const offer = renderToStaticMarkup(createElement(PremiumVoiceControl, { usage: { ...base, premiumVoice: { enabled: false, configured: false, canBuy: false, canManage: true, offerReady: false } }, onSale: true }));
    expect(offer).toContain(PREMIUM_NEEDS_GRADED_CALL);
    expect(offer).not.toContain(">Add Premium voice<");
    expect(offer).not.toContain("+$20");
    const owned = renderToStaticMarkup(createElement(PremiumVoiceControl, { usage: { ...base, premiumVoice: { enabled: true, configured: true, canBuy: false, canManage: true, offerReady: false, minutesCap: 40, remaining: 30 } }, onSale: true }));
    expect(owned).toContain("Remove at period end");
  });

  it("call setup: nothing is offered before the first graded call, even to a buyer", () => {
    const snap: PremiumSnapshot = { enabled: false, remaining: 0, cap: 0, plan: "pro", onSale: true, canBuy: false, offerReady: false, comped: false, removeAt: null };
    expect(premiumSetupState(snap).kind).toBe("none");
    expect(premiumSetupState({ ...snap, offerReady: true, canBuy: true }).kind).toBe("locked_buy");
  });
});

// ---- Prism 1: Standard or Premium for this call -------------------------------------------------------------------

describe("Prism 1: the rep may choose Standard or Premium; the server rechecks", () => {
  const snap = (p: Partial<PremiumSnapshot>): PremiumSnapshot => ({ enabled: true, remaining: 30, cap: 40, plan: "pro", onSale: true, canBuy: true, offerReady: true, comped: false, removeAt: null, ...p });

  it("offered only when Premium can run now; Premium is the default and a stored pick is kept", () => {
    expect(premiumChoiceAvailable(snap({}))).toBe(true);
    expect(premiumChoiceAvailable(snap({ remaining: 0 }))).toBe(false);
    expect(premiumChoiceAvailable(snap({ enabled: false }))).toBe(false);
    expect(premiumChoiceAvailable(snap({ enabled: false, comped: true }))).toBe(true);
    expect(premiumChoiceAvailable(null)).toBe(false);
    expect(readVoiceChoice(null)).toBe("premium");
    expect(readVoiceChoice("standard")).toBe("standard");
    expect(readVoiceChoice("gpt-whatever")).toBe("premium");
    expect(VOICE_CHOICE_KEY).toBe("rtct.voiceTier");
  });

  /** The attributes of one start tag, whatever order React renders them in. Boolean attributes map to "". */
  const attrsOf = (tag: string): Record<string, string> =>
    Object.fromEntries([...tag.replace(/^<\w+/, "").matchAll(/([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]));
  /** Each <label> of the field with the one radio it wraps and its visible text. */
  const radiosOf = (html: string) => (html.match(/<label\b[^>]*>[\s\S]*?<\/label>/g) ?? []).map((label) => {
    const inputs = label.match(/<input\b[^>]*>/g) ?? [];
    return { inputs: inputs.length, attrs: attrsOf(inputs[0] ?? "<input>"), text: label.replace(/<[^>]+>/g, " ") };
  });

  it("native fieldset, legend and labeled radios in one group (arrow keys move the selection natively)", () => {
    const render = (value: "premium" | "standard") => renderToStaticMarkup(createElement(VoiceChoiceField, { premium: snap({}), usage: { remaining: 100, cap: 200 }, value, onChange: () => {} }));
    const html = render("premium");
    // A fieldset whose first child is its legend, with every label (and so every radio) inside it.
    expect(html).toMatch(/^<fieldset\b[^>]*>\s*<legend\b[^>]*>Voice for this call<\/legend>/);
    expect(html.trimEnd().endsWith("</fieldset>")).toBe(true);
    expect((html.match(/<fieldset\b/g) ?? [])).toHaveLength(1);
    const radios = radiosOf(html);
    expect(radios).toHaveLength(2);
    for (const r of radios) {
      // Each label wraps exactly one native radio, so clicking the text selects it and its name is the label text.
      expect(r.inputs).toBe(1);
      expect(r.attrs.type).toBe("radio");
      // One shared name: one group, where arrow keys move the single selection and Tab enters it once.
      expect(r.attrs.name).toBe("voice-choice");
      // Nothing overrides native radio semantics or focus.
      for (const a of ["role", "tabindex", "tabIndex", "disabled", "aria-hidden"]) expect(r.attrs, a).not.toHaveProperty(a);
    }
    expect(radios.map((r) => r.attrs.value)).toEqual(["premium", "standard"]);
    expect(radios[0].text).toContain("Premium voice");
    expect(radios[1].text).toContain("Standard voice");
    expect(radios[1].text).toContain("Saves your Premium minutes");
    // Premium is the default selection: exactly one radio is checked.
    const checked = (h: string) => radiosOf(h).filter((r) => "checked" in r.attrs).map((r) => r.attrs.value);
    expect(checked(html)).toEqual(["premium"]);
    const std = render("standard");
    expect(checked(std)).toEqual(["standard"]);
    expect(html + std).not.toMatch(MODEL_ID);
    // Wired on the setup only when the choice is available, and the pick is sent with the mint request.
    expect(src("src/components/call/Briefing.tsx")).toContain("premiumChoiceAvailable(premium) && onVoiceChoiceChange");
    expect(src("src/components/TrainerClient.tsx")).toContain("setCallTier(premiumChoiceAvailable(premium) ? voiceChoice : undefined);");
    expect(src("src/components/call/RealtimeVoiceSession.tsx")).toContain("...(this.voiceTier ? { voiceTier: this.voiceTier } : {})");
  });

  it("server: an entitled rep who picks Standard gets the Standard model and holds no Premium minutes", async () => {
    addUser("u-1", "org-1", proPremium());
    const r = await mint("u-1", { voiceTier: "standard" });
    expect(r.status).toBe(200);
    expect(models).toEqual(["model-standard-test"]);
    expect(r.body).toMatchObject({ voiceTier: "standard", nextCallStandard: false });
    expect(session(r.body.callId as string)).toMatchObject({ engineTier: "standard", voiceTier: "standard", premiumReservedMinutes: 0, realtimeModel: "model-standard-test" });
    expect(allowanceOf("u-1")).toMatchObject({ premiumMinutesReserved: 0 });
  });

  it("server: Premium requested (or nothing sent) by an entitled rep is Premium; by an unentitled rep it is still Standard", async () => {
    addUser("u-1", "org-1", proPremium());
    addUser("u-2", "org-1", { planTier: "pro", stripeSubscriptionId: "sub_test_other", subscriptionStatus: "active", subscriptionPeriodEnd: FAR });
    expect((await mint("u-1", { voiceTier: "premium" })).body).toMatchObject({ voiceTier: "premium" });
    expect((await mint("u-2", { voiceTier: "premium" })).body).toMatchObject({ voiceTier: "standard" });
    expect(models).toEqual(["model-premium-test", "model-standard-test"]);
    // Anything else in the field is a bad request, never a model pick.
    expect((await mint("u-1", { voiceTier: "gpt-realtime-2.1" })).status).toBe(400);
  });

  it("server: a comped organization's rep who picks Standard runs Standard (the comped override is bypassed for that call)", async () => {
    addOrg("org-c", { voiceModelTier: "premium", voiceModelComped: true });
    // A Pro plan (no add-on), so two calls fit in the minutes; the org fields ride on the user row for the fake.
    addUser("c-1", "org-c", { planTier: "pro", stripeSubscriptionId: "sub_test_c", subscriptionStatus: "active", subscriptionPeriodEnd: FAR, organization: { voiceModelTier: "premium", voiceModelComped: true } });
    expect((await mint("c-1", { voiceTier: "standard" })).body).toMatchObject({ voiceTier: "standard" });
    expect((await mint("c-1")).body).toMatchObject({ voiceTier: "premium" });
    expect(models).toEqual(["model-standard-test", "model-premium-test"]);
  });

  it("server: picking Standard never consumes a Free organization's trial call", async () => {
    vi.stubEnv("PREMIUM_TRIAL_SAMPLE_ON", "true");
    addOrg("org-free");
    addUser("f-1", "org-free");
    const std = await mint("f-1", { voiceTier: "standard" });
    expect(std.body).toMatchObject({ voiceTier: "standard" });
    expect(std.body).not.toHaveProperty("voiceTrial");
    expect(fake.rows("organization").find((o) => o.id === "org-free")!.premiumTrialCallUsedAt).toBeNull();
    // The claim stays available for a call that asks for it (another member; f-1's open call holds f-1's Free minutes).
    addUser("f-2", "org-free");
    const r = await beginCall("f-2", { id: "quote-follow-up" }, new Date(Date.now() + 1000), { offerTrialSample: true, preferStandard: false });
    if (!r.ok) throw new Error(r.error);
    expect(r.premium.source).toBe("trial");
  });
});

// ---- Prism 1 follow-up (Codex P2): an explicit Standard request on unmetered installs -----------------------------

describe("an explicit Standard request is honored with or without metering (Codex P2)", () => {
  let agentUrls: string[];
  const token = async (query: Record<string, string> = {}) => {
    mocks.authId = "u-1";
    const res = await elevenLabsToken(new NextRequest(`http://localhost/api/elevenlabs/token?${new URLSearchParams({ scenarioId: "quote-follow-up", ...query })}`));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
  beforeEach(() => {
    agentUrls = [];
    vi.stubEnv("ELEVENLABS_API_KEY", "el-test-not-real");
    vi.stubEnv("ELEVENLABS_AGENT_ID", "agent_test_main");
    vi.stubEnv("ELEVENLABS_AGENT_ID_STANDARD", "agent_test_std");
    // ElevenLabs is a mocked fetch; nothing leaves the process.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      agentUrls.push(new URL(url).searchParams.get("agent_id") ?? "");
      return new Response(JSON.stringify({ token: "tok_test" }), { status: 200 });
    }));
    addUser("u-1", "org-1", proPremium());
  });
  const unmetered = () => { vi.stubEnv("STRIPE_SECRET_KEY", ""); vi.stubEnv("USAGE_CAPS", ""); };

  it("unmetered ElevenLabs, Standard agent configured: voiceTier=standard mints on the Standard agent", async () => {
    unmetered();
    const r = await token({ voiceTier: "standard" });
    expect(r.status).toBe(200);
    expect(agentUrls).toEqual(["agent_test_std"]);
    // Unmetered answers keep their shape: the token only, no call id, no agent id.
    expect(r.body).toEqual({ token: "tok_test" });
    expect(fake.rows("trainerSession")).toHaveLength(0);
  });

  it("unmetered ElevenLabs, no Standard agent: voiceTier=standard is refused, never minted on the Premium agent", async () => {
    unmetered();
    vi.stubEnv("ELEVENLABS_AGENT_ID_STANDARD", "");
    const r = await token({ voiceTier: "standard" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("standard_voice_not_configured");
    expect(agentUrls).toEqual([]);
  });

  it("unmetered ElevenLabs without a choice is unchanged: the main agent", async () => {
    unmetered();
    expect((await token()).status).toBe(200);
    expect((await token({ voiceTier: "premium" })).status).toBe(200);
    expect(agentUrls).toEqual(["agent_test_main", "agent_test_main"]);
  });

  it("metered ElevenLabs: Standard picked by an entitled rep runs the Standard agent with no Premium minutes held", async () => {
    const r = await token({ voiceTier: "standard" });
    expect(r.status).toBe(200);
    expect(agentUrls).toEqual(["agent_test_std"]);
    expect(r.body).toMatchObject({ voiceTier: "standard", nextCallStandard: false });
    expect(session(r.body.callId as string)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0 });
    // Without a choice the entitled rep still gets Premium (the main agent), as before.
    expect((await token()).body).toMatchObject({ voiceTier: "premium" });
    expect(agentUrls).toEqual(["agent_test_std", "agent_test_main"]);
  });

  it("metered ElevenLabs, no Standard agent: voiceTier=standard is refused before any reservation", async () => {
    vi.stubEnv("ELEVENLABS_AGENT_ID_STANDARD", "");
    const r = await token({ voiceTier: "standard" });
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("standard_voice_not_configured");
    expect(fake.rows("trainerSession")).toHaveLength(0);
    expect(agentUrls).toEqual([]);
  });

  it("unmetered OpenAI Realtime: voiceTier=standard runs the Standard model even for a comped Premium organization", async () => {
    unmetered();
    addOrg("org-c", { voiceModelTier: "premium", voiceModelComped: true });
    addUser("c-1", "org-c", { organization: { voiceModelTier: "premium", voiceModelComped: true } });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(init.body as string).session.model);
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
    }));
    const std = await mint("c-1", { voiceTier: "standard" });
    expect(std.status).toBe(200);
    expect(std.body.callId).toBeUndefined();
    const def = await mint("c-1");
    expect(def.status).toBe(200);
    expect(models).toEqual(["model-standard-test", "model-premium-test"]);
  });
});

// ---- Prism 2: when Premium is what ends THIS call --------------------------------------------------------------------

describe("Prism 2: the setup and the live call say when THIS call ends", () => {
  it("2 Premium minutes left against a planned 5: this call ends after 2 minutes; enough Premium says nothing", () => {
    expect(premiumCallLimitMinutes(2, 5)).toBe(2);
    expect(premiumCallLimitMinutes(40, 5)).toBeNull();
    expect(premiumCallLimitMinutes(5, 5)).toBeNull();
    expect(premiumCallLimitMinutes(0, 5)).toBeNull();
    // Never more than one reservation (60 minutes) is planned.
    expect(premiumCallLimitMinutes(45, 200)).toBe(45);
    expect(premiumCallLimitMinutes(59, 1000)).toBe(59);
    expect(premiumCallLimitNotice(2)).toBe("This Premium call ends after 2 minutes, when your Premium minutes run out. Your next call uses Standard voice.");
    expect(premiumCallLimitNotice(1)).toContain("after 1 minute,");
  });

  it("the setup shows it (polite live region) for Premium, and not when Standard is picked", () => {
    const premium: PremiumSnapshot = { enabled: true, remaining: 2, cap: 40, plan: "pro", onSale: true, canBuy: true, offerReady: true, comped: false, removeAt: null };
    const on = renderToStaticMarkup(createElement(VoiceChoiceField, { premium, usage: { remaining: 5, cap: 200 }, value: "premium", onChange: () => {} }));
    // The notice is the text of a polite status region (attributes checked in any order).
    const region = on.match(/<p\b[^>]*>This Premium call ends after 2 minutes[^<]*<\/p>/);
    expect(region).not.toBeNull();
    const attrs = Object.fromEntries([...region![0].match(/^<p\b[^>]*>/)![0].replace(/^<p/, "").matchAll(/([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]));
    expect(attrs).toMatchObject({ role: "status", "aria-live": "polite" });
    const off = renderToStaticMarkup(createElement(VoiceChoiceField, { premium, usage: { remaining: 5, cap: 200 }, value: "standard", onChange: () => {} }));
    expect(off).not.toContain("ends after");
  });

  it("live: the notice uses the server's deadline for this call; Standard has no Premium cutoff; the trial keeps its own", () => {
    expect(liveVoiceNotice({ tier: "premium", nextCallStandard: true, maxSeconds: 120 })).toBe(liveCallLimitNotice(120));
    expect(liveCallLimitNotice(120)).toBe("This call ends after 2 minutes, when your Premium minutes run out. Your next call uses Standard voice.");
    expect(callLengthLabel(90)).toBe("1 minute 30 seconds");
    expect(callLengthLabel(45)).toBe("45 seconds");
    expect(liveVoiceNotice({ tier: "standard", nextCallStandard: false, maxSeconds: 600 })).toBe("");
    expect(liveVoiceNotice({ tier: "premium", nextCallStandard: false, maxSeconds: 3600 })).toBe("");
    expect(liveVoiceNotice({ tier: "premium", trial: true, nextCallStandard: true, maxSeconds: 300 })).toBe(TRIAL_CALL_NOTICE);
  });

  it("end to end: 38 of 40 Premium minutes used, the mint answers a 2 minute deadline and the live notice says so", async () => {
    addUser("u-1", "org-1", proPremium());
    await mint("u-1", { voiceTier: "standard" }); // creates the allowance
    const a = allowanceOf("u-1");
    a.premiumMinutesUsed = 38;
    a.minutesReserved = 0;
    const r = await mint("u-1", { voiceTier: "premium" });
    expect(r.body).toMatchObject({ voiceTier: "premium", maxSeconds: 120, nextCallStandard: true });
    const info = voiceInfoFrom(r.body)!;
    expect(liveVoiceNotice(info)).toBe("This call ends after 2 minutes, when your Premium minutes run out. Your next call uses Standard voice.");
  });

  it("the generic copy keeps a cap-specific line below it on setup, billing and checkout", () => {
    expect(PREMIUM_CALL_LENGTH_NOTE).toMatch(/never switches voices/);
    for (const f of ["src/components/call/PremiumMinutes.tsx", "src/components/settings/PremiumVoiceControl.tsx", "src/components/CheckoutStartClient.tsx", "src/components/settings/BillingClient.tsx"]) {
      expect(src(f), f).toContain("PREMIUM_CALL_LENGTH_NOTE");
    }
  });
});

// ---- Prism 4: the Logbook shows the voice used ---------------------------------------------------------------------

describe("Prism 4: history entries carry a neutral voice label, never a model", () => {
  it("GET /api/transcripts: an exact allowlist per entry, voiceUsed from the stored tier only, legacy rows null", async () => {
    addUser("u-1", "org-1");
    const row = (id: string, voiceTier: string | null, createdAt: string) => fake.seed("trainerSession", {
      id, userId: "u-1", organizationId: "org-1", scenarioId: "quote-follow-up", scenarioTitle: "Quote follow-up", transcript: [{ role: "user", text: "Hi" }],
      overallScore: 70, grade: "C", voiceTier, realtimeModel: voiceTier ? `model-${voiceTier}-test` : null, engineTier: voiceTier === "premium" ? "premium" : "standard",
      allowanceId: voiceTier ? "a-1" : null, evaluation: { method: "llm", graderVersion: "llm-v2", model: "gpt-4.1-mini" }, createdAt: new Date(createdAt),
    });
    row("s-prem-0001", "premium", "2026-11-03T10:00:00Z");
    row("s-std-00001", "standard", "2026-11-02T10:00:00Z");
    // A legacy metered row with no stored tier: no label, never guessed from the engine or the model.
    row("s-old-00001", null, "2026-11-01T10:00:00Z");
    fake.rows("trainerSession")[2].engineTier = "premium";
    fake.rows("trainerSession")[2].realtimeModel = "model-premium-test";
    const res = await listTranscripts(new NextRequest("http://localhost/api/transcripts"));
    const text = await res.text();
    const { sessions } = JSON.parse(text) as { sessions: Record<string, unknown>[] };
    expect(sessions.map((s) => s.voiceUsed)).toEqual(["premium", "standard", null]);
    for (const s of sessions) {
      expect(Object.keys(s).sort()).toEqual(["createdAt", "durationSeconds", "goalAchieved", "grade", "graderMethod", "graderVersion", "id", "overallScore", "scenarioCategory", "scenarioId", "scenarioTitle", "voiceUsed"]);
    }
    expect(text).not.toMatch(MODEL_ID);
    expect(text).not.toMatch(/engineTier|allowanceId|voiceTier|receipt/);
  });

  it("the Logbook renders Premium voice or Standard voice from that label, and nothing for unknown", () => {
    expect(voiceOfListEntry("premium")).toBe("premium");
    expect(voiceOfListEntry("standard")).toBe("standard");
    for (const v of [null, undefined, "gpt-realtime-2.1", "PREMIUM", 1]) expect(voiceOfListEntry(v)).toBeNull();
    const page = src("src/app/dashboard/page.tsx");
    expect(page).toContain("voice: voiceOfListEntry(s.voiceUsed)");
    expect(page).toContain("{r.voice ? ` · ${voiceLabel(r.voice)}` : \"\"}");
    // Calls kept only in this browser have no server label.
    expect(page).toContain("voice: null,");
  });
});

// ---- Prism 5 and 6: billing review focus and the seat stepper -----------------------------------------------------

describe("Prism 5 and 6: billing review focus and the seat stepper", () => {
  const team = (billing: PremiumControlUsage["billing"] = {}): PremiumControlUsage => ({
    metered: true, plan: "team", premiumVoice: { enabled: true, configured: true, canBuy: true, canManage: true, offerReady: true, minutesCap: 120, remaining: 100 },
    billing: { enabled: true, hasSubscription: true, seats: 3, renewsAt: "2026-12-05T00:00:00Z", ...billing },
  });

  it("5: Back from each review returns focus to the control that opened it (ref and effect, not the page body)", () => {
    const c = src("src/components/settings/PremiumVoiceControl.tsx");
    expect(c).toContain('onBack={() => { setPreview(null); setReturnFocus("add"); }}');
    expect(c).toContain('onBack={() => { setConfirmRemove(false); setReturnFocus("remove"); }}');
    expect(c).toContain('onBack={() => { setSeatPreview(null); setReturnFocus("seats"); }}');
    expect(c).toMatch(/<button ref=\{addRef\}[^>]*onClick=\{previewAdd\}/);
    expect(c).toMatch(/<button ref=\{removeRef\}/);
    expect(c).toMatch(/<button ref=\{seatsRef\}/);
    expect(c).toContain("({ add: addRef, remove: removeRef, seats: seatsRef })[returnFocus].current?.focus();");
  });

  it("6: the stepper's value is the current seat count (not a placeholder), so ArrowUp on 3 gives 4", () => {
    const html = renderToStaticMarkup(createElement(PremiumVoiceControl, { usage: team(), onSale: true }));
    const tag = html.match(/<input\b[^>]*\bid="premium-seats"[^>]*>/)![0];
    const input = Object.fromEntries([...tag.replace(/^<input/, "").matchAll(/([A-Za-z_:][\w:.-]*)(?:="([^"]*)")?/g)].map((m) => [m[1], m[2] ?? ""]));
    expect(input).toMatchObject({ value: "3", type: "number", min: "3" });
    expect(input).not.toHaveProperty("placeholder");
  });

  it("6: a refetch never wipes what the owner typed; untouched, it follows the server", () => {
    expect(nextSeatsText({ text: "", edited: false }, 3)).toEqual({ text: "3", edited: false });
    expect(nextSeatsText({ text: "3", edited: false }, 5)).toEqual({ text: "5", edited: false });
    expect(nextSeatsText({ text: "7", edited: true }, 5)).toEqual({ text: "7", edited: true });
  });
});
