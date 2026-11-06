import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * OpenAI key failover (src/lib/openaiKeys.ts) across chat, realtime voice and the connection check. Every fetch is
 * mocked; fixture keys are random placeholders built at runtime. The last describe scans everything these tests
 * logged, returned or threw for key bytes, provider body text, the custom base URL and model ids.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "kf-user-0", email: "kf-0@example.test" } as { id: string; email: string },
  beginCall: vi.fn(),
  endCall: vi.fn(),
  prisma: {
    trainerSession: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    auditEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: (u: { id: string }) => u.id === "demo-user" }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/usage", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/usage")>()), beginCall: mocks.beginCall, endCall: mocks.endCall }));

import {
  MAX_ERROR_BODY_BYTES, OPENAI_KEY_SLOT_VARS, OPENAI_QUOTA_ERROR_CODES, QUOTA_COOLDOWN_MS, chatKeyPlan, classifyOpenAiFailure,
  classifyOpenAiResponse, openAiErrorFields, openAiKeyHealth, openAiKeySlots, readBoundedBody, resetOpenAiKeyState,
  setKeyFailoverSink, voiceKeyPlan, type KeyFailoverEvent,
} from "@/lib/openaiKeys";
import { chatFull } from "@/lib/llm";
import { getCapabilities, llmKey } from "@/lib/serverConfig";
import { realtimeUpstreamMessage, resolveRealtimeKey } from "@/lib/realtime";
import { verifyMintReceipt } from "@/lib/mintReceipt";
import { coachTurn } from "@/lib/coach";
import { evaluateCall } from "@/lib/grader";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { POST as sessionPOST } from "@/app/api/realtime/session/route";
import { POST as checkPOST } from "@/app/api/llm/check/route";
import { POST as simulatePOST } from "@/app/api/simulate/turn/route";
import { PATCH as regradePATCH } from "@/app/api/transcripts/[id]/route";

/* ---------- Fixtures (fake, random per run) ---------- */

const hex = (n: number) => randomBytes(n).toString("hex");
const KEYS = [0, 1, 2].map((i) => `${hex(8)}fixturekeyslot${i}${hex(8)}`);
const REALTIME_KEY = `${hex(8)}fixturekeyrealtime${hex(8)}`;
const LLM_KEY = `${hex(8)}fixturekeyllm${hex(8)}`;
const ALL_KEYS = [...KEYS, REALTIME_KEY, LLM_KEY];
const MARKER = `PROVIDERBODYMARKER${hex(6)}`;
const CUSTOM_BASE = "https://llm.custom-fixture.example/v1";
const ATTACKER_BASE = "https://api.openai.com.attacker.example/v1";
const CLIENT_SECRETS = "https://api.openai.com/v1/realtime/client_secrets";
const CHAT_URL = "https://api.openai.com/v1/chat/completions";
const JWT = "fixture-only-not-a-secret-0123456789abcdef";
const CALL_ID = "callfixture0001";
/** Same model id families as tests/no-model-labels.test.ts. */
const MODEL_ID_RE =
  /\b(?:[Gg][Pp][Tt]-(?:5|4\.1|4o|realtime)[\w.-]*|o[34](?:-[\w-]+)?|whisper-1|tts-1(?:-hd)?|gemini-[\w.-]+|eleven_\w+|claude-[\w.-]+)\b/;

const ENV = [
  "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "OPENAI_REALTIME_API_KEY", ...OPENAI_KEY_SLOT_VARS, "DEMO_MODE", "DATABASE_URL",
  "USAGE_CAPS", "STRIPE_SECRET_KEY", "JWT_SECRET", "CRON_SECRET", "REALTIME_MODEL", "REALTIME_MODEL_STANDARD", "REALTIME_MODEL_PREMIUM",
  "REALTIME_VOICE", "RATE_LIMIT_GRADING_MAX", "RATE_LIMIT_CALLER_MAX", "RATE_LIMIT_REALTIME_MAX",
] as const;

/** Everything a test returned, threw or logged; scanned at the end. */
const OUTPUT: string[] = [];
let logs: { level: string; line: string }[] = [];
const fmt = (a: unknown) => (typeof a === "string" ? a : a instanceof Error ? `${a.name}: ${a.message}` : JSON.stringify(a) ?? String(a));

let n = 0;
const signIn = () => (mocks.user = { id: `kf-user-${++n}`, email: `kf-${n}@example.test` });
const ip = () => `203.0.113.${(n % 250) + 1}`;

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
  vi.stubEnv("RATE_LIMIT_CALLER_MAX", "1000");
  vi.stubEnv("RATE_LIMIT_REALTIME_MAX", "1000");
  resetOpenAiKeyState();
  signIn();
  mocks.beginCall.mockReset();
  mocks.endCall.mockReset();
  mocks.endCall.mockResolvedValue(null);
  for (const f of [mocks.prisma.trainerSession.findUnique, mocks.prisma.trainerSession.update, mocks.prisma.trainerSession.updateMany, mocks.prisma.user.findUnique, mocks.prisma.auditEvent.create, mocks.prisma.$transaction]) f.mockReset();
  logs = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logs.push({ level, line: args.map(fmt).join(" ") });
    });
  }
});

