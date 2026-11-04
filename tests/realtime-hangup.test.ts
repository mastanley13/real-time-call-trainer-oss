import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { createFakePrisma } from "./fakePrisma";

// The database, the session check and the OpenAI API are the only fakes; metering, the routes and the sweep run for real.
const mocks = vi.hoisted(() => ({ fake: null as unknown as ReturnType<typeof import("./fakePrisma").createFakePrisma>, authId: "u-1" }));
vi.mock("@/lib/db", () => ({ prisma: new Proxy({}, { get: (_t, k) => (mocks.fake.db as Record<string | symbol, unknown>)[k] }) }));
vi.mock("@/lib/apiAuth", async () => ({
  requireAuth: () => ({ id: mocks.authId, email: `${mocks.authId}@example.test` }),
  isDemoUser: () => false,
}));

import { beginCall, endCall, ensureAllowance, heartbeat } from "@/lib/usage";
import { BUILT_IN_SCENARIOS, buildAgentPrompt } from "@/lib/scenarios";
import { hangupCall, PROVIDER_HANGUP_LEASE_MS } from "@/lib/providerHangup";
import { HARD_SESSION_CAP_SECONDS, PROVIDER_LIMIT_GRACE_SECONDS, providerDeadlineSeconds } from "@/lib/usagePlan";
import { POST as sessionRoute } from "@/app/api/realtime/session/route";
import { POST as sdpRoute } from "@/app/api/realtime/sdp/route";
import { POST as endRoute } from "@/app/api/usage/end/route";
import { GET as sweepRoute } from "@/app/api/cron/enforce-voice-deadlines/route";

const T0 = new Date("2026-10-15T12:00:00Z");
const MAR10 = new Date("2026-03-10T12:00:00Z");
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);
const scenario = BUILT_IN_SCENARIOS[0];
const scn = { id: scenario.id, title: scenario.title };
const API_KEY = "sk-test-not-real";
const CRON = "cron-test-secret-not-real";
const CALLS = "https://api.openai.com/v1/realtime/calls";

let fake: ReturnType<typeof createFakePrisma>;
let sent: { url: string; init: RequestInit }[];
let nextProviderId: number;
let openStatus: number;
let hangupStatus: number | "throw";
let n = 0;

/** Runs while the provider is "answering" an open request, to model things that happen during the call to OpenAI. */
let onOpen: (() => Promise<void>) | undefined;

