import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// Only the database and the session check are replaced; OpenAI's endpoint is a stubbed fetch. Nothing leaves the process.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, endCall, heartbeat } from "@/lib/usage";
import { isTrialSampleOn, PREMIUM_TRIAL_SAMPLE_ENV, TRIAL_SAMPLE_SECONDS, trialDeadlineBinds, trialMaxSeconds, trialSampleEligible } from "@/lib/premiumTrial";
import { premiumOnSale, premiumTrialSampleOn } from "@/lib/serverConfig";
import { mintVoiceTier } from "@/lib/voiceTier";
import { TRIAL_CALL_NOTICE, CAP_STOPPED_MESSAGE, voiceLabel } from "@/lib/billingUi";
import { voiceInfoFrom } from "@/components/call/RealtimeVoiceSession";
import { MAX_CALL_SECONDS } from "@/lib/usagePlan";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { POST as realtimeSession } from "@/app/api/realtime/session/route";
import { POST as heartbeatRoute } from "@/app/api/usage/heartbeat/route";
import { GET as getVoice } from "@/app/api/transcripts/[id]/voice/route";

const MAR10 = new Date("2026-03-10T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const scn = { id: "quote-follow-up", title: "Quote follow-up" };
const MODEL_ID = /gpt-|model-premium-test|model-standard-test|realtimeModel/;

let fake: ReturnType<typeof createFakePrisma>;
let base: Date;
let shift = 0;
let models: string[];
let ttls: number[];
const at = (sec: number) => new Date(base.getTime() + sec * 1000);

function addOrg(id: string, extra: Record<string, unknown> = {}) {
  return fake.seed("organization", { id, code: `c-${id}`, createdAt: MAR10, ...extra });
}
function addUser(id: string, organizationId: string | null, extra: Record<string, unknown> = {}) {
  return fake.seed("user", { id, email: `${id}@example.test`, organizationId, usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
}
const org = (id = "org-free") => fake.rows("organization").find((o) => o.id === id)!;
const session = (id: string) => fake.rows("trainerSession").find((s) => s.id === id)!;
const allowanceOf = (userId: string) => fake.rows("usageAllowance").find((a) => a.userId === userId)!;
const trialRows = () => fake.rows("trainerSession").filter((s) => s.premiumTrial === true);

/** An entitled Pro add-on subscriber (paid Premium when PREMIUM_VOICE_ON_SALE is on). */
const proPremium = () => ({
  planTier: "pro", premiumVoice: true, premiumVoiceQuantity: 1, stripeSubscriptionId: "sub_test_pro", stripeCustomerId: "cus_test_pro",
  subscriptionStatus: "active", subscriptionPeriodEnd: new Date(base.getTime() + 20 * DAY),
});

async function begin(userId: string, sec = 0, opts: Parameters<typeof beginCall>[3] = { offerTrialSample: true }) {
  const r = await beginCall(userId, scn, at(sec), opts);
  if (!r.ok) throw new Error(r.error);
  return r;
}
const mintAs = async (userId: string) => {
  mocks.authId = userId;
  const res = await realtimeSession(new NextRequest("http://localhost/api/realtime/session", { method: "POST", body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0] }), headers: { "content-type": "application/json" } }));
  return { res, text: await res.clone().text(), body: (await res.json()) as Record<string, unknown> };
};
const voiceOf = async (id: string) => (await getVoice(new NextRequest(`http://localhost/api/transcripts/${id}/voice`), { params: Promise.resolve({ id }) })).text();

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  mocks.authId = "u-1";
  base = new Date(new Date("2026-10-15T12:00:00Z").getTime() + ++shift * 2 * 3_600_000);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(base);
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("JWT_SECRET", "test-only-not-a-secret-0123456789abcdef");
  vi.stubEnv("PREMIUM_VOICE_ON_SALE", "");
  vi.stubEnv(PREMIUM_TRIAL_SAMPLE_ENV, "true");
  vi.stubEnv("OPENAI_API_KEY", "sk-test-not-real");
  vi.stubEnv("REALTIME_MODEL", "");
  vi.stubEnv("REALTIME_MODEL_PREMIUM", "model-premium-test");
  vi.stubEnv("REALTIME_MODEL_STANDARD", "model-standard-test");
  models = [];
  ttls = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    models.push(body.session.model);
    ttls.push(body.expires_after.seconds);
    return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
  }));
  // A Free organization with two members.
  addOrg("org-free");
  addUser("u-1", "org-free");
  addUser("u-2", "org-free");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- Pure rules -------------------------------------------------------------------------------------------------