afterEach(() => {
  OUTPUT.push(...logs.map((l) => l.line));
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setKeyFailoverSink(null);
});

const slots = (...on: number[]) => on.forEach((i) => vi.stubEnv(OPENAI_KEY_SLOT_VARS[i], KEYS[i]));
const events = (name: string) => logs.filter((l) => l.line.startsWith("{")).map((l) => JSON.parse(l.line)).filter((e) => e.event === name);

/* ---------- Fetch mock ---------- */

type Call = { url: string; init: RequestInit; key: string; slot: number; i: number };
function stubFetch(handler: (c: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const key = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "").replace(/^Bearer /, "");
    const call = { url: String(url), init, key, slot: KEYS.indexOf(key), i: calls.length };
    calls.push(call);
    return handler(call);
  }));
  return calls;
}
/** One reply per slot (or per explicit key with slot -1). */
const bySlot = (replies: Record<number, () => Response | Promise<Response>>) =>
  stubFetch((c) => {
    const r = replies[c.slot];
    if (!r) throw new Error(`no reply scripted for slot ${c.slot}`);
    return r();
  });

const chatOk = () => Response.json({ choices: [{ message: { content: "Fixture reply." }, finish_reason: "stop" }] });
const secretOk = () => Response.json({ value: "ek_fixture_secret_0001", expires_at: 1_900_000_000 });
const errJson = (status: number, error: Record<string, unknown>) =>
  new Response(JSON.stringify({ error: { message: `${MARKER} You exceeded something. Fixture text.`, param: null, ...error } }), { status, headers: { "content-type": "application/json" } });
const quota = (status = 429, code = "insufficient_quota") => () => errJson(status, { type: "insufficient_quota", code });

async function rejects(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    OUTPUT.push(msg);
    return msg;
  }
  throw new Error("expected a rejection");
}
const ask = () => chatFull([{ role: "user", content: "Hello" }]);
async function text(res: Response) {
  const t = await res.text();
  OUTPUT.push(t);
  return t;
}

/* ---------- 1. Slots ---------- */

describe("key slots", () => {
  it("keeps the fixed order and skips unset and blank slots", () => {
    expect(openAiKeySlots({})).toEqual([]);
    expect(openAiKeySlots({ OPENAI_API_KEY: KEYS[0], OPENAI_API_KEY_BACKUP_1: KEYS[1], OPENAI_API_KEY_BACKUP_2: KEYS[2] }).map((s) => s.slot)).toEqual([0, 1, 2]);
    expect(openAiKeySlots({ OPENAI_API_KEY: "   ", OPENAI_API_KEY_BACKUP_1: KEYS[1] }).map((s) => s.slot)).toEqual([1]);
    expect(openAiKeySlots({ OPENAI_API_KEY_BACKUP_2: ` ${KEYS[2]} ` })).toEqual([{ slot: 2, key: KEYS[2] }]);
  });

  it("skips a slot that repeats an earlier value", () => {
    expect(openAiKeySlots({ OPENAI_API_KEY: KEYS[0], OPENAI_API_KEY_BACKUP_1: KEYS[0], OPENAI_API_KEY_BACKUP_2: KEYS[2] }).map((s) => s.slot)).toEqual([0, 2]);
    expect(openAiKeySlots({ OPENAI_API_KEY_BACKUP_1: KEYS[1], OPENAI_API_KEY_BACKUP_2: KEYS[1] }).map((s) => s.slot)).toEqual([1]);
    const health = openAiKeyHealth({ OPENAI_API_KEY: KEYS[0], OPENAI_API_KEY_BACKUP_1: KEYS[0] });
    expect(health.slots.map((s) => s.state)).toEqual(["unknown", "duplicate", "not_configured"]);
  });

  it("first use is slot 1 when slot 0 is unset", async () => {
    slots(1, 2);
    const calls = bySlot({ 1: chatOk });
    expect((await ask()).text).toBe("Fixture reply.");
    expect(calls.map((c) => c.slot)).toEqual([1]);
    expect(events("openai_key_served")).toEqual([{ event: "openai_key_served", surface: "chat", slot: 1 }]);
  });

  it("a duplicate is never sent twice after a quota answer", async () => {
    vi.stubEnv("OPENAI_API_KEY", KEYS[0]);
    vi.stubEnv("OPENAI_API_KEY_BACKUP_1", KEYS[0]);
    const calls = bySlot({ 0: quota() });
    expect(await rejects(ask())).toBe("LLM_QUOTA_EXHAUSTED");
    expect(calls).toHaveLength(1);
  });
});

/* ---------- Classifier ---------- */