const provider = async (url: string, init: RequestInit) => {
  sent.push({ url, init });
  if (!url.endsWith("/hangup") && onOpen) await onOpen();
  if (url.endsWith("/hangup")) {
    if (hangupStatus === "throw") throw new TypeError("fetch failed");
    return new Response("{}", { status: hangupStatus });
  }
  if (openStatus !== 201) return new Response(`{"error":"echo ${API_KEY}"}`, { status: openStatus });
  return new Response("v=0 answer", { status: 201, headers: { Location: `/v1/realtime/calls/rtc_${++nextProviderId}` } });
};
const opens = () => sent.filter((c) => !c.url.endsWith("/hangup"));
const hangups = () => sent.filter((c) => c.url.endsWith("/hangup")).map((c) => c.url.slice(CALLS.length + 1, -"/hangup".length));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${Math.floor(n / 250)}.${n % 250}`, ...headers } });
const sweep = (headers: Record<string, string> = { authorization: `Bearer ${CRON}` }) => sweepRoute(new NextRequest("http://localhost/api/cron/enforce-voice-deadlines", { headers }));

const session = (callId: string) => fake.rows("trainerSession").find((s) => s.id === callId)!;

/** A fresh user per test case so the per-user and per-IP rate limits (in-memory, shared by the file) never interfere. */
function newUser(extra: Record<string, unknown> = {}) {
  const id = `u-${++n}`;
  if (!fake.rows("organization").some((o) => o.id === "org-1")) fake.seed("organization", { id: "org-1", code: "123", createdAt: MAR10 });
  fake.seed("user", { id, email: `${id}@example.test`, organizationId: "org-1", usageAnchorAt: MAR10, createdAt: MAR10, ...extra });
  mocks.authId = id;
  return id;
}
const mint = async () => {
  const res = await sessionRoute(post("/api/realtime/session", { scenario }));
  return { res, body: await res.json() };
};
const offer = (callId: string | undefined, extra: Record<string, unknown> = {}) => sdpRoute(post("/api/realtime/sdp", { callId, sdp: "v=0 offer sdp", ...extra }));
/** Mint and connect one call; returns its id and the provider id the server stored. */
async function connectedCall() {
  const { body } = await mint();
  expect((await offer(body.callId)).status).toBe(200);
  await heartbeat(mocks.authId, body.callId, "connected", at(0));
  return { callId: body.callId as string, providerCallId: session(body.callId).providerCallId as string };
}

beforeEach(() => {
  fake = createFakePrisma();
  mocks.fake = fake;
  sent = [];
  nextProviderId = 0;
  openStatus = 201;
  hangupStatus = 200;
  onOpen = undefined;
  vi.stubGlobal("fetch", vi.fn(provider));
  vi.stubEnv("DATABASE_URL", "postgresql://ci:ci@localhost:5432/ci");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_placeholder");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("OPENAI_API_KEY", API_KEY);
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("CRON_SECRET", CRON);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("POST /api/realtime/session", () => {
  it("returns the call id, length, model and voice and no secret of any kind, and calls no provider", async () => {
    newUser();
    const { res, body } = await mint();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["callId", "maxSeconds", "model", "voice"]);
    expect(JSON.stringify(body)).not.toMatch(/ek_|sk-|secret/i);
    expect(sent).toHaveLength(0);
    // The validated persona is held server-side for the provider session; it is not in the response.
    expect(session(body.callId).providerSession).toMatchObject({ id: scenario.id });
  });
});

describe("POST /api/realtime/sdp", () => {
  it("posts multipart with the server API key, and stores the provider call id from the Location header", async () => {
    newUser();
    const { body } = await mint();
    const res = await offer(body.callId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ sdp: "v=0 answer" });
    expect(text).not.toContain("rtc_1");
    expect(opens()).toHaveLength(1);
    const { url, init } = opens()[0];
    expect(url).toBe(CALLS);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    const form = init.body as FormData;
    expect(form.get("sdp")).toBe("v=0 offer sdp");
    expect(JSON.parse(form.get("session") as string)).toMatchObject({ type: "realtime", model: body.model });
    expect(session(body.callId).providerCallId).toBe("rtc_1");
    expect(hangups()).toEqual([]);
  });

  it("a second offer for the same call gets 409 and no second provider call is made", async () => {
    newUser();
    const { body } = await mint();
    expect((await offer(body.callId)).status).toBe(200);
    const again = await offer(body.callId);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("call_already_connected");
    expect(opens()).toHaveLength(1);
    expect(session(body.callId).providerCallId).toBe("rtc_1");
  });

  it("two offers racing for one call: one claims the mint and calls OpenAI, the other gets 409 without any provider call", async () => {
    newUser();
    const { body } = await mint();
    const [a, b] = await Promise.all([offer(body.callId), offer(body.callId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(opens()).toHaveLength(1);
    expect(hangups()).toEqual([]);
    expect(session(body.callId).providerCallId).toBe("rtc_1");
  });

  it("a losing request cannot settle the mint: the owner's call stays open and reserved when a racing offer fails", async () => {
    const id = newUser();
    const { body } = await mint();
    expect((await offer(body.callId)).status).toBe(200);
    openStatus = 401; // would fail if it ever reached OpenAI
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await offer(body.callId)).status).toBe(409);
    expect(opens()).toHaveLength(1);
    expect(session(body.callId).endedAt ?? null).toBeNull();
    expect(fake.rows("usageAllowance").find((a) => a.userId === id)).toMatchObject({ minutesReserved: 10 });
  });

  it("a claim with no call id (an owner that crashed) is never retaken, so no second provider call opens", async () => {
    newUser();
    const { body } = await mint();
    session(body.callId).providerConnectClaimAt = at(0);
    expect((await offer(body.callId)).status).toBe(409);
    expect(sent).toHaveLength(0);
  });

  it("the owner stores the call id even when the call ended while OpenAI answered, then hangs it up", async () => {
    const id = newUser();
    const { body } = await mint();
    onOpen = async () => { await endCall(id, body.callId, "user_hangup", T0); };
    const res = await offer(body.callId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("call_ended");
    expect(session(body.callId).providerCallId).toBe("rtc_1");
    expect(hangups()).toEqual(["rtc_1"]);
    expect(session(body.callId).providerHangupAt).toBeTruthy();
  });

  it("the provider session is built from the persona stored at mint; a persona sent with the offer is ignored", async () => {
    newUser();
    const { body } = await mint();
    const evil = { ...scenario, aiPersona: { ...scenario.aiPersona, name: "Mallory Injected" } };
    expect((await offer(body.callId, { scenario: evil })).status).toBe(200);
    const sentSession = JSON.parse((opens()[0].init.body as FormData).get("session") as string);
    expect(sentSession.instructions).toBe(buildAgentPrompt(scenario));
    expect(sentSession.instructions).not.toContain("Mallory Injected");
  });

  it("another user's call id is not found, and no provider call is made", async () => {
    newUser();
    const { body } = await mint();
    newUser();
    const res = await offer(body.callId);
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
    expect(session(body.callId).providerCallId ?? null).toBeNull();
  });

  it("an ended call gets 409", async () => {
    const id = newUser();
    const { body } = await mint();
    await endCall(id, body.callId, "user_hangup", T0);
    const res = await offer(body.callId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("call_ended");
    expect(sent).toHaveLength(0);
  });

  it("a mint older than 600 seconds gets 409; at exactly 600 it still connects", async () => {
    newUser();
    const stale = (await mint()).body;
    vi.setSystemTime(at(601));
    const res = await offer(stale.callId);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("realtime_session_expired");
    expect(sent).toHaveLength(0);

    newUser();
    vi.setSystemTime(at(1000));
    const edge = (await mint()).body;
    vi.setSystemTime(at(1600));
    expect((await offer(edge.callId)).status).toBe(200);
  });

  it("with metering on, an offer with no call id is refused and nothing is opened", async () => {
    newUser();
    expect((await offer(undefined)).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("a provider failure settles the call as a failed connect (never charged) and echoes no upstream body", async () => {
    const id = newUser();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { body } = await mint();
    openStatus = 401;
    const res = await offer(body.callId);
    const text = await res.text();
    expect(res.status).toBe(502);
    expect(text).not.toContain(API_KEY);
    expect(session(body.callId)).toMatchObject({ endReason: "failed_connect", billedMinutes: 0 });
    expect(session(body.callId).providerCallId ?? null).toBeNull();
    expect(fake.rows("usageAllowance").find((a) => a.userId === id)).toMatchObject({ minutesUsed: 0, minutesReserved: 0 });
  });
});

describe("server hangup triggers", () => {
  it("a heartbeat the server answers with stop:true hangs the call up once, and later heartbeats send nothing more", async () => {
    const id = newUser({ planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: id }, at(0));
    fake.rows("usageAllowance").find((a) => a.userId === id)!.minutesUsed = 198; // 2 minutes left: a 120 second call
    const { callId, providerCallId } = await connectedCall();
    expect(await heartbeat(id, callId, "ok", at(60))).toMatchObject({ stop: false });
    expect(hangups()).toEqual([]);
    expect(await heartbeat(id, callId, "ok", at(120))).toMatchObject({ stop: true, reason: "cap_reached" });
    expect(hangups()).toEqual([providerCallId]);
    expect(session(callId).providerHangupAt).toBeTruthy();
    expect(await heartbeat(id, callId, "ok", at(130))).toMatchObject({ stop: true, reason: "ended" });
    expect(hangups()).toEqual([providerCallId]);
  });

  it("a Free call is hung up at the 30 minute hard ceiling plus grace, once, even though its own limit is 24 hours", async () => {
    const id = newUser();
    const { callId, providerCallId } = await connectedCall();
    expect(session(callId).reservedMinutes).toBe(10);
    const deadline = providerDeadlineSeconds(24 * 60 * 60);
    expect(deadline).toBe(HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS);
    expect(await heartbeat(id, callId, "ok", at(deadline - 1))).toMatchObject({ stop: false });
    expect(hangups()).toEqual([]);
    // At the deadline the call is also settled (max_duration, server clock) and stopped, so the reservation is released.
    expect(await heartbeat(id, callId, "ok", at(deadline))).toMatchObject({ stop: true, reason: "max_duration" });
    expect(session(callId)).toMatchObject({ endReason: "max_duration" });
    expect(session(callId).endedAt).toBeTruthy();
    expect(fake.rows("usageAllowance").find((a) => a.userId === id)).toMatchObject({ minutesReserved: 0 });
    expect(await heartbeat(id, callId, "ok", at(deadline + 10))).toMatchObject({ stop: true, reason: "ended" });
    expect(hangups()).toEqual([providerCallId]);
  });

  it("a Pro call reserving 60 minutes is settled and hung up at the 30 minute deadline, not billed past it", async () => {
    const id = newUser({ planTier: "pro" });
    const { callId, providerCallId } = await connectedCall();
    expect(session(callId).reservedMinutes).toBe(60);
    const deadline = HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS;
    expect(await heartbeat(id, callId, "ok", at(deadline - 10))).toMatchObject({ stop: false });
    expect(await heartbeat(id, callId, "ok", at(deadline))).toMatchObject({ stop: true, reason: "max_duration" });
    expect(session(callId).billedMinutes).toBe(Math.ceil(deadline / 60));
    expect(fake.rows("usageAllowance").find((a) => a.userId === id)).toMatchObject({ minutesReserved: 0 });
    await heartbeat(id, callId, "ok", at(deadline + 600));
    expect(session(callId).billedMinutes).toBe(Math.ceil(deadline / 60));
    expect(hangups()).toEqual([providerCallId]);
  });

  it("a user hang-up through /api/usage/end also hangs the provider call up, once", async () => {
    newUser();
    const { callId, providerCallId } = await connectedCall();
    const end = () => endRoute(post("/api/usage/end", { callId, reason: "user_hangup" }));
    expect((await end()).status).toBe(200);
    expect(hangups()).toEqual([providerCallId]);
    expect((await end()).status).toBe(200);
    expect(hangups()).toEqual([providerCallId]);
  });

  it("settling a silent call with a server reason hangs it up (reaped by the owner's next mint)", async () => {
    const id = newUser();
    const { providerCallId } = await connectedCall();
    const next = await beginCall(id, scn, at(100)); // last heartbeat at 0, more than 30 s ago
    expect(next.ok).toBe(true);
    expect(hangups()).toEqual([providerCallId]);
  });

  it("a call with no provider id (text, ElevenLabs, never opened) sends no hangup", async () => {
    const id = newUser({ planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: id }, at(0));
    fake.rows("usageAllowance").find((a) => a.userId === id)!.minutesUsed = 198;
    const { body } = await mint();
    await heartbeat(id, body.callId, "connected", at(0));
    expect(await heartbeat(id, body.callId, "ok", at(120))).toMatchObject({ stop: true });
    expect(sent).toHaveLength(0);
  });

  it("a failed hangup is logged by status only, never throws, and is retried by the next trigger", async () => {
    const id = newUser();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { callId, providerCallId } = await connectedCall();
    const deadline = HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS;
    hangupStatus = 500;
    await expect(heartbeat(id, callId, "ok", at(deadline))).resolves.toMatchObject({ found: true });
    expect(log).toHaveBeenCalledWith("[realtime/hangup] upstream status", 500);
    expect(JSON.stringify(log.mock.calls)).not.toContain(API_KEY);
    expect(session(callId).providerHangupAt ?? null).toBeNull();

    hangupStatus = "throw";
    await expect(heartbeat(id, callId, "ok", at(deadline + 10))).resolves.toMatchObject({ found: true });
    expect(log).toHaveBeenCalledWith("[realtime/hangup]", "TypeError");
    expect(session(callId).providerHangupAt ?? null).toBeNull();

    hangupStatus = 200;
    await heartbeat(id, callId, "ok", at(deadline + 20));
    expect(session(callId).providerHangupAt).toBeTruthy();
    expect(hangups().at(-1)).toBe(providerCallId);
  });
});

describe("hangup lease", () => {
  it("completion is recorded only after the provider accepts; 404 (call already gone) counts as accepted and is never re-sent", async () => {
    newUser();
    const { callId } = await connectedCall();
    vi.spyOn(console, "error").mockImplementation(() => {});
    hangupStatus = 500;
    expect(await hangupCall(callId, at(10))).toBe(false);
    expect(session(callId).providerHangupAt ?? null).toBeNull();
    hangupStatus = 404;
    expect(await hangupCall(callId, at(11))).toBe(true);
    expect(session(callId).providerHangupAt).toBeTruthy();
    const count = hangups().length;
    expect(await hangupCall(callId, at(12))).toBe(false);
    expect(hangups()).toHaveLength(count);
  });

  it("an attempt that died holding the lease blocks others only until it expires, then the call is hung up", async () => {
    newUser();
    const { callId, providerCallId } = await connectedCall();
    session(callId).providerHangupLeaseAt = at(0); // a crashed attempt: lease taken, nothing recorded
    expect(await hangupCall(callId, at(30))).toBe(false);
    expect(hangups()).toEqual([]);
    expect(await hangupCall(callId, at(PROVIDER_HANGUP_LEASE_MS / 1000 + 1))).toBe(true);
    expect(hangups()).toEqual([providerCallId]);
    expect(session(callId).providerHangupAt).toBeTruthy();
  });

  it("the sweep leaves a leased call to its attempt and picks it up once the lease expires", async () => {
    newUser();
    const { callId, providerCallId } = await connectedCall();
    const deadline = HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS;
    session(callId).providerHangupLeaseAt = at(deadline);
    vi.setSystemTime(at(deadline + 30));
    expect(await (await sweep()).json()).toMatchObject({ due: 0 });
    expect(hangups()).toEqual([]);
    vi.setSystemTime(at(deadline + PROVIDER_HANGUP_LEASE_MS / 1000 + 1));
    expect(await (await sweep()).json()).toMatchObject({ due: 1, hungUp: 1 });
    expect(hangups()).toEqual([providerCallId]);
  });
});

describe("GET /api/cron/enforce-voice-deadlines", () => {
  it("requires the CRON_SECRET bearer: no header, a wrong one, or no secret configured is 401 and does nothing", async () => {
    newUser();
    await connectedCall();
    vi.setSystemTime(at(HARD_SESSION_CAP_SECONDS + 60));
    sent = [];
    expect((await sweep({})).status).toBe(401);
    expect((await sweep({ authorization: "Bearer wrong" })).status).toBe(401);
    expect((await sweep({ "x-vercel-cron": "1" })).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "");
    expect((await sweep()).status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("an overdue call is hung up and settled once; a second run does nothing", async () => {
    const id = newUser();
    const { callId, providerCallId } = await connectedCall();
    vi.setSystemTime(at(HARD_SESSION_CAP_SECONDS + PROVIDER_LIMIT_GRACE_SECONDS + 5));
    const first = await (await sweep()).json();
    expect(first).toMatchObject({ ok: true, due: 1, hungUp: 1, settled: 1 });
    expect(hangups()).toEqual([providerCallId]);
    expect(session(callId)).toMatchObject({ endReason: "max_duration" });
    expect(session(callId).endedAt).toBeTruthy();
    expect(session(callId).providerHangupAt).toBeTruthy();
    expect(fake.rows("usageAllowance").find((a) => a.userId === id)).toMatchObject({ minutesReserved: 0 });

    const second = await (await sweep()).json();
    expect(second).toMatchObject({ ok: true, due: 0, hungUp: 0, settled: 0 });
    expect(hangups()).toEqual([providerCallId]);
  });

  it("a call that is not due yet is untouched", async () => {
    newUser();
    const { callId } = await connectedCall();
    vi.setSystemTime(at(600));
    await heartbeat(mocks.authId, callId, "ok", at(595));
    sent = [];
    expect(await (await sweep()).json()).toMatchObject({ ok: true, scanned: 1, due: 0, hungUp: 0, settled: 0 });
    expect(sent).toHaveLength(0);
    expect(session(callId).endedAt ?? null).toBeNull();
    expect(session(callId).providerHangupAt ?? null).toBeNull();
  });

  it("a call whose client went silent is hung up and settled as heartbeat_timeout with no client request", async () => {
    newUser();
    const { callId, providerCallId } = await connectedCall();
    vi.setSystemTime(at(100)); // last heartbeat at 0
    expect(await (await sweep()).json()).toMatchObject({ due: 1, hungUp: 1, settled: 1 });
    expect(hangups()).toEqual([providerCallId]);
    expect(session(callId)).toMatchObject({ endReason: "heartbeat_timeout" });
  });

  it("a call the server already settled whose hangup failed is hung up again, and not settled twice", async () => {
    const id = newUser({ planTier: "pro" });
    await ensureAllowance(fake.db as never, { userId: id }, at(0));
    fake.rows("usageAllowance").find((a) => a.userId === id)!.minutesUsed = 198;
    const { callId, providerCallId } = await connectedCall();
    vi.spyOn(console, "error").mockImplementation(() => {});
    hangupStatus = 503;
    await heartbeat(id, callId, "ok", at(120)); // cap_reached; the hangup fails
    expect(session(callId).providerHangupAt ?? null).toBeNull();
    const billed = session(callId).billedMinutes;

    hangupStatus = 200;
    vi.setSystemTime(at(125));
    expect(await (await sweep()).json()).toMatchObject({ due: 1, hungUp: 1, settled: 0 });
    expect(hangups().at(-1)).toBe(providerCallId);
    expect(session(callId).billedMinutes).toBe(billed);
  });

  it("acts on at most 50 calls per run and picks up the rest on the next", async () => {
    newUser();
    for (let i = 0; i < 55; i++) {
      fake.seed("trainerSession", {
        id: `old-${i}`, userId: mocks.authId, organizationId: "org-1", scenarioId: scenario.id, transcript: [],
        createdAt: at(i), endedAt: at(60), endReason: "max_duration", providerCallId: `rtc_old_${i}`,
      });
    }
    vi.setSystemTime(at(300));
    expect(await (await sweep()).json()).toMatchObject({ scanned: 55, due: 50, hungUp: 50 });
    expect(hangups()).toHaveLength(50);
    expect(await (await sweep()).json()).toMatchObject({ scanned: 5, due: 5, hungUp: 5 });
    expect(new Set(hangups()).size).toBe(55);
    expect(await (await sweep()).json()).toMatchObject({ scanned: 0, due: 0 });
  });

  it("does nothing without a database", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await sweep();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: true });
  });
});