describe("trial rules (pure)", () => {
  it("the flag is exact true only, default off, and independent of the sale flag", () => {
    expect(isTrialSampleOn({})).toBe(false);
    for (const v of ["", "TRUE", "True", "1", "yes", "on", " true"]) expect(isTrialSampleOn({ [PREMIUM_TRIAL_SAMPLE_ENV]: v }), v).toBe(false);
    expect(isTrialSampleOn({ [PREMIUM_TRIAL_SAMPLE_ENV]: "true" })).toBe(true);
    expect(premiumTrialSampleOn({})).toBe(false);
    expect(premiumTrialSampleOn({ [PREMIUM_TRIAL_SAMPLE_ENV]: "true" })).toBe(true);
    // No Stripe needed, and no sale flag needed.
    expect(premiumTrialSampleOn({ [PREMIUM_TRIAL_SAMPLE_ENV]: "true", PREMIUM_VOICE_ON_SALE: "" })).toBe(true);
    // Never in demo mode.
    expect(premiumTrialSampleOn({ [PREMIUM_TRIAL_SAMPLE_ENV]: "true", DEMO_MODE: "true" })).toBe(false);
    // The sale flag does not turn the trial on, and the trial flag does not put Premium on sale.
    expect(premiumTrialSampleOn({ PREMIUM_VOICE_ON_SALE: "true", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
    expect(premiumOnSale({ [PREMIUM_TRIAL_SAMPLE_ENV]: "true", STRIPE_SECRET_KEY: "sk_test_x" })).toBe(false);
  });

  it("deadline: at most 300 seconds, and a lower existing deadline wins", () => {
    expect(TRIAL_SAMPLE_SECONDS).toBe(300);
    expect(trialMaxSeconds(MAX_CALL_SECONDS)).toBe(300);
    expect(trialMaxSeconds(600)).toBe(300);
    expect(trialMaxSeconds(300)).toBe(300);
    expect(trialMaxSeconds(120)).toBe(120);
    expect(trialMaxSeconds(-5)).toBe(0);
    expect(trialDeadlineBinds(MAX_CALL_SECONDS)).toBe(true);
    expect(trialDeadlineBinds(300)).toBe(false);
    expect(trialDeadlineBinds(120)).toBe(false);
  });

  it("eligibility: a never-paid Free organization only; not comped, not pooled, not paid or lapsed, not org-less, not claimed", () => {
    const orgRow = { planTier: "free", stripeSubscriptionId: null, premiumVoice: false, voiceModelComped: null, premiumTrialCallUsedAt: null };
    const userRow = { stripeSubscriptionId: null, premiumVoice: false };
    const ok = { flagOn: true, plan: "free", pooled: false, comped: false, org: orgRow, user: userRow };
    expect(trialSampleEligible(ok)).toBe(true);
    expect(trialSampleEligible({ ...ok, flagOn: false })).toBe(false);
    expect(trialSampleEligible({ ...ok, org: null })).toBe(false); // org-less: conservative, no trial
    expect(trialSampleEligible({ ...ok, user: null })).toBe(false);
    expect(trialSampleEligible({ ...ok, plan: "pro" })).toBe(false); // includes an entitled Stripe `trialing` Pro
    expect(trialSampleEligible({ ...ok, plan: "team", pooled: true })).toBe(false);
    expect(trialSampleEligible({ ...ok, comped: true })).toBe(false);
    expect(trialSampleEligible({ ...ok, org: { ...orgRow, voiceModelComped: true } })).toBe(false); // comped on standard
    expect(trialSampleEligible({ ...ok, org: { ...orgRow, planTier: "team" } })).toBe(false); // lapsed Team
    expect(trialSampleEligible({ ...ok, org: { ...orgRow, stripeSubscriptionId: "sub_test_team" } })).toBe(false);
    expect(trialSampleEligible({ ...ok, org: { ...orgRow, premiumVoice: true } })).toBe(false);
    expect(trialSampleEligible({ ...ok, user: { ...userRow, stripeSubscriptionId: "sub_test_pro" } })).toBe(false); // past-due or lapsed Pro
    expect(trialSampleEligible({ ...ok, user: { ...userRow, premiumVoice: true } })).toBe(false);
    expect(trialSampleEligible({ ...ok, org: { ...orgRow, premiumTrialCallUsedAt: new Date() } })).toBe(false);
  });

  it("the trial is one of exactly three ways onto the Premium model", () => {
    expect(mintVoiceTier("standard", { paidPremium: false, trialSample: true })).toBe("premium");
    expect(mintVoiceTier("standard", { paidPremium: false, trialSample: false })).toBe("standard");
  });
});

// ---- The claim ----------------------------------------------------------------------------------------------------

describe("one Premium trial call per Free organization", () => {
  it("1: the first call claims it, durably, on the organization; the call is Premium on the standard billing engine", async () => {
    const first = await begin("u-1");
    expect(first.premium).toMatchObject({ source: "trial", nextCallStandard: true, fallback: null });
    expect(first.engine).toBe("standard");
    expect(session(first.callId)).toMatchObject({ premiumTrial: true, voiceTier: "premium", engineTier: "standard", premiumReservedMinutes: 0 });
    expect(org()).toMatchObject({ premiumTrialCallSessionId: first.callId });
    expect(org().premiumTrialCallUsedAt).toBeInstanceOf(Date);
    expect(trialRows()).toHaveLength(1);
  });

  it("2: two concurrent mints by two members: exactly one wins", async () => {
    const [a, b] = await Promise.all([begin("u-1"), begin("u-2")]);
    const sources = [a.premium.source, b.premium.source].sort();
    expect(sources).toEqual([null, "trial"]);
    expect(trialRows()).toHaveLength(1);
    const winner = a.premium.source === "trial" ? a : b;
    expect(org().premiumTrialCallSessionId).toBe(winner.callId);
  });

  it("2b: another connection commits the claim between this mint's eligibility read and its write: this call is Standard", async () => {
    const other = new Date(base.getTime() - 1000);
    fake.interleave("organization", "updateMany", async () => { org().premiumTrialCallUsedAt = other; org().premiumTrialCallSessionId = "call-from-elsewhere"; }, (args) => "premiumTrialCallUsedAt" in args.data);
    const r = await begin("u-1");
    expect(r.premium.source).toBeNull();
    expect(session(r.callId)).toMatchObject({ premiumTrial: false, voiceTier: "standard" });
    // The winner's claim is untouched.
    expect(org()).toMatchObject({ premiumTrialCallUsedAt: other, premiumTrialCallSessionId: "call-from-elsewhere" });
  });

  it("3: no reset across sessions, members, sign-ins, retries or failed calls", async () => {
    const first = await begin("u-1");
    const claimedAt = org().premiumTrialCallUsedAt;
    await endCall("u-1", first.callId, "failed_connect", at(5));
    // The same member again (a new session, or after signing in again: nothing per session or per login is read).
    const again = await begin("u-1", 10);
    expect(again.premium.source).toBeNull();
    // A duplicate start while that call is still open is refused by the normal reservation guard (the open Free call
    // holds the plan's minutes), not turned into a second trial. The guards stay exactly as they are.
    expect(await beginCall("u-1", scn, at(12), { offerTrialSample: true })).toMatchObject({ ok: false, error: "minutes_reserved" });
    await endCall("u-1", again.callId, "failed_connect", at(15));
    // Another member of the same organization.
    const member = await begin("u-2", 20);
    expect(member.premium.source).toBeNull();
    await endCall("u-2", member.callId, "failed_connect", at(25));
    // Even with the trial call's row gone (a retention purge), the claim on the organization stays.
    await fake.db.trainerSession.deleteMany({ where: { id: first.callId } });
    const afterPurge = await begin("u-1", 30);
    expect(afterPurge.premium.source).toBeNull();
    await endCall("u-1", afterPurge.callId, "failed_connect", at(35));
    // The claim never moved, and only the first call ever ran as the trial.
    expect(org()).toMatchObject({ premiumTrialCallUsedAt: claimedAt, premiumTrialCallSessionId: first.callId });
    expect(fake.rows("trainerSession").filter((s) => s.organizationId === "org-free" && s.premiumTrial === true)).toHaveLength(0); // the trial row was purged
    expect(fake.rows("trainerSession").filter((s) => s.organizationId === "org-free").every((s) => s.voiceTier === "standard")).toBe(true);
    // A member of another Free organization still gets that organization's own trial.
    addOrg("org-other");
    addUser("u-9", "org-other");
    expect((await begin("u-9", 40)).premium.source).toBe("trial");
  });

  it("fail closed: a provider failure or a failed mint log consumes the trial; the retry is Standard", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    expect((await mintAs("u-1")).res.status).toBe(502);
    expect(org().premiumTrialCallUsedAt).toBeInstanceOf(Date);
    const [failed] = fake.rows("trainerSession");
    expect(failed).toMatchObject({ premiumTrial: true, endReason: "failed_connect", billedMinutes: 0 });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      models.push(JSON.parse(init.body as string).session.model);
      return new Response(JSON.stringify({ value: "ek_test", expires_at: 9999999999 }), { status: 200 });
    }));
    vi.setSystemTime(at(10));
    const retry = await mintAs("u-1");
    expect(retry.body).toMatchObject({ voiceTier: "standard" });
    expect(retry.body).not.toHaveProperty("voiceTrial");
    expect(models).toEqual(["model-standard-test"]);
  });

  it("only the OpenAI Realtime mint offers it: a call started without offerTrialSample (ElevenLabs) never claims", async () => {
    const r = await begin("u-1", 0, {});
    expect(r.premium.source).toBeNull();
    expect(org().premiumTrialCallUsedAt).toBeNull();
  });

  it("not for comped organizations, paid users, Stripe-trialing subscribers or org-less accounts", async () => {
    // Comped (Premium already): comped wins, nothing is claimed.
    addOrg("org-comped", { voiceModelTier: "premium", voiceModelComped: true });
    addUser("c-1", "org-comped", { organization: { voiceModelTier: "premium", voiceModelComped: true } });
    const comped = await begin("c-1", 0, { offerTrialSample: true, compedPremium: true });
    expect(comped.premium.source).toBe("comped");
    expect(org("org-comped").premiumTrialCallUsedAt).toBeNull();
    // A Pro subscriber in Stripe's `trialing` status with the add-on, with Premium off sale: Standard, no trial.
    addOrg("org-pro");
    addUser("p-1", "org-pro", { ...proPremium(), subscriptionStatus: "trialing" });
    const trialing = await begin("p-1");
    expect(trialing.premium.source).toBeNull();
    expect(org("org-pro").premiumTrialCallUsedAt).toBeNull();
    // A lapsed Pro still linked to its subscription resolves to Free but is not a trial account.
    addOrg("org-lapsed");
    addUser("l-1", "org-lapsed", { planTier: "pro", stripeSubscriptionId: "sub_test_lapsed", subscriptionStatus: "canceled" });
    expect((await begin("l-1")).premium.source).toBeNull();
    expect(org("org-lapsed").premiumTrialCallUsedAt).toBeNull();
    // Org-less: no organization to claim on, so no trial (metered voice also needs an organization).
    addUser("solo-1", null);
    const solo = await beginCall("solo-1", scn, at(0), { offerTrialSample: true });
    expect(solo).toMatchObject({ ok: false, error: "no_organization" });
    expect(trialRows()).toHaveLength(0);
  });
});