describe("classifier", () => {
  it("needs a gated status and an allowlisted code or type", () => {
    for (const code of OPENAI_QUOTA_ERROR_CODES) {
      for (const status of [400, 401, 403, 429]) expect(classifyOpenAiFailure(status, code)).toBe("quota");
      for (const status of [404, 408, 409, 500, 502, 503, 504]) expect(classifyOpenAiFailure(status, code)).toBe("other");
    }
    expect(classifyOpenAiFailure(429, [undefined, "insufficient_quota"])).toBe("quota");
    for (const v of ["rate_limit_exceeded", "slow_down", "rate_limit_error", "invalid_api_key", "model_not_found", "", null, undefined, "INSUFFICIENT_QUOTA"]) {
      expect(classifyOpenAiFailure(429, v)).toBe("other");
    }
    // An ordinary rate-limit code wins over a quota type in the same body.
    expect(classifyOpenAiFailure(429, ["rate_limit_exceeded", "insufficient_quota"])).toBe("other");
    expect(classifyOpenAiFailure(429, ["slow_down", "insufficient_quota"])).toBe("other");
  });

  it("keeps only error.code and error.type, as strings of 64 characters or fewer", () => {
    expect(openAiErrorFields(JSON.stringify({ error: { code: "insufficient_quota", type: "insufficient_quota", message: MARKER } }))).toEqual({ code: "insufficient_quota", type: "insufficient_quota" });
    expect(openAiErrorFields(JSON.stringify({ error: { code: "x".repeat(65), type: 7 } }))).toEqual({ code: undefined, type: undefined });
    expect(openAiErrorFields("<html>insufficient_quota</html>")).toEqual({});
    expect(openAiErrorFields("")).toEqual({});
    expect(openAiErrorFields(JSON.stringify({ code: "insufficient_quota" }))).toEqual({});
    expect(openAiErrorFields("null")).toEqual({});
  });

  it("reads at most 8 KiB of a body", async () => {
    const big = new Response("a".repeat(MAX_ERROR_BODY_BYTES * 4), { status: 429 });
    expect((await readBoundedBody(big)).length).toBe(MAX_ERROR_BODY_BYTES);
    // A quota code that only appears past the bound is never seen, and the cut JSON does not parse.
    const late = new Response(JSON.stringify({ error: { message: "p".repeat(MAX_ERROR_BODY_BYTES), code: "insufficient_quota" } }), { status: 429 });
    expect(await classifyOpenAiResponse(CHAT_URL, late)).toBe("other");
    expect(await readBoundedBody(new Response(null, { status: 429 }))).toBe("");
  });

  it("classifies only responses from the exact OpenAI host", async () => {
    const body = () => errJson(429, { code: "insufficient_quota" });
    expect(await classifyOpenAiResponse(CHAT_URL, body())).toBe("quota");
    expect(await classifyOpenAiResponse(`${CUSTOM_BASE}/chat/completions`, body())).toBe("other");
    expect(await classifyOpenAiResponse(`${ATTACKER_BASE}/chat/completions`, body())).toBe("other");
    expect(await classifyOpenAiResponse("http://api.openai.com/v1/chat/completions", body())).toBe("other");
  });
});

/* ---------- 2. Triggers ---------- */

describe("failover triggers", () => {
  const cases: [string, number, Record<string, unknown>][] = [
    ...OPENAI_QUOTA_ERROR_CODES.map((code): [string, number, Record<string, unknown>] => [`code ${code}`, 429, { code, type: "insufficient_quota" }]),
    ["type insufficient_quota with no code", 429, { type: "insufficient_quota", code: null }],
    ["billing_not_active on 400", 400, { code: "billing_not_active", type: "invalid_request_error" }],
    ["account_deactivated on 401", 401, { code: "account_deactivated", type: "invalid_request_error" }],
    ["account_deactivated on 403", 403, { code: "account_deactivated", type: "invalid_request_error" }],
    ["billing_hard_limit_reached on 400", 400, { code: "billing_hard_limit_reached" }],
  ];

  it.each(cases)("%s moves 0 to 1 and 1 to 2, one fetch per slot", async (_label, status, error) => {
    slots(0, 1, 2);
    const calls = bySlot({ 0: () => errJson(status, error), 1: () => errJson(status, error), 2: chatOk });
    expect((await ask()).text).toBe("Fixture reply.");
    expect(calls.map((c) => c.slot)).toEqual([0, 1, 2]);
    for (const c of calls) {
      expect(c.url).toBe(CHAT_URL);
      expect(c.init.redirect).toBe("error");
    }
    expect(events("openai_key_failover")).toEqual([
      { event: "openai_key_failover", surface: "chat", from: 0, to: 1, reason: "quota", status },
      { event: "openai_key_failover", surface: "chat", from: 1, to: 2, reason: "quota", status },
    ]);
    expect(events("openai_key_served")).toEqual([{ event: "openai_key_served", surface: "chat", slot: 2 }]);
  });
});

/* ---------- 3. Non-triggers ---------- */

