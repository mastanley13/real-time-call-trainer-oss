import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The in-memory record of the last chat model call (src/lib/llmStatus.ts), how chatFull feeds it, and how
 * GET /api/health reports it. No network: fetch is stubbed. Only the database is faked.
 */

const mocks = vi.hoisted(() => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("@/lib/db", () => ({ prisma: mocks.prisma }));

import { GET as health } from "@/app/api/health/route";
import { chatFull } from "@/lib/llm";
import { getLlmStatus, llmOutcomeFromStatus, recordLlmOutcome, refineLlmOutcome, resetLlmStatus } from "@/lib/llmStatus";
import { OPENAI_KEY_SLOT_VARS, resetOpenAiKeyState } from "@/lib/openaiKeys";

const hex = (n: number) => randomBytes(n).toString("hex");
const KEY = `${hex(8)}fixturellmkey${hex(8)}`;
const MODEL = "fixture-model-id";
const ENV = ["DEMO_MODE", "ALLOW_PUBLIC_DEMO", "DATABASE_URL", "JWT_SECRET", "LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL", "OPENAI_REALTIME_API_KEY", ...OPENAI_KEY_SLOT_VARS] as const;

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, "");
  vi.stubEnv("LLM_API_KEY", KEY);
  vi.stubEnv("LLM_MODEL", MODEL);
  resetLlmStatus();
  resetOpenAiKeyState();
  mocks.prisma.$queryRaw.mockReset();
  mocks.prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ask = () => chatFull([{ role: "user", content: "Hello" }]);
const okBody = () => Response.json({ choices: [{ message: { content: "Hi there" }, finish_reason: "stop" }] });

describe("llmOutcomeFromStatus", () => {
  it("maps 2xx to ok and 401/403 to auth_failed", () => {
    expect(llmOutcomeFromStatus(200)).toBe("ok");
    expect(llmOutcomeFromStatus(204)).toBe("ok");
    expect(llmOutcomeFromStatus(401)).toBe("auth_failed");
    expect(llmOutcomeFromStatus(403)).toBe("auth_failed");
  });

  it("treats 429 as quota only when the caller knows it was a quota answer", () => {
    expect(llmOutcomeFromStatus(429, { quota: true })).toBe("quota");
    expect(llmOutcomeFromStatus(429)).toBe("error");
    expect(llmOutcomeFromStatus(429, { quota: false })).toBe("error");
    expect(llmOutcomeFromStatus(401, { quota: true })).toBe("auth_failed");
  });

  it("maps anything else to error", () => {
    for (const s of [301, 400, 404, 500, 502, 503]) expect(llmOutcomeFromStatus(s)).toBe("error");
  });
});

describe("recordLlmOutcome and getLlmStatus", () => {
  it("starts empty", () => {
    expect(getLlmStatus()).toEqual({ last: null, at: null, consecutiveFailures: 0 });
  });

  it("keeps the latest outcome and time, counts failures in a row and resets them on ok", () => {
    recordLlmOutcome("auth_failed", Date.UTC(2026, 0, 1));
    recordLlmOutcome("error", Date.UTC(2026, 0, 2));
    expect(getLlmStatus()).toEqual({ last: "error", at: "2026-01-02T00:00:00.000Z", consecutiveFailures: 2 });
    recordLlmOutcome("ok", Date.UTC(2026, 0, 3));
    expect(getLlmStatus()).toEqual({ last: "ok", at: "2026-01-03T00:00:00.000Z", consecutiveFailures: 0 });
    recordLlmOutcome("quota", Date.UTC(2026, 0, 4));
    expect(getLlmStatus().consecutiveFailures).toBe(1);
  });

  it("refines a provisional failure in place: same time, same failure count", () => {
    const token = recordLlmOutcome("error", Date.UTC(2026, 0, 5));
    expect(refineLlmOutcome(token, "quota")).toBe(true);
    expect(getLlmStatus()).toEqual({ last: "quota", at: "2026-01-05T00:00:00.000Z", consecutiveFailures: 1 });
  });

  it("ignores a refinement once a newer outcome was recorded, or after a reset", () => {
    const stale = recordLlmOutcome("error");
    recordLlmOutcome("ok");
    expect(refineLlmOutcome(stale, "quota")).toBe(false);
    expect(getLlmStatus().last).toBe("ok");
    const beforeReset = recordLlmOutcome("error");
    resetLlmStatus();
    expect(refineLlmOutcome(beforeReset, "quota")).toBe(false);
    expect(getLlmStatus()).toEqual({ last: null, at: null, consecutiveFailures: 0 });
  });

  it("never turns a failure into ok, or an ok into a failure", () => {
    const failed = recordLlmOutcome("error");
    expect(refineLlmOutcome(failed, "ok")).toBe(false);
    expect(getLlmStatus().last).toBe("error");
    const ok = recordLlmOutcome("ok");
    expect(refineLlmOutcome(ok, "quota")).toBe(false);
    expect(getLlmStatus().last).toBe("ok");
  });

  it("stores only the outcome, the time and the counter", () => {
    recordLlmOutcome("ok");
    expect(Object.keys(getLlmStatus()).sort()).toEqual(["at", "consecutiveFailures", "last"]);
  });
});

