import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Only the database and the session check are replaced. OpenAI is a stubbed fetch; nothing leaves the process.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({ requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }), isDemoUser: () => false }));

import { sealMintReceipt, verifyMintReceipt } from "@/lib/mintReceipt";
import { PREMIUM_REALTIME_MODEL, STANDARD_REALTIME_MODEL } from "@/lib/voiceModels";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { GET as usageGET } from "@/app/api/usage/route";
import { POST as saveTranscript, GET as listTranscripts } from "@/app/api/transcripts/route";
import { GET as getTranscript } from "@/app/api/transcripts/[id]/route";
import { GET as getVoice } from "@/app/api/transcripts/[id]/voice/route";
import { GET as configGET } from "@/app/api/config/route";

/**
 * Premium Voice additions to the model-id guard. Same pattern as tests/no-model-labels.test.ts (upstream #61), and never
 * wider than its exact BACKEND_ALLOWLIST: this file adds no exception for any new module, route or screen.
 */
const MODEL_ID_RE =
  /\b(?:[Gg][Pp][Tt]-(?:5|4\.1|4o|realtime)[\w.-]*|o[34](?:-[\w-]+)?|whisper-1|tts-1(?:-hd)?|gemini-[\w.-]+|eleven_\w+|claude-[\w.-]+)\b/;
const UPSTREAM_BACKEND_ALLOWLIST = new Set(["src/lib/serverConfig.ts", "src/lib/realtime.ts", "src/lib/llm.ts", "src/lib/voiceModels.ts"]);
const hasModelId = (text: string) => MODEL_ID_RE.test(text);
const ROOT = path.resolve(__dirname, "..");
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : /\.(tsx?|mjs|json|md)$/.test(name) ? [full] : [];
});