describe("non-triggers keep today's behaviour", () => {
  const html = () => new Response(`<html><body>${MARKER} insufficient_quota</body></html>`, { status: 429, headers: { "content-type": "text/html" } });
  const cases: [string, () => Response, string][] = [
    ["429 rate_limit_exceeded", () => errJson(429, { code: "rate_limit_exceeded", type: "requests" }), "LLM_HTTP_429"],
    ["429 slow_down", () => errJson(429, { code: "slow_down", type: "rate_limit_error" }), "LLM_HTTP_429"],
    ["429 rate_limit_error with no code", () => errJson(429, { type: "rate_limit_error", code: null }), "LLM_HTTP_429"],
    ["429 rate_limit_exceeded with an insufficient_quota type", () => errJson(429, { code: "rate_limit_exceeded", type: "insufficient_quota" }), "LLM_HTTP_429"],
    ["429 with an empty body", () => new Response("", { status: 429 }), "LLM_HTTP_429"],
    ["429 with an HTML body", html, "LLM_HTTP_429"],
    ["429 with an over-long code", () => errJson(429, { code: `insufficient_quota${"_".repeat(60)}` }), "LLM_HTTP_429"],
    ["500 saying insufficient_quota", quota(500), "LLM_HTTP_500"],
    ["502 saying insufficient_quota", quota(502), "LLM_HTTP_502"],
    ["503 saying insufficient_quota", quota(503), "LLM_HTTP_503"],
    ["401 invalid_api_key", () => errJson(401, { code: "invalid_api_key", type: "invalid_request_error" }), "LLM_HTTP_401"],
    ["403 model access", () => errJson(403, { code: "model_not_allowed", type: "invalid_request_error" }), "LLM_HTTP_403"],
    ["404 unknown model", () => errJson(404, { code: "model_not_found", type: "invalid_request_error" }), "LLM_HTTP_404"],
    ["400 bad request", () => errJson(400, { code: "invalid_value", type: "invalid_request_error" }), "LLM_HTTP_400"],
  ];

  it.each(cases)("%s: one fetch, no failover", async (_label, reply, message) => {
    slots(0, 1, 2);
    const calls = bySlot({ 0: reply });
    expect(await rejects(ask())).toBe(message);
    expect(calls.map((c) => c.slot)).toEqual([0]);
    expect(events("openai_key_failover")).toEqual([]);
    expect(openAiKeyHealth().slots[0]).toMatchObject({ state: "unknown" });
  });

  it.each([
    ["a network error", () => { throw new TypeError("fetch failed"); }, "fetch failed"],
    ["a timeout", () => { throw new DOMException("The operation timed out.", "TimeoutError"); }, "The operation timed out."],
  ])("%s: one fetch, the error propagates", async (_label, thrower, message) => {
    slots(0, 1, 2);
    const calls = stubFetch(thrower as () => Response);
    expect(await rejects(ask())).toBe(message);
    expect(calls).toHaveLength(1);
  });

  it("400 temperature keeps the same-slot retry and succeeds there", async () => {
    slots(0, 1, 2);
    const calls = stubFetch((c) => (c.i === 0 ? errJson(400, { code: "unsupported_parameter", param: "temperature", message: "Unsupported parameter: 'temperature'." }) : chatOk()));
    expect((await ask()).text).toBe("Fixture reply.");
    expect(calls.map((c) => c.slot)).toEqual([0, 0]);
    expect(JSON.parse(String(calls[0].init.body))).toHaveProperty("temperature");
    expect(JSON.parse(String(calls[1].init.body))).not.toHaveProperty("temperature");
  });

  it("400 temperature, then the retry is classified: a quota answer fails over", async () => {
    slots(0, 1, 2);
    const calls = stubFetch((c) =>
      c.i === 0 ? errJson(400, { code: "unsupported_parameter", message: "Unsupported parameter: 'temperature'." }) : c.slot === 0 ? quota()() : chatOk());
    expect((await ask()).text).toBe("Fixture reply.");
    expect(calls.map((c) => c.slot)).toEqual([0, 0, 1]);
  });

  it("400 temperature, then an ordinary error on the retry: same two fetches as today", async () => {
    slots(0, 1, 2);
    const calls = stubFetch((c) => errJson(400, { code: "unsupported_parameter", message: c.i === 0 ? "Unsupported parameter: 'temperature'." : "Something else." }));
    expect(await rejects(ask())).toBe("LLM_HTTP_400");
    expect(calls.map((c) => c.slot)).toEqual([0, 0]);
  });

  it("the explicit single-key path keeps the temperature retry without the ladder", async () => {
    vi.stubEnv("LLM_API_KEY", LLM_KEY);
    slots(0, 1, 2);
    const calls = stubFetch((c) => (c.i === 0 ? errJson(400, { message: "temperature is not supported" }) : chatOk()));
    expect((await ask()).text).toBe("Fixture reply.");
    expect(calls.map((c) => c.key)).toEqual([LLM_KEY, LLM_KEY]);
    expect(calls[0].init.redirect).toBeUndefined();
  });
});

/* ---------- 4. Exhaustion ---------- */

