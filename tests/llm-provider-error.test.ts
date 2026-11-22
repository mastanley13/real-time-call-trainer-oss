import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Redacted provider diagnostics and the /api/health outcome they feed: providerErrorFields keeps only allowlisted
 * error type and code values ("other" for anything else), chatFull logs exactly one line with them on a failed
 * response, a stalled error body cannot delay LLM_HTTP_<status>, a quota answer on an explicit key records "quota",
 * and an exhausted ladder records "quota" only when this call actually got a quota answer. No network: fetch is stubbed.
 */

const mocks = vi.hoisted(() => ({ user: { id: "pe-user-0", email: "pe@example.test" } }));
vi.mock("@/lib/apiAuth", () => ({ requireAuth: () => mocks.user, isDemoUser: () => false }));

import { POST as checkPOST } from "@/app/api/llm/check/route";
import { DIAGNOSTIC_BODY_TIMEOUT_MS, chatFull, llmFailureOutcome, providerErrorFields } from "@/lib/llm";
import { getLlmStatus, resetLlmStatus } from "@/lib/llmStatus";
import { OPENAI_KEY_SLOT_VARS, OPENAI_QUOTA_ERROR_CODES, resetOpenAiKeyState } from "@/lib/openaiKeys";

const hex = (n: number) => randomBytes(n).toString("hex");
const KEY = `${hex(8)}fixturellmkey${hex(8)}`;
const FAKE_KEY = `sk-ant-api03-${hex(12)}`;
const MODEL = "fixture-model-id";
const BASE = "https://llm.fixture.example/v1";
const ENV = ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", ...OPENAI_KEY_SLOT_VARS] as const;
const NONE = { type: null, code: null };

describe("providerErrorFields", () => {
  it("reads the OpenAI shape", () => {
    const body = JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error", param: null, code: "invalid_api_key" } });
    expect(providerErrorFields(body)).toEqual({ type: "invalid_request_error", code: "invalid_api_key" });
  });

  it("reads the Anthropic shape, preferring error.type over the generic top-level type", () => {
    const body = JSON.stringify({ type: "error", error: { type: "authentication_error", message: `invalid x-api-key ${FAKE_KEY}` } });
    expect(providerErrorFields(body)).toEqual({ type: "authentication_error", code: null });
  });

  it("reads the Anthropic OpenAI-compatible shape", () => {
    const body = JSON.stringify({ error: { code: "authentication_error", type: "invalid_request_error", message: "Invalid Anthropic API Key" } });
    expect(providerErrorFields(body)).toEqual({ type: "invalid_request_error", code: "authentication_error" });
  });

  it("uses a top-level type only when error.type is missing and it is not the generic error", () => {
    expect(providerErrorFields(JSON.stringify({ type: "overloaded_error" }))).toEqual({ type: "overloaded_error", code: null });
    expect(providerErrorFields(JSON.stringify({ type: "error" }))).toEqual(NONE);
    expect(providerErrorFields(JSON.stringify({ type: "error", error: { message: "x" } }))).toEqual(NONE);
  });

  it("passes every OpenAI quota code through", () => {
    for (const c of OPENAI_QUOTA_ERROR_CODES) expect(providerErrorFields(JSON.stringify({ error: { type: c, code: c } }))).toEqual({ type: c, code: c });
  });

  it("logs any value outside the allowlist as other, including key-shaped and numeric values", () => {
    expect(providerErrorFields(JSON.stringify({ error: { type: "invalid_request_error", code: "sk-secret123" } }))).toEqual({ type: "invalid_request_error", code: "other" });
    expect(providerErrorFields(JSON.stringify({ error: { type: FAKE_KEY, code: 401 } }))).toEqual({ type: "other", code: "other" });
    expect(providerErrorFields(JSON.stringify({ error: { type: "a".repeat(65), code: "invalid key with spaces" } }))).toEqual({ type: "other", code: "other" });
    expect(providerErrorFields(JSON.stringify({ error: { type: { nested: "x" }, code: ["invalid_api_key"] } }))).toEqual({ type: "other", code: "other" });
    expect(providerErrorFields(JSON.stringify({ error: { type: "", code: true } }))).toEqual({ type: "other", code: "other" });
    expect(providerErrorFields(JSON.stringify({ type: "custom_vendor_error" }))).toEqual({ type: "other", code: null });
  });

  it("treats missing and null as null", () => {
    expect(providerErrorFields(JSON.stringify({ error: { type: null, code: null, message: "x" } }))).toEqual(NONE);
    expect(providerErrorFields(JSON.stringify({ error: { message: "x" } }))).toEqual(NONE);
  });

  it("returns nulls for non-JSON, empty, array, null and primitive bodies", () => {
    for (const body of ["", "<html><body>401 Unauthorized</body></html>", "Unauthorized", "[]", "null", "42", '"error"', '{"error":', '{"error":"invalid_api_key"}', '{"error":["a"]}']) {
      expect(providerErrorFields(body), body).toEqual(NONE);
    }
  });

  it("never returns the message or any other field", () => {
    const body = JSON.stringify({ error: { type: "invalid_request_error", code: FAKE_KEY, message: `Bad key ${FAKE_KEY}`, param: FAKE_KEY }, request_id: FAKE_KEY });
    const out = JSON.stringify(providerErrorFields(body));
    expect(out).not.toContain(FAKE_KEY);
    expect(out).not.toContain("Bad key");
  });
});