// ---- Flags --------------------------------------------------------------------------------------------------------

describe("PREMIUM_TRIAL_SAMPLE_ON and PREMIUM_VOICE_ON_SALE are independent (all four combinations)", () => {
  it.each([
    { sale: false, trial: false },
    { sale: true, trial: false },
    { sale: false, trial: true },
    { sale: true, trial: true },
  ])("sale $sale, trial $trial", async ({ sale, trial }) => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", sale ? "true" : "");
    vi.stubEnv(PREMIUM_TRIAL_SAMPLE_ENV, trial ? "true" : "");
    addOrg("org-pro");
    addUser("p-1", "org-pro", proPremium());

    const free = await mintAs("u-1");
    const paid = await mintAs("p-1");
    // The Free organization's call: Premium only through the trial flag.
    expect(free.body.voiceTier).toBe(trial ? "premium" : "standard");
    expect(free.body.voiceTrial).toBe(trial ? true : undefined);
    expect(org().premiumTrialCallUsedAt instanceof Date).toBe(trial);
    // The paid add-on subscriber: Premium only through the sale flag; never the trial.
    expect(paid.body.voiceTier).toBe(sale ? "premium" : "standard");
    expect(paid.body).not.toHaveProperty("voiceTrial");
    expect(org("org-pro").premiumTrialCallUsedAt).toBeNull();
    expect(models).toEqual([trial ? "model-premium-test" : "model-standard-test", sale ? "model-premium-test" : "model-standard-test"]);
  });

  it("default (unset) is off: no claim and Standard", async () => {
    // unstubAllEnvs in afterEach restores whatever was there before the beforeEach stub.
    delete process.env[PREMIUM_TRIAL_SAMPLE_ENV];
    expect(premiumTrialSampleOn()).toBe(false);
    const r = await begin("u-1");
    expect(r.premium.source).toBeNull();
    expect(org().premiumTrialCallUsedAt).toBeNull();
    expect(trialRows()).toHaveLength(0);
  });

  it("near misses of true are off", async () => {
    for (const v of ["TRUE", "1", "yes"]) {
      vi.stubEnv(PREMIUM_TRIAL_SAMPLE_ENV, v);
      expect((await begin("u-1", 0)).premium.source, v).toBeNull();
      await endCall("u-1", fake.rows("trainerSession").at(-1)!.id as string, "failed_connect", at(1));
    }
    expect(org().premiumTrialCallUsedAt).toBeNull();
  });
});