describe("every slot exhausted", () => {
  it("chatFull throws LLM_QUOTA_EXHAUSTED, logs once, then skips the cooling slots", async () => {
    slots(0, 1, 2);
    const calls = bySlot({ 0: quota(), 1: quota(), 2: quota() });
    expect(await rejects(ask())).toBe("LLM_QUOTA_EXHAUSTED");
    expect(calls.map((c) => c.slot)).toEqual([0, 1, 2]);
    expect(events("openai_key_exhausted")).toEqual([{ event: "openai_key_exhausted", surface: "chat", tried: [0, 1, 2], status: 429 }]);
    // During the cooldown nothing is sent at all.
    expect(await rejects(ask())).toBe("LLM_QUOTA_EXHAUSTED");
    expect(calls).toHaveLength(3);
    expect(events("openai_key_exhausted")).toHaveLength(1);
  });

  it("a single configured slot that runs out also reads as exhausted", async () => {
    slots(0);
    const calls = bySlot({ 0: quota() });
    expect(await rejects(ask())).toBe("LLM_QUOTA_EXHAUSTED");
    expect(calls).toHaveLength(1);
  });

  const exhaust = () => {
    slots(0, 1, 2);
    return bySlot({ 0: quota(), 1: quota(), 2: quota() });
  };

  it("the coach falls back to the rules-based coach", async () => {
    exhaust();
    const result = await coachTurn(BUILT_IN_SCENARIOS[0], [{ role: "assistant", text: "Hello?" }, { role: "user", text: "Hi, I can help you with that today." }], { allowCue: true });
    OUTPUT.push(JSON.stringify(result));
    expect(result.source).not.toBe("llm");
    expect(logs.some((l) => l.line.includes("LLM_QUOTA_EXHAUSTED"))).toBe(true);
  });

  it("the grader falls back to the heuristic grade", async () => {
    exhaust();
    const ev = await evaluateCall(BUILT_IN_SCENARIOS[0], [{ role: "assistant", text: "Hello?" }, { role: "user", text: "Hi, I can book a visit for tomorrow." }]);
    OUTPUT.push(JSON.stringify(ev));
    expect(ev.method).toBe("heuristic");
  });

  it("the text caller falls back to the scripted caller", async () => {
    exhaust();
    const res = await simulatePOST(new NextRequest("http://localhost/api/simulate/turn", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() },
      body: JSON.stringify({ scenario: BUILT_IN_SCENARIOS[0], history: [{ role: "user", text: "Hi, how can I help?" }] }),
    }));
    expect(res.status).toBe(200);
    expect(JSON.parse(await text(res)).source).toBe("scripted");
  });

  it("a re-grade returns the neutral 502 and keeps the stored grade", async () => {
    exhaust();
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
    const scenario = LIBRARY[0];
    mocks.prisma.trainerSession.findUnique.mockResolvedValue({
      id: "sess-kf-1", userId: "someone-else", organizationId: "org-kf", scenarioId: scenario.id, evaluation: null, overallScore: null, updatedAt: new Date(),
      transcript: [{ role: "assistant", text: "Hello?" }, { role: "user", text: "Hi, I can help you today." }],
    });
    mocks.prisma.user.findUnique.mockResolvedValue({ id: mocks.user.id, role: "manager", organizationId: "org-kf", isPlatformAdmin: false });
    const res = await regradePATCH(
      new NextRequest("http://localhost/api/transcripts/sess-kf-1", { method: "PATCH", body: "{}", headers: { "content-type": "application/json", "x-forwarded-for": ip() } }),
      { params: Promise.resolve({ id: "sess-kf-1" }) },
    );
    const body = JSON.parse(await text(res));
    expect(res.status).toBe(502);
    expect(body).toEqual({ error: "llm_failed", message: "AI grading didn't work this time, so the grade wasn't changed. Try again in a minute, or run Check connection in Settings, Models." });
    expect(body.message).not.toMatch(/slot|OPENAI_API_KEY|BACKUP|quota/i);
    expect(mocks.prisma.$transaction).not.toHaveBeenCalled();
  });
});

/* ---------- 5. Realtime ---------- */