describe("model ids stay in the narrow server-only baseline", () => {
  it("every file with a model id is on upstream's exact backend allowlist, and only voiceModels.ts maps Realtime ids", () => {
    const files = walk(path.join(ROOT, "src"));
    const withIds = files.filter((f) => hasModelId(readFileSync(f, "utf8"))).map(rel);
    for (const f of withIds) expect(UPSTREAM_BACKEND_ALLOWLIST.has(f), f).toBe(true);
    const realtimeIds = files.filter((f) => /gpt-realtime/i.test(readFileSync(f, "utf8"))).map(rel);
    expect(realtimeIds).toEqual(["src/lib/voiceModels.ts"]);
    expect(readFileSync(path.join(ROOT, "src/lib/voiceModels.ts"), "utf8")).toMatch(/^import "server-only";/);
  });

  it("no Premium Voice module, route or screen holds a model id, comments included", () => {
    const files = [
      "src/lib/premiumVoice.ts", "src/lib/premiumAddon.ts", "src/lib/premiumEventTypes.ts", "src/lib/billingEvents.ts", "src/lib/mintReceipt.ts",
      "src/lib/billing.ts", "src/lib/usage.ts", "src/lib/usagePlan.ts", "src/lib/pricing.ts", "src/lib/billingUi.ts", "src/lib/checkoutStart.ts",
      "src/lib/sessionView.ts", "src/lib/voiceTier.ts", "src/lib/voiceTierServer.ts", "src/lib/voiceMintLog.ts",
      "src/app/api/billing/premium/route.ts", "src/app/api/billing/seats/route.ts", "src/app/api/billing/_lib/addonRoute.ts",
      "src/app/api/billing/checkout/route.ts", "src/app/api/usage/route.ts", "src/app/api/realtime/session/route.ts", "src/app/api/elevenlabs/token/route.ts",
      "src/app/api/transcripts/route.ts", "src/app/api/transcripts/[id]/route.ts", "src/app/api/transcripts/[id]/voice/route.ts", "src/app/api/stripe/webhook/route.ts",
      "src/components/call/PremiumMinutes.tsx", "src/components/settings/PremiumVoiceControl.tsx", "src/components/settings/BillingClient.tsx",
      "src/components/CheckoutStartClient.tsx", "src/components/call/Deck.tsx", "src/components/landing/PricingCards.tsx",
      "src/app/trainer/debrief/[sessionId]/page.tsx",
    ];
    expect(files.filter((f) => hasModelId(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
    // Nothing new is allowlisted: none of these is on the backend list.
    expect(files.filter((f) => UPSTREAM_BACKEND_ALLOWLIST.has(f))).toEqual([]);
  });
});

describe("mint receipts carry no readable model data (decode regression)", () => {
  const KEY = "test-only-not-a-secret-0123456789abcdef";
  const CALL = "call-abc12345";
  const decodeAll = (receipt: string): string[] => {
    const parts = receipt.split(".");
    // Every way a client might try to read it: each dot-separated part, base64url and plain, and the whole thing.
    return [receipt, ...parts, ...parts.map((p) => Buffer.from(p, "base64url").toString("utf8")), ...parts.map((p) => Buffer.from(p, "base64").toString("latin1"))];
  };

  it.each([PREMIUM_REALTIME_MODEL, STANDARD_REALTIME_MODEL, "custom-voice-model-x"])("no trace of %s, the user or the call id in any decoding", (model) => {
    const r = sealMintReceipt("u-1", CALL, model, Date.now(), KEY)!;
    for (const view of decodeAll(r)) {
      expect(view).not.toContain(model);
      expect(hasModelId(view)).toBe(false);
      expect(view).not.toMatch(/premium|standard|u-1|call-abc12345|"m"|"t":/);
      expect(() => JSON.parse(view)).toThrow();
    }
    // The server can still open it, for this user and call only: provenance stays server-side.
    expect(verifyMintReceipt(r, "u-1", CALL, Date.now(), KEY)).toBe(model);
    expect(verifyMintReceipt(r, "u-2", CALL, Date.now(), KEY)).toBeNull();
  });

  it("Premium and Standard receipts have the same length, and two receipts for the same call differ", () => {
    const a = sealMintReceipt("u-1", CALL, PREMIUM_REALTIME_MODEL, 1_900_000_000_000, KEY)!;
    const b = sealMintReceipt("u-1", CALL, PREMIUM_REALTIME_MODEL, 1_900_000_000_000, KEY)!;
    const s = sealMintReceipt("u-1", CALL, STANDARD_REALTIME_MODEL, 1_900_000_000_000, KEY)!;
    expect(a).not.toBe(b);
    expect(a.length).toBe(s.length);
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

  it("mint, usage, save, list, the debrief read and its voice label: tier labels only; the model stays server-side", async () => {
    const mintRes = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
    const mintText = await mintRes.text();
    const minted = JSON.parse(mintText);
    expect(minted.voiceTier).toBe("premium");
    expect(hasModelId(mintText)).toBe(false);
    for (const view of String(minted.receipt).split(".").map((p) => Buffer.from(p, "base64url").toString("utf8"))) expect(hasModelId(view)).toBe(false);

    const texts: string[] = [mintText];
    texts.push(await (await usageGET(new NextRequest("http://localhost/api/usage"))).text());
    const saved = await saveTranscript(new NextRequest("http://localhost/api/transcripts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: minted.sessionId, callId: minted.callId, transcript: [{ role: "user", text: "Hi" }], scenario: { id: BUILT_IN_SCENARIOS[0].id }, realtimeReceipt: minted.receipt }),
    }));
    texts.push(await saved.text());
    // Provenance is kept on the server row: written by the mint itself, and the save's receipt agrees with it.
    expect(fake.rows("trainerSession").find((s) => s.id === minted.callId)).toMatchObject({ realtimeModel: PREMIUM_REALTIME_MODEL, engineTier: "premium", voiceTier: "premium" });
    // The list reads with an explicit select that leaves the model out (the in-memory fake ignores `select`, so the
    // select itself is what is checked here).
    const listSrc = readFileSync(path.join(ROOT, "src/app/api/transcripts/route.ts"), "utf8");
    const listSelect = listSrc.slice(listSrc.indexOf("export async function GET")).match(/select: \{[^}]*\}/);
    expect(listSelect).not.toBeNull();
    expect(listSelect![0]).not.toMatch(/realtimeModel|engineTier/);
    expect(typeof listTranscripts).toBe("function");
    const params = { params: Promise.resolve({ id: minted.callId as string }) };
    texts.push(await (await getTranscript(new NextRequest(`http://localhost/api/transcripts/${minted.callId}`), params)).text());
    const voiceText = await (await getVoice(new NextRequest(`http://localhost/api/transcripts/${minted.callId}/voice`), { params: Promise.resolve({ id: minted.callId as string }) })).text();
    expect(voiceText).toBe(JSON.stringify({ voiceUsed: "premium" }));
    texts.push(voiceText);
    texts.push(await (await configGET()).text());
    for (const t of texts) {
      expect(hasModelId(t), t.slice(0, 200)).toBe(false);
      expect(t).not.toMatch(/realtimeModel|"model"/);
    }
  });
});