describe("llmFailureOutcome", () => {
  const f = (type: string | null, code: string | null) => ({ type, code });
  it("a 429 with a quota type or code is quota", () => {
    expect(llmFailureOutcome(429, f("insufficient_quota", "insufficient_quota"))).toBe("quota");
    expect(llmFailureOutcome(429, f("insufficient_quota", null))).toBe("quota");
    expect(llmFailureOutcome(429, f(null, "credit_balance_exhausted"))).toBe("quota");
  });

  it("an ordinary rate-limit code wins, and other 429s are errors", () => {
    expect(llmFailureOutcome(429, f("insufficient_quota", "rate_limit_exceeded"))).toBe("error");
    expect(llmFailureOutcome(429, f("rate_limit_error", null))).toBe("error");
    expect(llmFailureOutcome(429, f("other", "other"))).toBe("error");
    expect(llmFailureOutcome(429, NONE)).toBe("error");
  });

  it("only a 429 can be quota", () => {
    expect(llmFailureOutcome(401, f("insufficient_quota", "account_deactivated"))).toBe("auth_failed");
    expect(llmFailureOutcome(500, f("insufficient_quota", "insufficient_quota"))).toBe("error");
  });
});

let errors: unknown[][];
let n = 0;
beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("LLM_API_KEY", KEY);
  vi.stubEnv("LLM_BASE_URL", BASE);
  vi.stubEnv("LLM_MODEL", MODEL);
  resetLlmStatus();
  resetOpenAiKeyState();
  mocks.user = { id: `pe-user-${++n}`, email: `pe-${n}@example.test` };
  errors = [];
  for (const level of ["log", "info", "warn"] as const) vi.spyOn(console, level).mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ask = () => chatFull([{ role: "user", content: "Fixture prompt text" }]);
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reply = (status: number, body: unknown) => vi.fn(async () => json(status, body));
const quota429 = () => json(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota." } });
const logged = () => JSON.stringify(errors);
/** Switch from the explicit key to the OpenAI key ladder with one slot. */
const ladder = () => {
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("LLM_BASE_URL", "");
  vi.stubEnv("OPENAI_API_KEY", KEY);
};
const check = async () => {
  const res = await checkPOST(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": `198.51.100.${(n % 250) + 1}` } }));
  return { res, body: (await res.json()) as Record<string, unknown> };
};
/** A body nobody read yet is read detached after the throw, so its log line lands a moment later. */
const loggedOnce = () => vi.waitFor(() => expect(errors).toHaveLength(1));

describe("chatFull logs one redacted line on a failed response", () => {
  it("a 401 logs status, type and code, and nothing from the message", async () => {
    vi.stubGlobal("fetch", reply(401, { error: { code: "authentication_error", type: "invalid_request_error", message: `Invalid Anthropic API Key ${FAKE_KEY}` } }));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_401$/);
    await loggedOnce();
    expect(errors).toEqual([["[llm] provider error", { status: 401, type: "invalid_request_error", code: "authentication_error" }]]);
    const all = logged();
    for (const secret of ["Invalid Anthropic API Key", FAKE_KEY, KEY, MODEL, BASE, "llm.fixture.example", "Fixture prompt text"]) expect(all).not.toContain(secret);
  });

  it("a code outside the allowlist, such as sk-secret123, logs as other", async () => {
    vi.stubGlobal("fetch", reply(401, { error: { type: "invalid_request_error", code: "sk-secret123", message: "nope" } }));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_401$/);
    await loggedOnce();
    expect(errors).toEqual([["[llm] provider error", { status: 401, type: "invalid_request_error", code: "other" }]]);
    expect(logged()).not.toContain("sk-secret123");
  });

  it("a non-JSON body logs nulls and still throws LLM_HTTP_<status>", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<html>${FAKE_KEY} Bad Gateway</html>`, { status: 502 })));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_502$/);
    await loggedOnce();
    expect(errors).toEqual([["[llm] provider error", { status: 502, ...NONE }]]);
    expect(logged()).not.toContain(FAKE_KEY);
  });

  it("a 400 already read for the temperature check is reused, not read again, and logged before the throw", async () => {
    const fetchMock = reply(400, { error: { type: "invalid_request_error", code: "invalid_api_key", message: "Bad input" } });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_400$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Synchronous: no wait needed.
    expect(errors).toEqual([["[llm] provider error", { status: 400, type: "invalid_request_error", code: "invalid_api_key" }]]);
  });

  it("the OpenAI key ladder reuses the body the failover classifier read, logged before the throw", async () => {
    ladder();
    const fetchMock = reply(401, { error: { type: "invalid_request_error", code: "invalid_api_key", message: `Incorrect API key provided: ${FAKE_KEY}` } });
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_401$/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Synchronous: no wait needed.
    expect(errors).toEqual([["[llm] provider error", { status: 401, type: "invalid_request_error", code: "invalid_api_key" }]]);
    expect(logged()).not.toContain(FAKE_KEY);
  });

  it("a success logs nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] })));
    await expect(ask()).resolves.toEqual({ text: "Hi", truncated: false });
    expect(errors).toEqual([]);
  });
});

describe("a stalled error body does not delay the failure", () => {
  /** A body that sends nothing and never ends; records whether it was cancelled. */
  const stalled = (status: number) => {
    const state = { cancelled: false };
    const body = new ReadableStream<Uint8Array>({ cancel: () => void (state.cancelled = true) });
    return { state, res: () => new Response(body, { status }) };
  };

  it("chatFull rejects with LLM_HTTP_500 at once; the log line and body cancel follow after the bound", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = stalled(500);
    vi.stubGlobal("fetch", vi.fn(async () => s.res()));
    // No timer has been advanced: the rejection cannot have waited on the diagnostics read.
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_500$/);
    // Health already has a provisional outcome from the status; the log line is still pending.
    expect(getLlmStatus()).toMatchObject({ last: "error", consecutiveFailures: 1 });
    expect(errors).toEqual([]);
    expect(s.state.cancelled).toBe(false);

    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_BODY_TIMEOUT_MS - 100);
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(s.state.cancelled).toBe(true);
    expect(errors).toEqual([["[llm] provider error", { status: 500, ...NONE }]]);
    // Refined in place: one failure, not two.
    expect(getLlmStatus()).toMatchObject({ last: "error", consecutiveFailures: 1 });
  });

  it("a stalled 429 rejects at once and stays a provisional error when the body never arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = stalled(429);
    vi.stubGlobal("fetch", vi.fn(async () => s.res()));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_429$/);
    expect(getLlmStatus().last).toBe("error");
    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_BODY_TIMEOUT_MS + 10);
    expect(errors).toEqual([["[llm] provider error", { status: 429, ...NONE }]]);
    expect(getLlmStatus()).toMatchObject({ last: "error", consecutiveFailures: 1 });
  });

  it("a late refinement never overwrites a newer call's outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = stalled(500);
    vi.stubGlobal("fetch", vi.fn(async () => s.res()));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_500$/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: "Hi" }, finish_reason: "stop" }] })));
    await expect(ask()).resolves.toMatchObject({ text: "Hi" });
    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_BODY_TIMEOUT_MS + 10);
    expect(getLlmStatus()).toMatchObject({ last: "ok", consecutiveFailures: 0 });
  });

  it("the bound is short: well under the 60 second request timeout", () => {
    expect(DIAGNOSTIC_BODY_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DIAGNOSTIC_BODY_TIMEOUT_MS).toBeLessThanOrEqual(2000);
  });
});

describe("quota is recorded for /api/health only when a quota answer arrived", () => {
  it("an explicit LLM_API_KEY that gets a 429 quota answer records quota, with the same error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => quota429()));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_429$/);
    await loggedOnce();
    // Provisional error, refined to quota once the body was read, still counted as one failure.
    expect(getLlmStatus()).toMatchObject({ last: "quota", consecutiveFailures: 1 });
    expect(errors).toEqual([["[llm] provider error", { status: 429, type: "insufficient_quota", code: "insufficient_quota" }]]);
  });

  it("an explicit LLM_API_KEY that gets an ordinary rate limit records error", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { type: "insufficient_quota", code: "rate_limit_exceeded" } }));
    await expect(ask()).rejects.toThrow(/^LLM_HTTP_429$/);
    await loggedOnce();
    expect(getLlmStatus().last).toBe("error");
  });

  it("the ladder records quota when this call's attempt got the quota answer", async () => {
    ladder();
    vi.stubGlobal("fetch", vi.fn(async () => quota429()));
    await expect(ask()).rejects.toThrow("LLM_QUOTA_EXHAUSTED");
    expect(getLlmStatus().last).toBe("quota");
  });

  it("the ladder records nothing when every slot is already cooling down", async () => {
    ladder();
    const fetchMock = vi.fn(async () => quota429());
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask()).rejects.toThrow("LLM_QUOTA_EXHAUSTED");
    resetLlmStatus();
    fetchMock.mockClear();
    await expect(ask()).rejects.toThrow("LLM_QUOTA_EXHAUSTED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getLlmStatus()).toEqual({ last: null, at: null, consecutiveFailures: 0 });
  });
});

describe("POST /api/llm/check records the same way, with the same response", () => {
  it("an explicit key with a 429 quota answer records quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => quota429()));
    const { body } = await check();
    expect(body).toMatchObject({ ok: false, status: 429 });
    expect(Object.keys(body).sort()).toEqual(["hint", "latencyMs", "ok", "status"]);
    // The body is read detached, so the refinement from error to quota lands a moment after the response.
    await vi.waitFor(() => expect(getLlmStatus().last).toBe("quota"));
    expect(getLlmStatus().consecutiveFailures).toBe(1);
    // The check route records only; it writes no provider error line.
    expect(errors).toEqual([]);
  });

  it("an explicit key with an ordinary 429 records error", async () => {
    vi.stubGlobal("fetch", reply(429, { error: { type: "requests", code: "rate_limit_exceeded" } }));
    await check();
    expect(getLlmStatus().last).toBe("error");
  });

  it("an explicit key with a stalled 429 body answers at once, without waiting on the read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>(), { status: 429 })));
    // No timer has been advanced.
    const { body } = await check();
    expect(body).toMatchObject({ ok: false, status: 429 });
    expect(getLlmStatus().last).toBe("error");
    // Let the detached read hit its bound so nothing is left pending.
    await vi.advanceTimersByTimeAsync(DIAGNOSTIC_BODY_TIMEOUT_MS + 10);
    expect(getLlmStatus()).toMatchObject({ last: "error", consecutiveFailures: 1 });
  });

  it("the ladder records quota when its attempt got the quota answer", async () => {
    ladder();
    vi.stubGlobal("fetch", vi.fn(async () => quota429()));
    const { body } = await check();
    expect(body).toMatchObject({ ok: false, status: 429 });
    expect(getLlmStatus().last).toBe("quota");
  });

  it("the ladder records nothing when every slot is already cooling down", async () => {
    ladder();
    const fetchMock = vi.fn(async () => quota429());
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask()).rejects.toThrow("LLM_QUOTA_EXHAUSTED");
    resetLlmStatus();
    fetchMock.mockClear();
    const { body } = await check();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body).toMatchObject({ ok: false });
    expect(getLlmStatus()).toEqual({ last: null, at: null, consecutiveFailures: 0 });
  });
});