describe("POST /api/realtime/session", () => {
  const scenario = BUILT_IN_SCENARIOS[0];
  const metered = () => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
    vi.stubEnv("USAGE_CAPS", "on");
    vi.stubEnv("JWT_SECRET", JWT);
    mocks.prisma.user.findUnique.mockResolvedValue(null);
    // A Standard mint under the Premium Voice contract: no paid, comped or trial Premium on this call.
    mocks.beginCall.mockResolvedValue({
      ok: true, callId: CALL_ID, remaining: 100, pooled: false, engine: "standard", maxSeconds: 300,
      premium: { source: null, cap: 0, leftAfter: 0, fallback: null, nextCallStandard: false },
    });
    // recordMintedVoice (src/lib/voiceMintLog.ts) must log exactly one row, or the route withholds the secret.
    mocks.prisma.trainerSession.updateMany.mockResolvedValue({ count: 1 });
  };
  const mint = () =>
    sessionPOST(new NextRequest("http://localhost/api/realtime/session", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip() }, body: JSON.stringify({ scenario }),
    }));
  // A metered mint also carries the neutral tier labels (voiceTrial only on a trial call, never here).
  const METERED_KEYS = ["callId", "clientSecret", "expiresAt", "maxSeconds", "nextCallStandard", "receipt", "sessionId", "voice", "voiceTier"];

  it("on exhaustion: 503 realtime_unavailable with Retry-After, beginCall once and endCall once with the same callId", async () => {
    metered();
    slots(0, 1, 2);
    const calls = bySlot({ 0: quota(), 1: quota(), 2: quota() });
    const res = await mint();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("300");
    expect(JSON.parse(await text(res))).toEqual({ error: "realtime_unavailable", message: "Voice is unavailable right now. Switch to Text to keep practising." });
    expect(calls.map((c) => [c.url, c.slot, c.init.redirect])).toEqual([[CLIENT_SECRETS, 0, "error"], [CLIENT_SECRETS, 1, "error"], [CLIENT_SECRETS, 2, "error"]]);
    expect(mocks.beginCall).toHaveBeenCalledTimes(1);
    expect(mocks.endCall).toHaveBeenCalledTimes(1);
    expect(mocks.endCall.mock.calls[0]).toEqual([mocks.user.id, CALL_ID, "failed_connect", expect.any(Date), { serverMintFailure: true }]);
    expect(events("openai_key_exhausted")).toEqual([{ event: "openai_key_exhausted", surface: "realtime", tried: [0, 1, 2], status: 429 }]);
  });

  it("failover success: 200, same key set as a plain mint, and the receipt opens for the same sessionId", async () => {
    metered();
    slots(0);
    bySlot({ 0: secretOk });
    const plain = JSON.parse(await text(await mint()));
    expect(Object.keys(plain).sort()).toEqual(METERED_KEYS);

    resetOpenAiKeyState();
    signIn();
    slots(0, 1, 2);
    mocks.beginCall.mockClear();
    const calls = bySlot({ 0: quota(429, "credit_balance_exhausted"), 1: secretOk });
    const res = await mint();
    const body = JSON.parse(await text(res));
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(METERED_KEYS);
    expect(body.sessionId).toBe(CALL_ID);
    expect(body.callId).toBe(CALL_ID);
    expect(body.maxSeconds).toBe(300);
    expect(body.voiceTier).toBe("standard");
    expect(body.nextCallStandard).toBe(false);
    expect(body).not.toHaveProperty("voiceTrial");
    expect(verifyMintReceipt(body.receipt, mocks.user.id, body.sessionId)).toEqual(expect.any(String));
    expect(calls.map((c) => c.slot)).toEqual([0, 1]);
    // Both attempts sent the same session payload.
    expect(calls[0].init.body).toBe(calls[1].init.body);
    expect(mocks.beginCall).toHaveBeenCalledTimes(1);
    expect(mocks.endCall).not.toHaveBeenCalled();
    expect(events("openai_key_failover")).toEqual([{ event: "openai_key_failover", surface: "realtime", from: 0, to: 1, reason: "quota", status: 429 }]);
    // The plain mint above was served by slot 0; this one by slot 1.
    expect(events("openai_key_served")).toEqual([{ event: "openai_key_served", surface: "realtime", slot: 0 }, { event: "openai_key_served", surface: "realtime", slot: 1 }]);
  });

  it("an ordinary upstream 429 still returns 429 with today's message, one fetch, endCall once", async () => {
    metered();
    slots(0, 1, 2);
    const calls = bySlot({ 0: () => errJson(429, { code: "rate_limit_exceeded", type: "requests" }) });
    const res = await mint();
    expect(res.status).toBe(429);
    expect(JSON.parse(await text(res))).toEqual({ error: "realtime_upstream_error", message: realtimeUpstreamMessage(429) });
    expect(calls).toHaveLength(1);
    expect(mocks.endCall).toHaveBeenCalledTimes(1);
  });

  it("a timeout does not fail over: one fetch, today's 502", async () => {
    metered();
    slots(0, 1, 2);
    const calls = stubFetch(() => { throw new DOMException("The operation timed out.", "TimeoutError"); });
    const res = await mint();
    expect(res.status).toBe(502);
    expect(JSON.parse(await text(res)).error).toBe("realtime_upstream_error");
    expect(calls).toHaveLength(1);
    expect(mocks.endCall).toHaveBeenCalledTimes(1);
  });

  it("an explicit OPENAI_REALTIME_API_KEY is used alone, even on a quota answer", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("OPENAI_REALTIME_API_KEY", REALTIME_KEY);
    slots(0, 1, 2);
    const calls = bySlot({ [-1]: quota() });
    const res = await mint();
    expect(res.status).toBe(429);
    expect(JSON.parse(await text(res)).error).toBe("realtime_upstream_error");
    expect(calls.map((c) => c.key)).toEqual([REALTIME_KEY]);
    expect(calls[0].init.redirect).toBeUndefined();
  });

  it("LLM_API_KEY is the last resort for voice only when no slot is set, as a single key", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    vi.stubEnv("LLM_API_KEY", LLM_KEY);
    expect(voiceKeyPlan(process.env)).toEqual({ kind: "single", key: LLM_KEY });
    slots(1);
    expect(voiceKeyPlan(process.env)).toMatchObject({ kind: "ladder" });
  });
});

