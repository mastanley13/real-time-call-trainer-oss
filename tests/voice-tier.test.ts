import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

type Org = { id: string; code: string; voiceModelTier: string | null; voiceModelComped: boolean | null };

// The database and the session check are the only fakes; the routes run for real.
const mocks = vi.hoisted(() => ({
  user: { id: "u-owner", email: "owner@example.test" },
  actor: {} as Record<string, unknown>,
  orgs: new Map<string, Org>(),
  prisma: {
    user: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn(), update: vi.fn() },
    auditEvent: { create: vi.fn() },
    trainerSession: { create: vi.fn(), findUnique: vi.fn() },
  },
}));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { GET as voiceGET, PATCH as voicePATCH } from "@/app/api/team/voice/route";
import { POST as mintPOST } from "@/app/api/realtime/session/route";
import { POST as savePOST } from "@/app/api/transcripts/route";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { MINT_RECEIPT_TTL_MS, signMintReceipt, verifyMintReceipt } from "@/lib/mintReceipt";
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
  mocks.prisma.trainerSession.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: "s-1", ...data }));
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

  it("has no paid-engine path onto Premium: the comped gate is the only one", () => {
    // The paid Premium Voice add-on is metered in src/lib/usage.ts and never picks the model (see usage-hardening.test.ts).
    expect(Object.keys(voiceTierModule)).not.toContain("mintVoiceTier");
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

  it("round-trips the minted model for the same user", () => {
    const r = signMintReceipt("u-a", "gpt-realtime-2.1", NOW, TEST_KEY)!;
    expect(verifyMintReceipt(r, "u-a", NOW, TEST_KEY)).toBe("gpt-realtime-2.1");
    expect(verifyMintReceipt(r, "u-a", NOW + MINT_RECEIPT_TTL_MS, TEST_KEY)).toBe("gpt-realtime-2.1");
  });

  it("rejects another user, another key, an edited model, a stale or future receipt, and junk", () => {
    const r = signMintReceipt("u-a", "gpt-realtime-2.1-mini", NOW, TEST_KEY)!;
    expect(verifyMintReceipt(r, "u-b", NOW, TEST_KEY)).toBeNull();
    expect(verifyMintReceipt(r, "u-a", NOW, "some-other-key")).toBeNull();
    expect(verifyMintReceipt(r, "u-a", NOW + MINT_RECEIPT_TTL_MS + 1000, TEST_KEY)).toBeNull();
    expect(verifyMintReceipt(signMintReceipt("u-a", "gpt-realtime-2.1", NOW + 5 * 60_000, TEST_KEY), "u-a", NOW, TEST_KEY)).toBeNull();
    // Swap Premium into the payload but keep the Standard signature.
    const [body, sig] = r.split(".");
    const forged = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace("gpt-realtime-2.1-mini", "gpt-realtime-2.1")).toString("base64url");
    expect(verifyMintReceipt(`${forged}.${sig}`, "u-a", NOW, TEST_KEY)).toBeNull();
    for (const junk of [undefined, null, "", "abc", "abc.def", `${body}.${"0".repeat(64)}`, "x".repeat(600)]) expect(verifyMintReceipt(junk, "u-a", NOW, TEST_KEY)).toBeNull();
  });

  it("signs and verifies nothing without JWT_SECRET", () => {
    const r = signMintReceipt("u-a", "gpt-realtime-2.1", NOW, TEST_KEY);
    vi.stubEnv("JWT_SECRET", "");
    expect(signMintReceipt("u-a", "gpt-realtime-2.1", NOW)).toBeUndefined();
    expect(verifyMintReceipt(r, "u-a", NOW)).toBeNull();
  });
});

