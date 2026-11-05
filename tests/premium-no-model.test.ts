import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Only the database and the session check are replaced. OpenAI is a stubbed fetch; nothing leaves the process.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));

import { readMintReceipt, signMintReceipt } from "@/lib/mintReceipt";
import { PREMIUM_REALTIME_MODEL, STANDARD_REALTIME_MODEL } from "@/lib/voiceModels";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { GET as usageGET } from "@/app/api/usage/route";
import { POST as saveTranscript, GET as listTranscripts } from "@/app/api/transcripts/route";
import { GET as getTranscript } from "@/app/api/transcripts/[id]/route";
import { GET as configGET } from "@/app/api/config/route";

/** Same patterns as tests/no-model-labels.test.ts. */
const MODEL_ID_PATTERNS = [
  /gpt-4\.1[\w.-]*/i, /GPT 4\.1/i, /gpt-4o[\w.-]*/i, /gpt-5[\w.-]*/i, /gpt-realtime[\w.-]*/i,
  /\bo[34](?:-[a-z0-9]+)*\b/, /whisper-1/i, /tts-1[\w.-]*/i, /gemini-[\w.-]+/i, /eleven_[a-z0-9_]+/i, /claude-[a-z0-9.-]+/i,
];
const hasModelId = (text: string) => MODEL_ID_PATTERNS.some((re) => re.test(text));
const ROOT = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|mjs|json|md)$/.test(name) ? [full] : [];
});