// ---- Deadline, completion, minutes ----------------------------------------------------------------------------------

describe("the trial call's deadline and minutes", () => {
  it("4: maxSeconds is 300 (the Free call's own deadline is 24 hours) and the secret lives no longer", async () => {
    const minted = await mintAs("u-1");
    expect(minted.body).toMatchObject({ voiceTier: "premium", voiceTrial: true, maxSeconds: 300, nextCallStandard: true });
    expect(ttls).toEqual([300]);
    // A later Standard Free call keeps the usual Free deadline.
    vi.setSystemTime(at(5));
    await endCall("u-1", minted.body.callId as string, "failed_connect", at(5));
    expect((await begin("u-1", 10)).maxSeconds).toBe(MAX_CALL_SECONDS);
  });

  it("4b: a lower existing deadline still wins, and then ends the call with its own reason", async () => {
    const r = await begin("u-1");
    // Make this call's existing limit 2 minutes (a capped reservation), below the 300 second trial cap.
    Object.assign(session(r.callId), { capEnforced: true, reservedMinutes: 2 });
    await heartbeat("u-1", r.callId, "connected", at(0));
    expect(await heartbeat("u-1", r.callId, "ok", at(110))).toMatchObject({ stop: false, secondsLeft: 10 });
    expect(await heartbeat("u-1", r.callId, "ok", at(120))).toMatchObject({ stop: true, reason: "cap_reached" });
  });

  it("9: at 300 seconds the call ends through the normal maximum-length path, not a quota error, and the next call is Standard", async () => {
    const minted = await mintAs("u-1");
    const callId = minted.body.callId as string;
    await heartbeat("u-1", callId, "connected", at(0));
    expect(await heartbeat("u-1", callId, "ok", at(290))).toMatchObject({ stop: false, secondsLeft: 10 });
    vi.setSystemTime(at(300));
    const res = await heartbeatRoute(new NextRequest("http://localhost/api/usage/heartbeat", { method: "POST", body: JSON.stringify({ callId, state: "ok" }), headers: { "content-type": "application/json" } }));
    const body = await res.json();
    expect(body).toEqual({ stop: true, reason: "max_duration", message: "This call reached the maximum call length." });
    expect(body.message).not.toBe(CAP_STOPPED_MESSAGE);
    expect(session(callId)).toMatchObject({ endReason: "max_duration", billedMinutes: 5, abuseFlagged: false });
    // 5: every later call is Standard, and it starts normally (the Free plan still has minutes).
    vi.setSystemTime(at(310));
    const next = await mintAs("u-1");
    expect(next.res.status).toBe(200);
    expect(next.body).toMatchObject({ voiceTier: "standard", nextCallStandard: false });
    expect(models).toEqual(["model-premium-test", "model-standard-test"]);
  });

  it("a browser that keeps the trial session running well past 300 seconds is flagged like any overrun", async () => {
    const r = await begin("u-1");
    await heartbeat("u-1", r.callId, "connected", at(0));
    await heartbeat("u-1", r.callId, "ok", at(300));
    expect(session(r.callId).endReason).toBe("max_duration");
    await heartbeat("u-1", r.callId, "ok", at(300 + 600));
    expect(session(r.callId).abuseFlagged).toBe(true);
  });

  it("6: the trial uses the plan's ordinary minutes and never the paid Premium pool", async () => {
    const r = await begin("u-1");
    const a = allowanceOf("u-1");
    expect(a).toMatchObject({ premiumMinutesCap: 0, premiumMinutesReserved: 0, premiumMinutesUsed: 0 });
    expect(a.minutesReserved).toBeGreaterThan(0);
    await heartbeat("u-1", r.callId, "connected", at(0));
    await endCall("u-1", r.callId, "user_hangup", at(180));
    expect(allowanceOf("u-1")).toMatchObject({ minutesUsed: 3, minutesReserved: 0, premiumMinutesReserved: 0, premiumMinutesUsed: 0 });
    expect(session(r.callId)).toMatchObject({ engineTier: "standard", premiumReservedMinutes: 0, billedMinutes: 3 });
  });

  it("6b: with Premium on sale, a paid subscriber's Premium pool is unchanged by another organization's trial", async () => {
    vi.stubEnv("PREMIUM_VOICE_ON_SALE", "true");
    addOrg("org-pro");
    addUser("p-1", "org-pro", proPremium());
    const paid = await begin("p-1");
    expect(paid.premium.source).toBe("paid");
    const before = { ...allowanceOf("p-1") };
    await begin("u-1", 5);
    const after = allowanceOf("p-1");
    expect({ cap: after.premiumMinutesCap, used: after.premiumMinutesUsed, reserved: after.premiumMinutesReserved })
      .toEqual({ cap: before.premiumMinutesCap, used: before.premiumMinutesUsed, reserved: before.premiumMinutesReserved });
  });

  it("the plan's minute cap still applies in a trial organization: an exhausted Free plan is refused, not offered Premium", async () => {
    await begin("u-1");
    const r2 = await begin("u-2", 5);
    expect(r2.premium.source).toBeNull();
    const a = allowanceOf("u-2");
    a.minutesUsed = a.minutesCap;
    await endCall("u-2", r2.callId, "failed_connect", at(6));
    expect(await beginCall("u-2", scn, at(10), { offerTrialSample: true })).toMatchObject({ ok: false, error: "cap_reached" });
  });
});