describe("/api/team/voice", () => {
  const patch = (body: unknown) => voicePATCH(json("http://localhost/api/team/voice", "PATCH", body));
  const read = async () => (await voiceGET(new NextRequest("http://localhost/api/team/voice"))).json();

  it("reads Standard for a comped organization that never chose, editable by its owner", async () => {
    expect(await read()).toEqual({ tier: "standard", comped: true, canEdit: true });
  });

  it("lets the owner of a comped org switch to Premium and back, storing Standard as null", async () => {
    let res = await patch({ tier: "premium" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: "premium", comped: true, canEdit: true });
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
    // They can still see the current setting, read-only.
    expect(await read()).toEqual({ tier: "standard", comped: true, canEdit: false });
  });

  it("lets a platform admin set any org's tier by code, comped or not; an owner cannot reach another org", async () => {
    as({ role: "trainee", isPlatformAdmin: true, organizationId: null });
    let res = await patch({ tier: "premium", orgCode: "556" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tier: "premium", comped: false, canEdit: true });
    expect(org(NOT_COMPED).voiceModelTier).toBe("premium");
    const view = await (await voiceGET(new NextRequest("http://localhost/api/team/voice?org=556"))).json();
    expect(view).toEqual({ tier: "premium", comped: false, canEdit: true });

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
    const body = await res.json();
    expect(body.model).toBe("gpt-realtime-2.1-mini");
    expect(sentModel(fetchMock)).toBe("gpt-realtime-2.1-mini");
    // The receipt is opaque to the client but carries the minted model for the save.
    expect(verifyMintReceipt(body.receipt, mocks.user.id)).toBe("gpt-realtime-2.1-mini");
  });

  it("uses Premium when comped and the owner switches to premium", async () => {
    await voicePATCH(json("http://localhost/api/team/voice", "PATCH", { tier: "premium" }));
    const fetchMock = upstream();
    const body = await (await mint()).json();
    expect(sentModel(fetchMock)).toBe("gpt-realtime-2.1");
    expect(verifyMintReceipt(body.receipt, mocks.user.id)).toBe("gpt-realtime-2.1");
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
  const save = (extra: Record<string, unknown>) =>
    savePOST(json("http://localhost/api/transcripts", "POST", { sessionId: "voice-1", transcript, durationSeconds: 60, scenario: { id: BUILT_IN_SCENARIOS[0].id }, ...extra }));
  const loggedModel = () => (mocks.prisma.trainerSession.create.mock.calls[0][0] as { data: { realtimeModel: unknown } }).data.realtimeModel;
  const mintOnce = async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ value: "ek_test_secret_1", expires_at: 1_900_000_000 })));
    return (await mintPOST(json("http://localhost/api/realtime/session", "POST", { scenario: BUILT_IN_SCENARIOS[0] }))).json();
  };

  it("stores the Premium model a comped premium call was minted with, from the receipt", async () => {
    org(COMPED).voiceModelTier = "premium";
    const minted = await mintOnce();
    expect(typeof minted.receipt).toBe("string");
    const res = await save({ realtimeReceipt: minted.receipt });
    expect(res.status).toBe(200);
    expect(loggedModel()).toBe("gpt-realtime-2.1");
  });

  it("stores the Standard model for a call on an org that is not comped", async () => {
    org(NOT_COMPED).voiceModelTier = "premium";
    as({ organizationId: NOT_COMPED });
    const minted = await mintOnce();
    await save({ realtimeReceipt: minted.receipt });
    expect(loggedModel()).toBe("gpt-realtime-2.1-mini");
  });

  it.each([
    ["an owner of an org that is not comped", { role: "owner", organizationId: NOT_COMPED }],
    ["a trainee of an org that is not comped", { role: "trainee", organizationId: NOT_COMPED }],
    ["a trainee of a comped org on Standard", { role: "trainee", organizationId: COMPED }],
  ])("never stores a forged Premium model id from %s: it logs the server-minted Standard", async (_who, actor) => {
    org(NOT_COMPED).voiceModelTier = "premium";
    as(actor);
    const minted = await mintOnce();
    expect(verifyMintReceipt(minted.receipt, mocks.user.id)).toBe(STANDARD_REALTIME_MODEL);

    // The client claims Premium next to its genuine Standard receipt.
    await save({ realtimeModel: PREMIUM_REALTIME_MODEL, realtimeReceipt: minted.receipt });
    expect(loggedModel()).toBe(STANDARD_REALTIME_MODEL);

    // The client claims Premium with no receipt at all.
    mocks.prisma.trainerSession.create.mockClear();
    await save({ realtimeModel: PREMIUM_REALTIME_MODEL });
    expect(loggedModel()).toBeNull();

    // The client edits the receipt's payload to say Premium.
    mocks.prisma.trainerSession.create.mockClear();
    const [body, sig] = String(minted.receipt).split(".");
    const forged = Buffer.from(Buffer.from(body, "base64url").toString("utf8").replace(STANDARD_REALTIME_MODEL, PREMIUM_REALTIME_MODEL)).toString("base64url");
    await save({ realtimeReceipt: `${forged}.${sig}` });
    expect(loggedModel()).toBeNull();
  });

  it("does not accept another user's Premium receipt", async () => {
    org(COMPED).voiceModelTier = "premium";
    const premium = await mintOnce();
    expect(verifyMintReceipt(premium.receipt, mocks.user.id)).toBe(PREMIUM_REALTIME_MODEL);
    as({ role: "trainee", organizationId: NOT_COMPED });
    await save({ realtimeReceipt: premium.receipt });
    expect(loggedModel()).toBeNull();
  });

  it("stores null for text calls", async () => {
    await save({});
    expect(loggedModel()).toBeNull();
  });
});