describe("model ids stay in the narrow server-only baseline", () => {
  it("only voiceModels.ts maps voice tiers to Realtime model ids; the only other ids are the existing backend defaults", () => {
    const withIds = walk(path.join(ROOT, "src")).filter((f) => hasModelId(readFileSync(f, "utf8"))).map(rel).sort();
    // Baseline, not widened by this change: the tier map, plus the existing LLM and transcription defaults.
    expect(withIds).toEqual(["src/lib/realtime.ts", "src/lib/serverConfig.ts", "src/lib/voiceModels.ts"]);
    const realtimeIds = walk(path.join(ROOT, "src")).filter((f) => /gpt-realtime/i.test(readFileSync(f, "utf8"))).map(rel);
    expect(realtimeIds).toEqual(["src/lib/voiceModels.ts"]);
    expect(readFileSync(path.join(ROOT, "src/lib/voiceModels.ts"), "utf8")).toMatch(/^import "server-only";/);
  });

  it("no Premium Voice module, route or screen holds a model id, comments included", () => {
    const files = [
      "src/lib/premiumVoice.ts", "src/lib/premiumAddon.ts", "src/lib/premiumEventTypes.ts", "src/lib/billingEvents.ts", "src/lib/mintReceipt.ts",
      "src/lib/billing.ts", "src/lib/usage.ts", "src/lib/usagePlan.ts", "src/lib/pricing.ts", "src/lib/billingUi.ts", "src/lib/checkoutStart.ts",
      "src/app/api/billing/premium/route.ts", "src/app/api/billing/seats/route.ts", "src/app/api/billing/_lib/addonRoute.ts",
      "src/app/api/billing/checkout/route.ts", "src/app/api/usage/route.ts", "src/app/api/realtime/session/route.ts", "src/app/api/elevenlabs/token/route.ts",
      "src/app/api/transcripts/route.ts", "src/app/api/transcripts/[id]/route.ts", "src/app/api/stripe/webhook/route.ts",
      "src/components/call/PremiumMinutes.tsx", "src/components/settings/PremiumVoiceControl.tsx", "src/components/settings/BillingClient.tsx",
      "src/components/CheckoutStartClient.tsx", "src/components/call/Deck.tsx", "src/components/landing/PricingCards.tsx",
    ];
    const offenders = files.filter((f) => hasModelId(readFileSync(path.join(ROOT, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("mint receipts carry no readable model data (decode regression)", () => {
  const KEY = "test-only-not-a-secret-0123456789abcdef";
  const decodeAll = (receipt: string): string[] => {
    const parts = receipt.split(".");
    // Every way a client might try to read it: each dot-separated part, base64url and plain, and the whole thing.
    return [receipt, ...parts, ...parts.map((p) => Buffer.from(p, "base64url").toString("utf8")), ...parts.map((p) => Buffer.from(p, "base64").toString("latin1"))];
  };

  it.each([PREMIUM_REALTIME_MODEL, STANDARD_REALTIME_MODEL, "custom-voice-model-x"])("no trace of %s, the tier or the call id in any decoding", (model) => {
    const r = signMintReceipt("u-1", model, Date.now(), KEY, { tier: "premium", callId: "call-abc123" })!;
    for (const view of decodeAll(r)) {
      expect(view).not.toContain(model);
      expect(hasModelId(view)).toBe(false);
      expect(view).not.toMatch(/premium|standard|call-abc123|"m"|"t":/);
      expect(() => JSON.parse(view)).toThrow();
    }
    // The server can still open it: provenance is kept server-side.
    expect(readMintReceipt(r, "u-1", Date.now(), KEY)).toEqual({ model, tier: "premium", callId: "call-abc123" });
  });

  it("two receipts for the same call differ, so nothing can be learned by comparing them", () => {
    const a = signMintReceipt("u-1", PREMIUM_REALTIME_MODEL, 1_900_000_000_000, KEY, { tier: "premium", callId: "c-1" });
    const b = signMintReceipt("u-1", PREMIUM_REALTIME_MODEL, 1_900_000_000_000, KEY, { tier: "premium", callId: "c-1" });
    expect(a).not.toBe(b);
  });
});

describe("browser-facing answers on the Premium path carry no model data", () => {
  let fake: ReturnType<typeof createFakePrisma>;
  const MAR10 = new Date("2026-03-10T12:00:00Z");
  beforeEach(() => {
    fake = createFakePrisma();
    mocks.fake = fake;
    mocks.authId = "u-1";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
    for (const [k, v] of Object.entries({
      DATABASE_URL: "postgresql://ci:ci@localhost:5432/ci", STRIPE_SECRET_KEY: "sk_test_placeholder", DEMO_MODE: "", PREMIUM_VOICE_ON_SALE: "true",
      JWT_SECRET: "test-only-not-a-secret-0123456789abcdef", OPENAI_API_KEY: "sk-test-not-real", REALTIME_MODEL: "", REALTIME_MODEL_PREMIUM: "", REALTIME_MODEL_STANDARD: "",
    })) vi.stubEnv(k, v);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 })));
    fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
    fake.seed("user", {
      id: "u-1", email: "u-1@example.test", organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10,
      planTier: "pro", premiumVoice: true, premiumVoiceQuantity: 1, stripeSubscriptionId: "sub_test_pro", subscriptionStatus: "active",
      subscriptionPeriodEnd: new Date("2027-06-01T00:00:00Z"),
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it("mint, usage, save, list and the debrief read: tier labels only, and the model stays server-side", async () => {
    const mintRes = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const mintText = await mintRes.text();
    const minted = JSON.parse(mintText);
    expect(minted.voiceTier).toBe("premium");
    expect(hasModelId(mintText)).toBe(false);
    for (const view of String(minted.receipt).split(".").map((p) => Buffer.from(p, "base64url").toString("utf8"))) expect(hasModelId(view)).toBe(false);
    // Provenance is kept on the server row.
    expect(fake.rows("trainerSession")[0]).toMatchObject({ realtimeModel: PREMIUM_REALTIME_MODEL, engineTier: "premium" });

    const texts: string[] = [mintText];
    texts.push(await (await usageGET(new NextRequest("http://localhost/api/usage"))).text());
    const saved = await saveTranscript(new NextRequest("http://localhost/api/transcripts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "s-1", callId: minted.callId, transcript: [{ role: "user", text: "Hi" }], scenario: { id: BUILT_IN_SCENARIOS[0].id }, realtimeReceipt: minted.receipt }),
    }));
    texts.push(await saved.text());
    // The list reads with an explicit select that leaves the model out (the in-memory fake ignores `select`, so the
    // select itself is what is checked here).
    const listSrc = readFileSync(path.join(ROOT, "src/app/api/transcripts/route.ts"), "utf8");
    const listSelect = listSrc.slice(listSrc.indexOf("export async function GET"));
    expect(listSelect).toMatch(/select: \{[^}]*\}/);
    expect(listSelect.match(/select: \{[^}]*\}/)![0]).not.toMatch(/realtimeModel|engineTier/);
    expect(typeof listTranscripts).toBe("function");
    const one = await getTranscript(new NextRequest(`http://localhost/api/transcripts/${minted.callId}`), { params: Promise.resolve({ id: minted.callId }) });
    const oneText = await one.text();
    texts.push(oneText);
    texts.push(await (await configGET()).text());
    for (const t of texts) {
      expect(hasModelId(t), t.slice(0, 200)).toBe(false);
      expect(t).not.toMatch(/realtimeModel|"model"/);
    }
    expect(JSON.parse(oneText).session.voiceUsed).toBe("premium");
  });
});