// ---- Labels -------------------------------------------------------------------------------------------------------

describe("8: neutral labels on the call screen and the session detail, no model ids", () => {
  it("the mint answer carries only tier labels; the stored row has the real model for the server", async () => {
    const minted = await mintAs("u-1");
    // The receipt is opaque random-looking base64url; everything else in the answer is checked as text.
    expect(JSON.stringify({ ...minted.body, receipt: null })).not.toMatch(MODEL_ID);
    expect(typeof minted.body.receipt).toBe("string");
    expect(Object.keys(minted.body).sort()).toEqual(["callId", "clientSecret", "expiresAt", "maxSeconds", "nextCallStandard", "receipt", "sessionId", "voice", "voiceTier", "voiceTrial"].sort());
    expect(voiceInfoFrom(minted.body)).toEqual({ tier: "premium", nextCallStandard: true, trial: true });
    // Durable provenance on the server: the actual model and the effective tier.
    expect(session(minted.body.callId as string)).toMatchObject({ realtimeModel: "model-premium-test", voiceTier: "premium", premiumTrial: true });
  });

  it("the session detail label reads Premium for the trial call and Standard for the next one", async () => {
    const trial = await mintAs("u-1");
    vi.setSystemTime(at(5));
    await endCall("u-1", trial.body.callId as string, "failed_connect", at(5));
    const next = await mintAs("u-1");
    const t = await voiceOf(trial.body.callId as string);
    const n = await voiceOf(next.body.callId as string);
    expect(t).toBe(JSON.stringify({ voiceUsed: "premium" }));
    expect(n).toBe(JSON.stringify({ voiceUsed: "standard" }));
    expect(t + n).not.toMatch(MODEL_ID);
    expect(voiceLabel("premium")).toBe("Premium voice");
  });

  it("the call screen shows the tier chip and the trial notice; the copy names no model and has no em dash", () => {
    expect(voiceInfoFrom({ voiceTier: "standard", voiceTrial: true })).toEqual({ tier: "standard", nextCallStandard: false, trial: false });
    expect(TRIAL_CALL_NOTICE).toMatch(/Premium voice trial call, up to 5 minutes\. Later calls use Standard voice\./);
    expect(TRIAL_CALL_NOTICE.includes(String.fromCharCode(0x2014))).toBe(false);
    expect(TRIAL_CALL_NOTICE).not.toMatch(/gpt-|model/i);
    const deck = readFileSync(path.join(process.cwd(), "src/components/call/Deck.tsx"), "utf8");
    expect(deck).toMatch(/<span className="chip">\{voiceLabel\(voice\.tier\)\}<\/span>/);
    expect(deck).toMatch(/voice\.trial \? TRIAL_CALL_NOTICE/);
    const client = readFileSync(path.join(process.cwd(), "src/components/TrainerClient.tsx"), "utf8");
    expect(client).toMatch(/trial: voiceInfo\?\.trial/);
  });
});