/* ---------- 6. Cooldown and recovery ---------- */

describe("cooldown and recovery", () => {
  it("skips slot 0 during the cooldown, tries it first after, and logs the recovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    slots(0, 1, 2);
    let slot0 = quota();
    const calls = stubFetch((c) => (c.slot === 0 ? slot0() : chatOk()));

    await ask();
    expect(calls.map((c) => c.slot)).toEqual([0, 1]);
    expect(openAiKeyHealth().slots[0]).toMatchObject({ state: "quota_exhausted", exhaustedAt: "2026-11-05T12:00:00.000Z" });

    vi.setSystemTime(new Date(Date.now() + QUOTA_COOLDOWN_MS - 1));
    await ask();
    expect(calls.map((c) => c.slot)).toEqual([0, 1, 1]);

    slot0 = chatOk;
    vi.setSystemTime(new Date(Date.now() + 2));
    await ask();
    expect(calls.map((c) => c.slot)).toEqual([0, 1, 1, 0]);
    expect(events("openai_key_recovered")).toEqual([{ event: "openai_key_recovered", slot: 0 }]);
    expect(openAiKeyHealth().slots[0]).toMatchObject({ state: "ok", lastOkAt: expect.any(String) });
  });

  it("logs one failover line per pair per cooldown window when requests race", async () => {
    slots(0, 1);
    bySlot({ 0: quota(), 1: chatOk });
    await Promise.all([ask(), ask(), ask()]);
    expect(events("openai_key_failover")).toHaveLength(1);
    expect(openAiKeyHealth().lastFailover).toMatchObject({ from: 0, to: 1, surface: "chat" });
  });
});

/* ---------- 7. Compatibility boundaries ---------- */

