import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";

type Org = { id: string; code: string; voiceModelTier: string | null; voiceModelComped: boolean | null };

// The database and the session check are the only fakes; the routes run for real.
const mocks = vi.hoisted(() => ({
  user: { id: "u-owner", email: "owner@example.test" },
  actor: {} as Record<string, unknown>,
  orgs: new Map<string, Org>(),
  /** TrainerSession rows saved by POST /api/transcripts, in order; ids are unique like the real primary key. */
  saved: [] as Record<string, unknown>[],
  rowIds: new Set<string>(),
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
    trainerSession: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET as voiceGET, PATCH as voicePATCH } from "@/app/api/team/voice/route";
import { POST as mintPOST } from "@/app/api/realtime/session/route";
import { POST as savePOST } from "@/app/api/transcripts/route";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { transcriptSaveBody } from "@/lib/sessionStore";
import { MINT_RECEIPT_TTL_MS, receiptRowId, sealMintReceipt, verifyMintReceipt } from "@/lib/mintReceipt";
import * as voiceTierModule from "@/lib/voiceTier";
import { canEditVoiceTier, canSetVoiceTier, effectiveVoiceTier, normalizeVoiceTier } from "@/lib/voiceTier";
import { PREMIUM_REALTIME_MODEL, STANDARD_REALTIME_MODEL, resolveTierModel } from "@/lib/voiceModels";

const TEST_KEY = "test-only-not-a-secret-0123456789abcdef";

// o-1 is comped (Premium allowed), o-2 (null) and o-3 (false) are not.
const COMPED = "o-1";
const NOT_COMPED = "o-3";

let seq = 0;
const ip = () => `10.9.${Math.floor(++seq / 250)}.${seq % 250}`;
const json = (url: string, method: string, body: unknown, from = ip()) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", "x-forwarded-for": from }, body: JSON.stringify(body) });
const org = (id: string) => mocks.orgs.get(id)!;

/** Sign in as a fresh user (fresh rate-limit buckets). Defaults to the owner of the comped org. */
function as(actor: Partial<Record<string, unknown>>) {
  const id = `u-${++seq}`;
  mocks.user = { id, email: `${id}@example.test` };
  mocks.actor = { id, role: "owner", isPlatformAdmin: false, organizationId: COMPED, firstName: "Ola", lastName: "Reyes", email: `${id}@example.test`, ...actor };
}

beforeEach(() => {
  vi.stubEnv("DATABASE_URL", "postgresql://test@localhost/test");
  vi.stubEnv("DEMO_MODE", "");
  // No Stripe and no USAGE_CAPS: voice is not metered, so the org's voice tier alone picks the model.
  vi.stubEnv("STRIPE_SECRET_KEY", "");
  vi.stubEnv("USAGE_CAPS", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  vi.stubEnv("REALTIME_MODEL", "");
  vi.stubEnv("REALTIME_MODEL_STANDARD", "");
  vi.stubEnv("REALTIME_MODEL_PREMIUM", "");
  vi.stubEnv("JWT_SECRET", TEST_KEY);
  for (const group of Object.values(mocks.prisma)) for (const fn of Object.values(group)) fn.mockReset();
  mocks.orgs = new Map<string, Org>([
    ["o-1", { id: "o-1", code: "329927", voiceModelTier: null, voiceModelComped: true }],
    ["o-2", { id: "o-2", code: "555", voiceModelTier: null, voiceModelComped: null }],
    ["o-3", { id: "o-3", code: "556", voiceModelTier: null, voiceModelComped: false }],
  ]);
  const actorOrg = () => mocks.orgs.get(String(mocks.actor.organizationId)) ?? null;
  mocks.prisma.user.findUnique.mockImplementation(({ select }: { select?: Record<string, unknown> }) => {
    if (!select?.organization) return Promise.resolve(mocks.actor);
    const o = actorOrg();
    return Promise.resolve({ organization: o && { voiceModelTier: o.voiceModelTier, voiceModelComped: o.voiceModelComped } });
  });
  mocks.prisma.organization.findUnique.mockImplementation(({ where }: { where: { id?: string; code?: string } }) =>
    Promise.resolve([...mocks.orgs.values()].find((o) => (where.id ? o.id === where.id : o.code === where.code)) ?? null));
  mocks.prisma.organization.update.mockImplementation(({ where, data }: { where: { id: string }; data: { voiceModelTier: string | null } }) => {
    const o = org(where.id);
    o.voiceModelTier = data.voiceModelTier;
    return Promise.resolve(o);
  });
  mocks.prisma.auditEvent.create.mockResolvedValue({});
  mocks.saved = [];
  mocks.rowIds = new Set<string>();
  // Same uniqueness as the real primary key: a second row with an id already in use is a P2002.
  mocks.prisma.trainerSession.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => {
    const id = typeof data.id === "string" ? data.id : `s-${++seq}`;
    if (mocks.rowIds.has(id)) return Promise.reject(new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`id`)", { code: "P2002", clientVersion: "test" }));
    mocks.rowIds.add(id);
    const row = { ...data, id };
    mocks.saved.push(row);
    return Promise.resolve(row);
  });
  mocks.prisma.trainerSession.update.mockImplementation(({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
    const row = { ...data, id: where.id };
    mocks.saved.push(row);
    return Promise.resolve(row);
  });
  mocks.prisma.trainerSession.findUnique.mockResolvedValue(null);
  as({});
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("voice tier config", () => {
  it("treats null, empty and unknown tiers as Standard", () => {
    for (const raw of [null, undefined, "", "  ", "standard", "gold", 3]) expect(normalizeVoiceTier(raw)).toBe("standard");
    expect(normalizeVoiceTier("premium")).toBe("premium");
    expect(normalizeVoiceTier(" Premium ")).toBe("premium");
  });

  it("maps Standard to gpt-realtime-2.1-mini and Premium to gpt-realtime-2.1 by default", () => {
    expect(STANDARD_REALTIME_MODEL).toBe("gpt-realtime-2.1-mini");
    expect(PREMIUM_REALTIME_MODEL).toBe("gpt-realtime-2.1");
    expect(resolveTierModel("standard", {})).toBe("gpt-realtime-2.1-mini");
    expect(resolveTierModel("premium", {})).toBe("gpt-realtime-2.1");
    expect(resolveTierModel(normalizeVoiceTier(null), {})).toBe("gpt-realtime-2.1-mini");
  });

  it("honors REALTIME_MODEL and REALTIME_MODEL_STANDARD for Standard, REALTIME_MODEL_PREMIUM for Premium", () => {
    expect(resolveTierModel("standard", { REALTIME_MODEL: "prod-model" })).toBe("prod-model");
    expect(resolveTierModel("standard", { REALTIME_MODEL: "prod-model", REALTIME_MODEL_STANDARD: "std-model" })).toBe("std-model");
    expect(resolveTierModel("standard", { REALTIME_MODEL: "  ", REALTIME_MODEL_STANDARD: "" })).toBe(STANDARD_REALTIME_MODEL);
    // REALTIME_MODEL never changes Premium.
    expect(resolveTierModel("premium", { REALTIME_MODEL: "prod-model" })).toBe(PREMIUM_REALTIME_MODEL);
    expect(resolveTierModel("premium", { REALTIME_MODEL_PREMIUM: "big-model" })).toBe("big-model");
  });

  it("runs Premium only when comped AND premium", () => {
    expect(effectiveVoiceTier("premium", true)).toBe("premium");
    expect(effectiveVoiceTier("premium", false)).toBe("standard");
    expect(effectiveVoiceTier("premium", null)).toBe("standard");
    expect(effectiveVoiceTier("premium", undefined)).toBe("standard");
    expect(effectiveVoiceTier(null, true)).toBe("standard");
    expect(effectiveVoiceTier("standard", true)).toBe("standard");
  });

  it("has exactly three paths onto Premium: the comped gate, the verified paid entitlement, or a claimed Free trial call", () => {
    // Merge decision (anvil/premium-voice): main's #61 rule that the paid ENGINE never picks the model still holds. The
    // Premium model is reached only from what beginCall verified in the database: the paid entitlement
    // (PREMIUM_VOICE_ON_SALE exactly "true", active only (never trialing), add-on quantity, period end, Premium minutes left) or
    // the organization's one atomically claimed trial call (PREMIUM_TRIAL_SAMPLE_ON exactly "true"). An engine choice
    // or a stored flag alone never reaches it; see usage-hardening.test.ts, premium-voice.test.ts, premium-trial.test.ts.
    const { mintVoiceTier } = voiceTierModule;
    expect(mintVoiceTier("premium", { paidPremium: false })).toBe("premium");
    expect(mintVoiceTier("standard", { paidPremium: true })).toBe("premium");
    expect(mintVoiceTier("standard", { paidPremium: false, trialSample: true })).toBe("premium");
    expect(mintVoiceTier("standard", { paidPremium: false })).toBe("standard");
    expect(mintVoiceTier("standard", { paidPremium: false, trialSample: false })).toBe("standard");
    // A stored premium tier without the comped flag is Standard before it ever reaches mintVoiceTier.
    expect(mintVoiceTier(effectiveVoiceTier("premium", false), { paidPremium: false })).toBe("standard");
    expect(mintVoiceTier(effectiveVoiceTier("premium", null), { paidPremium: false })).toBe("standard");
  });

  it("lets owners of comped orgs and platform admins change it, nobody else", () => {
    expect(canSetVoiceTier("owner")).toBe(true);
    expect(canSetVoiceTier("manager")).toBe(false);
    expect(canEditVoiceTier("owner", false, true)).toBe(true);
    expect(canEditVoiceTier("owner", false, false)).toBe(false);
    expect(canEditVoiceTier("owner", false, null)).toBe(false);
    expect(canEditVoiceTier("trainee", true, null)).toBe(true);
    expect(canEditVoiceTier("manager", false, true)).toBe(false);
    expect(canEditVoiceTier("trainee", false, true)).toBe(false);
    expect(canEditVoiceTier(undefined, false, true)).toBe(false);
  });
});

describe("mint receipts", () => {
  const NOW = 1_900_000_000_000;

  const CALL_A = "call-aaaaaaaa-0001";
  const CALL_B = "call-bbbbbbbb-0002";

  /** Receipt bytes after the "mr3." prefix: iv[12] | ciphertext | tag[16]. */
  const rawOf = (r: string) => Buffer.from(r.slice(4), "base64url");
  const pack = (raw: Buffer) => `mr3.${raw.toString("base64url")}`;

  it("round-trips the minted model for the same user and the same call", () => {
    const r = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW, TEST_KEY)!;
    expect(r.startsWith("mr3.")).toBe(true);
    expect(verifyMintReceipt(r, "u-a", CALL_A, NOW, TEST_KEY)).toBe("gpt-realtime-2.1");
    expect(verifyMintReceipt(r, "u-a", CALL_A, NOW + MINT_RECEIPT_TTL_MS, TEST_KEY)).toBe("gpt-realtime-2.1");
  });

  it("is opaque: the browser cannot read the model, the user, the call or the tier from it", () => {
    const std = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1-mini", NOW, TEST_KEY)!;
    const prem = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW, TEST_KEY)!;
    for (const r of [std, prem]) {
      const decoded = rawOf(r).toString("latin1");
      for (const needle of ["gpt-", "realtime", "u-a", CALL_A, '"m"', String(NOW / 1000)]) {
        expect(r).not.toContain(needle);
        expect(decoded).not.toContain(needle);
      }
      expect(() => JSON.parse(rawOf(r).toString("utf8"))).toThrow();
    }
    // Same length for every model, so the length does not give the tier away.
    expect(std.length).toBe(prem.length);
    expect(sealMintReceipt("u-a", CALL_A, "x".repeat(80), NOW, TEST_KEY)!.length).toBe(std.length);
    // A fresh IV every time: sealing the same model twice gives different receipts.
    expect(sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW, TEST_KEY)).not.toBe(prem);
  });

  it("rejects another call id, a missing or malformed call id, and refuses to seal a malformed one", () => {
    const r = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW, TEST_KEY)!;
    for (const other of [CALL_B, "voice-1730000000000", "text-1730000000000", undefined, null, "", "short", `${CALL_A} `, 42]) expect(verifyMintReceipt(r, "u-a", other, NOW, TEST_KEY)).toBeNull();
    // Nothing is sealed for a call id that isn't server-shaped, or for a model too long to pad.
    expect(sealMintReceipt("u-a", "bad id!", "gpt-realtime-2.1", NOW, TEST_KEY)).toBeUndefined();
    expect(sealMintReceipt("u-a", CALL_A, "x".repeat(81), NOW, TEST_KEY)).toBeUndefined();
    expect(sealMintReceipt("u-a", CALL_A, "", NOW, TEST_KEY)).toBeUndefined();
  });

  it("rejects another user, another key, a stale or future receipt, any flipped byte, and junk", () => {
    const r = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1-mini", NOW, TEST_KEY)!;
    expect(verifyMintReceipt(r, "u-b", CALL_A, NOW, TEST_KEY)).toBeNull();
    expect(verifyMintReceipt(r, "u-a", CALL_A, NOW, "some-other-key")).toBeNull();
    expect(verifyMintReceipt(r, "u-a", CALL_A, NOW + MINT_RECEIPT_TTL_MS + 1000, TEST_KEY)).toBeNull();
    expect(verifyMintReceipt(sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW + 5 * 60_000, TEST_KEY), "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
    // The user and call are bound as one encoded value, so shifting a separator between them does not open it.
    const colon = sealMintReceipt("u:a", "call-aaaaaaaa", "gpt-realtime-2.1", NOW, TEST_KEY)!;
    expect(verifyMintReceipt(colon, "u", "a-call-aaaaaaaa", NOW, TEST_KEY)).toBeNull();
    // Known-plaintext edit: XOR the Standard plaintext out of the keystream and the Premium one in. The ciphertext
    // then decrypts to Premium, but the tag no longer matches, so it does not open.
    const pad = (m: string) => {
      const j = Buffer.from(JSON.stringify({ m, t: NOW / 1000 }));
      return Buffer.concat([j, Buffer.alloc(160 - j.length, 0x20)]);
    };
    const [stdPt, premPt] = [pad("gpt-realtime-2.1-mini"), pad("gpt-realtime-2.1")];
    const edited = Buffer.from(rawOf(r));
    for (let i = 0; i < 160; i++) edited[12 + i] ^= stdPt[i] ^ premPt[i];
    expect(verifyMintReceipt(pack(edited), "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
    // Flip one byte anywhere (IV, ciphertext or tag): authentication fails, so a Standard receipt can't be edited into Premium.
    const raw = rawOf(r);
    for (const at of [0, 11, 12, 40, raw.length - 17, raw.length - 1]) {
      const bad = Buffer.from(raw);
      bad[at] ^= 0x01;
      expect(verifyMintReceipt(pack(bad), "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
    }
    // Truncated, extended, wrong prefix, non-base64url, oversized and plain junk.
    const junk = [
      undefined, null, 42, "", "abc", "mr3.", "mr3.!!!!", pack(raw.subarray(0, raw.length - 1)), pack(Buffer.concat([raw, Buffer.alloc(1)])),
      `mr2.${r.slice(4)}`, r.slice(4), `${r}=`, `${r} `, "x".repeat(600), `mr3.${"A".repeat(300)}`,
    ];
    for (const j of junk) expect(verifyMintReceipt(j, "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
  });

  it("refuses the old readable signed receipts (v1 without a call id, v2 with one)", () => {
    const v1 = Buffer.from(JSON.stringify({ v: "mint-receipt-v1", u: "u-a", m: "gpt-realtime-2.1", t: NOW / 1000 })).toString("base64url");
    const v1sig = createHmac("sha256", TEST_KEY).update(`mint-receipt-v1:${v1}`).digest("hex");
    expect(verifyMintReceipt(`${v1}.${v1sig}`, "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
    const v2 = Buffer.from(JSON.stringify({ v: "mint-receipt-v2", u: "u-a", s: CALL_A, m: "gpt-realtime-2.1", t: NOW / 1000 })).toString("base64url");
    const v2sig = createHmac("sha256", TEST_KEY).update(`mint-receipt-v2:${v2}`).digest("hex");
    expect(verifyMintReceipt(`${v2}.${v2sig}`, "u-a", CALL_A, NOW, TEST_KEY)).toBeNull();
  });

  it("the client saves a minted voice call under its ids, and a text save never carries them", () => {
    const base = { durationSeconds: 60, scenario: BUILT_IN_SCENARIOS[0], transcript: [{ role: "user" as const, text: "Hi" }], evaluation: null };
    const metered = { sessionId: "cm-call-0001", receipt: "r.sig", callId: "cm-call-0001" };
    expect(transcriptSaveBody({ ...base, mode: "voice" }, null, undefined, metered, 5)).toMatchObject({ sessionId: "cm-call-0001", callId: "cm-call-0001", realtimeReceipt: "r.sig" });
    // Unmetered: no callId, so the save does not try to fill a metering row.
    const unmetered = transcriptSaveBody({ ...base, mode: "voice" }, null, undefined, { sessionId: "uuid-0000-0001", receipt: "r.sig" }, 5);
    expect(unmetered).toMatchObject({ sessionId: "uuid-0000-0001", realtimeReceipt: "r.sig" });
    expect(unmetered).not.toHaveProperty("callId");
    // Without JWT_SECRET there is no receipt, but a metered call still fills its own row.
    expect(transcriptSaveBody({ ...base, mode: "voice" }, null, undefined, { sessionId: "cm-call-0002", callId: "cm-call-0002" }, 5)).toMatchObject({ sessionId: "cm-call-0002", callId: "cm-call-0002" });
    const text = transcriptSaveBody({ ...base, mode: "text" }, null, undefined, metered, 5);
    expect(text.sessionId).toBe("text-5");
    expect(text).not.toHaveProperty("callId");
    expect(text).not.toHaveProperty("realtimeReceipt");
  });

  it("seals and opens nothing without JWT_SECRET", () => {
    const r = sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW, TEST_KEY);
    vi.stubEnv("JWT_SECRET", "");
    expect(sealMintReceipt("u-a", CALL_A, "gpt-realtime-2.1", NOW)).toBeUndefined();
    expect(verifyMintReceipt(r, "u-a", CALL_A, NOW)).toBeNull();
  });
});

describe("/api/team/voice", () => {
  const patch = (body: unknown) => voicePATCH(json("http://localhost/api/team/voice", "PATCH", body));
  const read = async () => (await voiceGET(new NextRequest("http://localhost/api/team/voice"))).json();

  it("reads Standard for a comped organization that never chose, editable by its owner", async () => {
    expect(await read()).toEqual({ tier: "standard", selected: "standard", comped: true, canEdit: true });
  });

  it.each([["false", NOT_COMPED], ["null", "o-2"]])("reads the effective tier, Standard, for an org with comped %s and premium stored", async (_label, orgId) => {
    org(orgId).voiceModelTier = "premium";
    for (const role of ["owner", "manager", "trainee"]) {
      as({ role, organizationId: orgId });
      const body = await read();
      // Not editable, so no stored preference either: only what calls actually run on.
      expect(body).toEqual({ tier: "standard", comped: false, canEdit: false });
      expect(JSON.stringify(body)).not.toContain("premium");
    }
  });

  it("reads Premium only when the org is comped AND premium is selected", async () => {
    org(COMPED).voiceModelTier = "premium";
    expect(await read()).toEqual({ tier: "premium", selected: "premium", comped: true, canEdit: true });
    as({ role: "manager" });
    expect(await read()).toEqual({ tier: "premium", comped: true, canEdit: false });
  });

  it("lets the owner of a comped org switch to Premium and back, storing Standard as null", async () => {
    let res = await patch({ tier: "premium" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: "premium", selected: "premium", comped: true, canEdit: true });
    expect(mocks.prisma.organization.update).toHaveBeenCalledWith({ where: { id: COMPED }, data: { voiceModelTier: "premium" } });
    expect(org(COMPED).voiceModelTier).toBe("premium");
    expect(mocks.prisma.auditEvent.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "org.voice_tier_changed", metadata: expect.objectContaining({ from: "standard", to: "premium", comped: true }) }) }));

    res = await patch({ tier: "standard" });
    expect(res.status).toBe(200);
    expect(org(COMPED).voiceModelTier).toBeNull();
  });

  it("never writes billing fields: only voiceModelTier changes", async () => {
    await patch({ tier: "premium" });
    for (const [args] of mocks.prisma.organization.update.mock.calls) expect(Object.keys((args as { data: object }).data)).toEqual(["voiceModelTier"]);
  });

  it.each([["false", NOT_COMPED], ["null", "o-2"]])("stops the owner of an org with comped %s: canEdit false and PATCH 403", async (_label, orgId) => {
    as({ organizationId: orgId });
    expect(await read()).toEqual({ tier: "standard", comped: false, canEdit: false });
    const res = await patch({ tier: "premium" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("not_comped");
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
  });

  it.each(["trainee", "manager"])("forbids a %s with 403 even on a comped org, and changes nothing", async (role) => {
    as({ role });
    const res = await patch({ tier: "premium" });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
    // GET still answers with the effective tier, but canEdit false hides the panel and no preference is sent.
    expect(await read()).toEqual({ tier: "standard", comped: true, canEdit: false });
  });

  it("lets a platform admin set any org's tier by code, comped or not; an owner cannot reach another org", async () => {
    as({ role: "trainee", isPlatformAdmin: true, organizationId: null });
    let res = await patch({ tier: "premium", orgCode: "556" });
    expect(res.status).toBe(200);
    // Stored as premium, but the org is not comped, so the effective tier stays Standard.
    expect(await res.json()).toEqual({ tier: "standard", selected: "premium", comped: false, canEdit: true });
    expect(org(NOT_COMPED).voiceModelTier).toBe("premium");
    const view = await (await voiceGET(new NextRequest("http://localhost/api/team/voice?org=556"))).json();
    expect(view).toEqual({ tier: "standard", selected: "premium", comped: false, canEdit: true });

    as({ role: "owner" });
    res = await patch({ tier: "premium", orgCode: "556" });
    expect(res.status).toBe(403);
    expect(org(COMPED).voiceModelTier).toBeNull();
  });

  it("rejects a tier that isn't standard or premium, extra fields such as comped, and an empty body", async () => {
    expect((await patch({ tier: "ultra" })).status).toBe(400);
    expect((await patch({ tier: "premium", model: "gpt-realtime-2.1" })).status).toBe(400);
    expect((await patch({ tier: "premium", comped: true })).status).toBe(400);
    expect((await patch({ tier: "premium", voiceModelComped: true })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect(mocks.prisma.organization.update).not.toHaveBeenCalled();
    expect(org(COMPED).voiceModelComped).toBe(true);
    expect(org(NOT_COMPED).voiceModelComped).toBe(false);
  });

  it("answers 429 with Retry-After past the per-IP team settings limit", async () => {
    vi.stubEnv("RATE_LIMIT_TEAM_SETTINGS_MAX", "1");
    const from = ip();
    expect((await voicePATCH(json("http://localhost/api/team/voice", "PATCH", { tier: "premium" }, from))).status).toBe(200);
    as({});
    const res = await voicePATCH(json("http://localhost/api/team/voice", "PATCH", { tier: "standard" }, from));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  it("does not write in demo mode", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const res = await patch({ tier: "premium" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("local_only");
  });
});

describe("POST /api/realtime/session picks the model from the organization's effective tier", () => {
  const scenario = BUILT_IN_SCENARIOS[0];
  const mint = (from = ip()) => mintPOST(json("http://localhost/api/realtime/session", "POST", { scenario }, from));
  const upstream = () => {
    const fetchMock = vi.fn(async () => Response.json({ value: "ek_test123456789", expires_at: 1_900_000_000 }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const sentModel = (fetchMock: ReturnType<typeof upstream>) => JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).session.model;

  it("uses Standard for a comped organization with no tier, and ignores a model or tier sent by the client", async () => {
    const fetchMock = upstream();
    const res = await mintPOST(json("http://localhost/api/realtime/session", "POST", { scenario, model: PREMIUM_REALTIME_MODEL, tier: "premium" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    const body = JSON.parse(text);
    // No model field and no model id anywhere in the browser response; the model goes upstream only.
    expect(Object.keys(body).sort()).toEqual(["clientSecret", "expiresAt", "receipt", "sessionId", "voice"]);
    expect(text).not.toMatch(/gpt-|realtime-2/);
    expect(sentModel(fetchMock)).toBe("gpt-realtime-2.1-mini");
    // The receipt is opaque to the client but carries the minted model, bound to this call's sessionId.
    expect(verifyMintReceipt(body.receipt, mocks.user.id, body.sessionId)).toBe("gpt-realtime-2.1-mini");
  });

  it("binds every mint to its own server-generated call id, fixed before the secret is minted", async () => {
    upstream();
    const a = await (await mint()).json();
    const b = await (await mint()).json();
    expect(a.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.sessionId).not.toBe(b.sessionId);
    // Unmetered: no metering call id is sent, so the client never starts a meter for it.
    expect(a.callId).toBeUndefined();
    expect(verifyMintReceipt(a.receipt, mocks.user.id, b.sessionId)).toBeNull();
    expect(verifyMintReceipt(b.receipt, mocks.user.id, a.sessionId)).toBeNull();
  });

  it("ignores a sessionId the client sends to the mint route", async () => {
    upstream();
    const body = await (await mintPOST(json("http://localhost/api/realtime/session", "POST", { scenario, sessionId: "client-chosen-0001" }))).json();
    expect(body.sessionId).not.toBe("client-chosen-0001");
    expect(verifyMintReceipt(body.receipt, mocks.user.id, "client-chosen-0001")).toBeNull();
  });

  it("uses Premium when comped and the owner switches to premium", async () => {
    await voicePATCH(json("http://localhost/api/team/voice", "PATCH", { tier: "premium" }));
    const fetchMock = upstream();
    const text = await (await mint()).text();
    const body = JSON.parse(text);
    expect(sentModel(fetchMock)).toBe("gpt-realtime-2.1");
    // Premium is not visible to the browser either: no model field and no model id.
    expect(body).not.toHaveProperty("model");
    expect(text).not.toMatch(/gpt-|realtime-2/);
    expect(verifyMintReceipt(body.receipt, mocks.user.id, body.sessionId)).toBe("gpt-realtime-2.1");
  });

  it.each([["false", NOT_COMPED], ["null", "o-2"]])("forces Standard when comped is %s even if the stored tier is premium", async (_label, orgId) => {
    org(orgId).voiceModelTier = "premium";
    as({ organizationId: orgId });
    const fetchMock = upstream();
    await mint();
    expect(sentModel(fetchMock)).toBe("gpt-realtime-2.1-mini");
  });

  it("uses Standard for a user with no organization", async () => {
    as({ organizationId: null });
    const fetchMock = upstream();
    await mint();
    expect(sentModel(fetchMock)).toBe(STANDARD_REALTIME_MODEL);
  });

  it("keeps an existing REALTIME_MODEL for Standard", async () => {
    vi.stubEnv("REALTIME_MODEL", "self-host-model");
    const fetchMock = upstream();
    await mint();
    expect(sentModel(fetchMock)).toBe("self-host-model");
  });

  it("falls back to Standard when the tier lookup fails", async () => {
    org(COMPED).voiceModelTier = "premium";
    mocks.prisma.user.findUnique.mockRejectedValue(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchMock = upstream();
    const res = await mint();
    expect(res.status).toBe(200);
    expect(sentModel(fetchMock)).toBe(STANDARD_REALTIME_MODEL);
  });

  it("still answers 429 past the per-account cap of 6 a minute, without minting", async () => {
    org(COMPED).voiceModelTier = "premium";
    const fetchMock = upstream();
    const from = ip();
    for (let i = 0; i < 6; i++) expect((await mint(from)).status).toBe(200);
    const res = await mint(from);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("still answers 429 with Retry-After past the per-IP realtime cap", async () => {
    vi.stubEnv("RATE_LIMIT_REALTIME_MAX", "1");
    upstream();
    const from = ip();
    expect((await mint(from)).status).toBe(200);
    as({});
    const res = await mint(from);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });
});

describe("POST /api/transcripts logs the voice model", () => {
  const transcript = [{ role: "assistant", text: "Hello, this is Sam." }, { role: "user", text: "Hi Sam, thanks for taking the call." }];
  /** Saves a call. Without an explicit sessionId it is a text save, named the way the client names one. */
  const save = (extra: Record<string, unknown>) =>
    savePOST(json("http://localhost/api/transcripts", "POST", { sessionId: `text-${++seq}000000`, transcript, durationSeconds: 60, scenario: { id: BUILT_IN_SCENARIOS[0].id }, ...extra }));
  /** Saves the minted call the way the client does: under the receipt's sessionId, with the receipt. */
  const saveCall = (minted: { receipt: string; sessionId: string }, extra: Record<string, unknown> = {}) =>
    save({ sessionId: minted.sessionId, realtimeReceipt: minted.receipt, ...extra });
  const last = () => mocks.saved[mocks.saved.length - 1];
  // The column defaults to null; this mock applies no defaults, so a row saved without a model has none set.
  const loggedModel = () => last().realtimeModel ?? null;
  const withModel = () => mocks.saved.filter((r) => r.realtimeModel != null);
  const lastAudit = () => (mocks.prisma.auditEvent.create.mock.calls.at(-1)![0] as { data: { metadata: Record<string, unknown> } }).data.metadata;
  const mintOnce = async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: "ek_test_secret_1", expires_at: 1_900_000_000 })));
    return (await mintPOST(json("http://localhost/api/realtime/session", "POST", { scenario: BUILT_IN_SCENARIOS[0] }))).json();
  };

  it("stores the Premium model a comped premium call was minted with, on that call's own row", async () => {
    org(COMPED).voiceModelTier = "premium";
    const minted = await mintOnce();
    expect(typeof minted.receipt).toBe("string");
    const res = await saveCall(minted);
    expect(res.status).toBe(200);
    expect(loggedModel()).toBe("gpt-realtime-2.1");
    expect(last().id).toBe(receiptRowId(minted.sessionId));
    expect(last().realtimeSessionId).toBe(minted.sessionId);
    expect((await res.json()).id).toBe(receiptRowId(minted.sessionId));
  });

  it("stores the Standard model for a call on an org that is not comped", async () => {
    org(NOT_COMPED).voiceModelTier = "premium";
    as({ organizationId: NOT_COMPED });
    const minted = await mintOnce();
    await saveCall(minted);
    expect(loggedModel()).toBe("gpt-realtime-2.1-mini");
  });

  describe("cross-call replay", () => {
    it("does not log call A's receipt on call B, in either direction", async () => {
      org(COMPED).voiceModelTier = "premium";
      const a = await mintOnce();
      const b = await mintOnce();
      // Each receipt attached to the other call's id: both saved, neither logs a model.
      await save({ sessionId: b.sessionId, realtimeReceipt: a.receipt });
      expect(loggedModel()).toBeNull();
      expect(lastAudit()).toMatchObject({ receiptRejected: true });
      await save({ sessionId: a.sessionId, realtimeReceipt: b.receipt });
      expect(loggedModel()).toBeNull();
      // Each with its own id still logs, once.
      await saveCall(a);
      await saveCall(b);
      expect(withModel().map((r) => r.id)).toEqual([receiptRowId(a.sessionId), receiptRowId(b.sessionId)]);
    });

    it("does not log a voice receipt on a text save", async () => {
      org(COMPED).voiceModelTier = "premium";
      const minted = await mintOnce();
      // A text save is named by the client (`text-<ms>`), which is never the call id the receipt is bound to.
      await save({ realtimeReceipt: minted.receipt });
      expect(loggedModel()).toBeNull();
      await save({ sessionId: `text-${Date.now()}`, realtimeReceipt: minted.receipt });
      expect(loggedModel()).toBeNull();
      expect(withModel()).toHaveLength(0);
    });

    it("logs one receipt at most once: a second save of the same call is kept, without a model", async () => {
      org(COMPED).voiceModelTier = "premium";
      const minted = await mintOnce();
      expect((await saveCall(minted)).status).toBe(200);
      const again = await saveCall(minted);
      expect(again.status).toBe(200);
      expect(loggedModel()).toBeNull();
      expect(lastAudit()).toMatchObject({ receiptRejected: true });
      // Two rows saved, one with the model.
      expect(mocks.saved).toHaveLength(2);
      expect(withModel()).toHaveLength(1);
      expect((await again.json()).id).not.toBe(receiptRowId(minted.sessionId));
    });

    it("logs one receipt at most once even when the saves race", async () => {
      const minted = await mintOnce();
      const results = await Promise.all([saveCall(minted), saveCall(minted), saveCall(minted)]);
      expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(withModel()).toHaveLength(1);
    });

    // Metered calls (receipt bound to the metering call id, logged on that row) are covered end to end with the
    // real beginCall in usage-hardening.test.ts ("metered transcript save").

    it("rethrows other database errors instead of treating them as a replay", async () => {
      const minted = await mintOnce();
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.prisma.trainerSession.create.mockRejectedValueOnce(new Error("connection reset"));
      expect((await saveCall(minted)).status).toBe(500);
    });
  });

  it.each([
    ["an owner of an org that is not comped", { role: "owner", organizationId: NOT_COMPED }],
    ["a trainee of an org that is not comped", { role: "trainee", organizationId: NOT_COMPED }],
    ["a trainee of a comped org on Standard", { role: "trainee", organizationId: COMPED }],
  ])("never stores a forged Premium model id from %s: it logs the server-minted Standard", async (_who, actor) => {
    org(NOT_COMPED).voiceModelTier = "premium";
    as(actor);
    const minted = await mintOnce();
    expect(verifyMintReceipt(minted.receipt, mocks.user.id, minted.sessionId)).toBe(STANDARD_REALTIME_MODEL);

    // The client can't read the receipt, and editing its ciphertext breaks the tag (before the genuine save, which
    // would use up the call). A receipt sealed for Premium on another call doesn't open here either.
    expect(String(minted.receipt)).not.toContain(STANDARD_REALTIME_MODEL);
    const raw = Buffer.from(String(minted.receipt).slice(4), "base64url");
    raw[20] ^= 0x01;
    await saveCall({ sessionId: minted.sessionId, receipt: `mr3.${raw.toString("base64url")}` });
    expect(loggedModel()).toBeNull();
    await saveCall({ sessionId: minted.sessionId, receipt: sealMintReceipt(mocks.user.id, "call-other-0001", PREMIUM_REALTIME_MODEL)! });
    expect(loggedModel()).toBeNull();

    // The client claims Premium with no receipt at all.
    await save({ sessionId: minted.sessionId, realtimeModel: PREMIUM_REALTIME_MODEL });
    expect(loggedModel()).toBeNull();

    // The client claims Premium next to its genuine Standard receipt.
    await saveCall(minted, { realtimeModel: PREMIUM_REALTIME_MODEL });
    expect(loggedModel()).toBe(STANDARD_REALTIME_MODEL);
  });

  it("does not accept another user's Premium receipt, even under that call's own id", async () => {
    org(COMPED).voiceModelTier = "premium";
    const premium = await mintOnce();
    expect(verifyMintReceipt(premium.receipt, mocks.user.id, premium.sessionId)).toBe(PREMIUM_REALTIME_MODEL);
    as({ role: "trainee", organizationId: NOT_COMPED });
    await saveCall(premium);
    expect(loggedModel()).toBeNull();
    expect(withModel()).toHaveLength(0);
  });

  it("stores null for text calls", async () => {
    await save({});
    expect(loggedModel()).toBeNull();
  });
});