describe("chatFull records the outcome", () => {
  it("auth_failed on a 401, with the same error as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })));
    await expect(ask()).rejects.toThrow("LLM_HTTP_401");
    expect(getLlmStatus()).toMatchObject({ last: "auth_failed", at: expect.any(String), consecutiveFailures: 1 });
  });

  it("ok on a 200, and a success clears the failure count", async () => {
    recordLlmOutcome("auth_failed");
    vi.stubGlobal("fetch", vi.fn(async () => okBody()));
    await expect(ask()).resolves.toEqual({ text: "Hi there", truncated: false });
    expect(getLlmStatus()).toMatchObject({ last: "ok", consecutiveFailures: 0 });
  });

  it("error on a 500", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    await expect(ask()).rejects.toThrow("LLM_HTTP_500");
    expect(getLlmStatus().last).toBe("error");
  });

  it("error on a network failure, rethrowing the same error object", async () => {
    const boom = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn(async () => { throw boom; }));
    await expect(ask()).rejects.toBe(boom);
    expect(getLlmStatus().last).toBe("error");
  });

  it("quota when every OpenAI key slot is out of quota", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", KEY);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429 })));
    await expect(ask()).rejects.toThrow("LLM_QUOTA_EXHAUSTED");
    expect(getLlmStatus().last).toBe("quota");
  });

  it("records nothing when no key is configured", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(ask()).rejects.toThrow("LLM_NOT_CONFIGURED");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getLlmStatus()).toEqual({ last: null, at: null, consecutiveFailures: 0 });
  });
});

describe("GET /api/health checks.llm", () => {
  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://fixture:fixture@localhost:5432/fixture");
    vi.stubEnv("JWT_SECRET", "fixture-only-not-a-secret-0123456789abcdef");
  });

  const get = async () => {
    const res = await health();
    const text = await res.text();
    return { res, text, body: JSON.parse(text) as { ok: boolean; checks: Record<string, string> } };
  };

  it("configured_unverified when no call has been seen on this instance", async () => {
    const { res, body } = await get();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.llm).toBe("configured_unverified");
    expect(body.checks.llmLastCallAt).toBe("none");
  });

  it("error_auth after an auth failure, without changing ok or the status code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(ask()).rejects.toThrow("LLM_HTTP_401");
    const { res, body, text } = await get();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.db).toBe("ok");
    expect(body.checks.llm).toBe("error_auth");
    expect(body.checks.llmLastCallAt).toBe(getLlmStatus().at);
    expect(text).not.toContain(KEY.slice(0, 6));
    expect(text).not.toContain(KEY.slice(-6));
    expect(text).not.toContain(MODEL);
    expect(text).not.toContain("api.openai.com");
  });

  it("maps each recorded outcome", async () => {
    const cases = [["ok", "ok"], ["quota", "error_quota"], ["error", "error"], ["auth_failed", "error_auth"]] as const;
    for (const [outcome, want] of cases) {
      recordLlmOutcome(outcome);
      const { res, body } = await get();
      expect(res.status).toBe(200);
      expect(body.checks.llm).toBe(want);
    }
  });

  it("not_configured when there is no key, even with a recorded outcome", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    recordLlmOutcome("ok");
    const { body } = await get();
    expect(body.checks.llm).toBe("not_configured");
  });

  it("a healthy llm does not mask a database failure", async () => {
    recordLlmOutcome("ok");
    mocks.prisma.$queryRaw.mockRejectedValue(new Error("down"));
    const { res, body } = await get();
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.llm).toBe("ok");
  });
});