describe("compatibility boundaries", () => {
  it("a custom LLM_BASE_URL never receives a slot key, from chat or the check", async () => {
    vi.stubEnv("LLM_BASE_URL", CUSTOM_BASE);
    slots(0, 1, 2);
    const calls = stubFetch(() => chatOk());
    expect(llmKey()).toBeUndefined();
    expect(chatKeyPlan(process.env)).toEqual({ kind: "none" });
    expect(getCapabilities()).toMatchObject({ llm: false, provider: "custom", realtime: true });
    expect(await rejects(ask())).toBe("LLM_NOT_CONFIGURED");
    const res = await checkPOST(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": ip() } }));
    expect(JSON.parse(await text(res))).toMatchObject({ ok: false, status: null });
    expect(calls).toEqual([]);
  });

  it("a custom provider imitating insufficient_quota cannot walk the OpenAI keys", async () => {
    vi.stubEnv("LLM_BASE_URL", CUSTOM_BASE);
    vi.stubEnv("LLM_API_KEY", LLM_KEY);
    slots(0, 1, 2);
    const calls = stubFetch(() => quota()());
    expect(await rejects(ask())).toBe("LLM_HTTP_429");
    expect(calls.map((c) => [c.url, c.key])).toEqual([[`${CUSTOM_BASE}/chat/completions`, LLM_KEY]]);
    for (const c of calls) for (const k of KEYS) expect(String((c.init.headers as Record<string, string>).Authorization)).not.toContain(k);
  });

  it("an explicit LLM_API_KEY on the OpenAI base is used alone: insufficient_quota is one fetch", async () => {
    vi.stubEnv("LLM_API_KEY", LLM_KEY);
    slots(0, 1, 2);
    const calls = stubFetch(() => quota()());
    expect(await rejects(ask())).toBe("LLM_HTTP_429");
    expect(calls.map((c) => c.key)).toEqual([LLM_KEY]);
  });

  it("the attacker-suffix base URL is custom on the chat and the realtime paths", async () => {
    vi.stubEnv("LLM_BASE_URL", ATTACKER_BASE);
    slots(0, 1, 2);
    const calls = stubFetch(() => chatOk());
    expect(llmKey()).toBeUndefined();
    expect(getCapabilities().provider).toBe("custom");
    expect(await rejects(ask())).toBe("LLM_NOT_CONFIGURED");
    expect(calls).toEqual([]);
    expect(resolveRealtimeKey({ LLM_API_KEY: LLM_KEY, LLM_BASE_URL: ATTACKER_BASE })).toBeUndefined();
    expect(voiceKeyPlan({ LLM_API_KEY: LLM_KEY, LLM_BASE_URL: ATTACKER_BASE })).toEqual({ kind: "none" });
  });

  it("capabilities: llm is true with only a backup slot on the OpenAI base, and /api/config fields are unchanged", () => {
    slots(1);
    const caps = getCapabilities();
    expect(caps).toMatchObject({ llm: true, realtime: true, provider: "openai", premiumOnSale: false });
    expect(Object.keys(caps).sort()).toEqual(["billing", "database", "demoMode", "elevenlabs", "hosted", "llm", "premiumOnSale", "provider", "realtime", "voiceEngines"]);
  });
});

/* ---------- Connection check ---------- */

describe("POST /api/llm/check with the key ladder", () => {
  const check = async () => {
    const res = await checkPOST(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": ip() } }));
    return { res, body: JSON.parse(await text(res)) as Record<string, unknown> };
  };

  it("fails over like a real request and never names the slot", async () => {
    slots(0, 1);
    const calls = bySlot({ 0: quota(), 1: chatOk });
    const { res, body } = await check();
    expect(res.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(["hint", "latencyMs", "ok", "status"]);
    expect(body).toMatchObject({ ok: true, status: 200 });
    expect(calls.map((c) => [c.slot, JSON.parse(String(c.init.body)).max_tokens])).toEqual([[0, 1], [1, 1]]);
    expect(events("openai_key_served")).toEqual([{ event: "openai_key_served", surface: "check", slot: 1 }]);
  });

  it("all slots exhausted: the 429 hint plus the billing sentence", async () => {
    slots(0, 1, 2);
    bySlot({ 0: quota(), 1: quota(), 2: quota() });
    const { body } = await check();
    expect(Object.keys(body).sort()).toEqual(["hint", "latencyMs", "ok", "status"]);
    expect(body).toMatchObject({ ok: false, status: 429 });
    expect(body.hint).toBe("The provider is rate limiting this key, or the account is out of quota. Check billing and usage limits, then try again. All configured OpenAI keys are out of quota. Check billing.");
  });

  it("an ordinary 429 keeps today's hint, one fetch", async () => {
    slots(0, 1, 2);
    const calls = bySlot({ 0: () => errJson(429, { code: "rate_limit_exceeded" }) });
    const { body } = await check();
    expect(body).toMatchObject({ ok: false, status: 429, hint: "The provider is rate limiting this key, or the account is out of quota. Check billing and usage limits, then try again." });
    expect(calls).toHaveLength(1);
  });
});

/* ---------- 10. Sink ---------- */

describe("failover sink", () => {
  it("gets slot-only events", async () => {
    const got: KeyFailoverEvent[] = [];
    setKeyFailoverSink((e) => void got.push(e));
    slots(0, 1, 2);
    bySlot({ 0: quota(), 1: quota(), 2: quota() });
    await rejects(ask());
    expect(got.map((e) => e.kind)).toEqual(["failover", "failover", "exhausted"]);
    for (const e of got) {
      expect(Object.keys(e).every((k) => ["kind", "surface", "from", "to", "tried", "slot", "at"].includes(k))).toBe(true);
      expect(new Date(e.at).toISOString()).toBe(e.at);
    }
    expect(got[2]).toMatchObject({ kind: "exhausted", surface: "chat", tried: [0, 1, 2] });
    OUTPUT.push(JSON.stringify(got));
  });

  it("a throwing or rejecting sink does not break the request", async () => {
    slots(0, 1);
    setKeyFailoverSink(() => { throw new Error(`sink exploded ${MARKER}`); });
    bySlot({ 0: quota(), 1: chatOk });
    expect((await ask()).text).toBe("Fixture reply.");
    resetOpenAiKeyState();
    setKeyFailoverSink(async () => { throw new Error("sink rejected"); });
    expect((await ask()).text).toBe("Fixture reply.");
    await new Promise((r) => setTimeout(r, 0));
    expect(events("openai_key_sink_failed").length).toBeGreaterThanOrEqual(2);
    // The sink's own error text is never logged.
    expect(logs.some((l) => l.line.includes("sink exploded") || l.line.includes("sink rejected"))).toBe(false);
  });

  it("no sink is a no-op", async () => {
    setKeyFailoverSink(null);
    slots(0, 1);
    bySlot({ 0: quota(), 1: chatOk });
    expect((await ask()).text).toBe("Fixture reply.");
  });
});

/* ---------- 8. Redaction scan (runs last) ---------- */

describe("redaction across every test above", () => {
  const ALLOWED = new Set(["event", "surface", "from", "to", "reason", "status", "tried", "slot"]);

  it("collected a real sample", () => {
    expect(OUTPUT.length).toBeGreaterThan(50);
    expect(OUTPUT.some((o) => o.includes("openai_key_failover"))).toBe(true);
  });

  it("no key, key prefix or suffix, provider body, custom base URL or model id in any log, response or thrown message", () => {
    const all = OUTPUT.join("\n");
    for (const k of ALL_KEYS) {
      expect(all).not.toContain(k);
      expect(all).not.toContain(k.slice(0, 6));
      expect(all).not.toContain(k.slice(-6));
    }
    expect(all).not.toContain(MARKER);
    expect(all).not.toContain("custom-fixture.example");
    expect(all).not.toContain("attacker.example");
    expect(all).not.toMatch(MODEL_ID_RE);
  });

  it("every structured line parses as JSON with only the allowed keys", () => {
    const structured = OUTPUT.filter((o) => o.startsWith("{") && o.includes('"event"'));
    expect(structured.length).toBeGreaterThan(10);
    for (const line of structured) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (typeof parsed.event !== "string" || !parsed.event.startsWith("openai_key_")) continue;
      expect(Object.keys(parsed).filter((k) => !ALLOWED.has(k))).toEqual([]);
    }
  });
});
