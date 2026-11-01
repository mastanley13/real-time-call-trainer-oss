import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  DEFAULT_LLM_MODEL, LLM_ROLES, llmBaseUrlFor, llmModelFor, resolveLlmKeyFor, type LlmRole,
} from "@/lib/serverConfig";
import { chatFull } from "@/lib/llm";
import { coachTurn } from "@/lib/coach";
import { evaluateCall } from "@/lib/grader";
import { generatePersona } from "@/lib/personaWizard";
import { POST as simulate } from "@/app/api/simulate/turn/route";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const ROLE_VARS = LLM_ROLES.flatMap((r) => [`LLM_MODEL_${r.toUpperCase()}`, `LLM_BASE_URL_${r.toUpperCase()}`, `LLM_API_KEY_${r.toUpperCase()}`]);
const CLEAR = ["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "OPENAI_API_KEY", "DEMO_MODE", ...ROLE_VARS];

beforeEach(() => {
  for (const k of CLEAR) vi.stubEnv(k, "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("llmModelFor", () => {
  it.each(LLM_ROLES.map((r) => [r]))("%s: role variable, then LLM_MODEL, then the code default", (role) => {
    const roleVar = `LLM_MODEL_${role.toUpperCase()}`;
    expect(llmModelFor(role, {})).toBe(DEFAULT_LLM_MODEL);
    expect(llmModelFor(role, { LLM_MODEL: "general" })).toBe("general");
    expect(llmModelFor(role, { LLM_MODEL: "general", [roleVar]: "specific" })).toBe("specific");
    expect(llmModelFor(role, { LLM_MODEL: "general", [roleVar]: "  " })).toBe("general");
  });

  it("the code default is the cheap model", () => {
    expect(DEFAULT_LLM_MODEL).toBe("gpt-6-luna");
    expect(llmModelFor("coach", {})).toBe("gpt-6-luna");
    expect(llmModelFor("persona", {})).toBe("gpt-6-luna");
    expect(llmModelFor("wizard", {})).toBe("gpt-6-luna");
  });

  it("the grader follows the deployment's LLM_MODEL while the coach moves to its own model", () => {
    const env = { LLM_MODEL: "claude-sonnet-5-5", LLM_MODEL_COACH: "gpt-6-luna" };
    expect(llmModelFor("grade", env)).toBe("claude-sonnet-5-5");
    expect(llmModelFor("coach", env)).toBe("gpt-6-luna");
    expect(llmModelFor("persona", env)).toBe("claude-sonnet-5-5");
  });

  it("one role's variable does not leak into another", () => {
    expect(llmModelFor("grade", { LLM_MODEL_COACH: "x" })).toBe(DEFAULT_LLM_MODEL);
  });
});

describe("per-role base URL and key", () => {
  it("falls back from the role variable to the shared one, then to OpenAI", () => {
    expect(llmBaseUrlFor("coach", {})).toBe("https://api.openai.com/v1");
    expect(llmBaseUrlFor("coach", { LLM_BASE_URL: "https://shared.example/v1/" })).toBe("https://shared.example/v1");
    expect(llmBaseUrlFor("coach", { LLM_BASE_URL: "https://shared.example/v1", LLM_BASE_URL_COACH: "https://coach.example/v1" })).toBe("https://coach.example/v1");
    expect(llmBaseUrlFor("grade", { LLM_BASE_URL: "https://shared.example/v1", LLM_BASE_URL_COACH: "https://coach.example/v1" })).toBe("https://shared.example/v1");
  });

  it("uses LLM_API_KEY_<ROLE>, else LLM_API_KEY", () => {
    expect(resolveLlmKeyFor("coach", { LLM_API_KEY: "shared", LLM_API_KEY_COACH: "own" })).toBe("own");
    expect(resolveLlmKeyFor("grade", { LLM_API_KEY: "shared", LLM_API_KEY_COACH: "own" })).toBe("shared");
    expect(resolveLlmKeyFor("coach", {})).toBeUndefined();
  });

  it("never sends the shared key to a role that points at a different base URL", () => {
    const env = { LLM_API_KEY: "anthropic-key", LLM_BASE_URL: "https://api.anthropic.com/v1", LLM_BASE_URL_COACH: "https://api.openai.com/v1" };
    expect(resolveLlmKeyFor("coach", env)).toBeUndefined();
    expect(resolveLlmKeyFor("grade", env)).toBe("anthropic-key");
    // With OPENAI_API_KEY present, the OpenAI role uses it because its own base URL is OpenAI.
    expect(resolveLlmKeyFor("coach", { ...env, OPENAI_API_KEY: "openai-key" })).toBe("openai-key");
    // The grader on Anthropic never gets the OpenAI key.
    expect(resolveLlmKeyFor("grade", { ...env, OPENAI_API_KEY: "openai-key" })).toBe("anthropic-key");
    expect(resolveLlmKeyFor("grade", { LLM_BASE_URL: "https://api.anthropic.com/v1", OPENAI_API_KEY: "openai-key" })).toBeUndefined();
  });

  it("keeps the OPENAI_API_KEY stand-in while every role is on OpenAI, and refuses it on a custom base URL", () => {
    expect(resolveLlmKeyFor("coach", { OPENAI_API_KEY: "openai-key" })).toBe("openai-key");
    expect(resolveLlmKeyFor("coach", { OPENAI_API_KEY: "openai-key", LLM_BASE_URL_COACH: "https://openrouter.ai/api/v1" })).toBeUndefined();
    expect(resolveLlmKeyFor("coach", { OPENAI_API_KEY: "openai-key", LLM_BASE_URL_COACH: "https://api.openai.com.evil.example/v1" })).toBeUndefined();
  });
});

/** The body, URL and bearer token of every provider call. */
type Call = { url: string; auth: string; body: Record<string, unknown> };
function mockProvider(content = "{}", first?: { status: number; body: string }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: JSON.parse(init.body as string) });
    if (first && calls.length === 1) return new Response(first.body, { status: first.status });
    return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
  }));
  return calls;
}

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const turns = [
  { role: "assistant" as const, text: scenario.aiPersona.openingLine },
  { role: "user" as const, text: "Thanks for calling Rapid Flow Plumbing, this is Sam. How can I help?" },
];

describe("each AI job sends its own model", () => {
  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "shared-key");
    vi.stubEnv("LLM_MODEL", "model-general");
    vi.stubEnv("LLM_MODEL_COACH", "model-coach");
    vi.stubEnv("LLM_MODEL_GRADE", "model-grade");
    vi.stubEnv("LLM_MODEL_PERSONA", "model-persona");
    vi.stubEnv("LLM_MODEL_WIZARD", "model-wizard");
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("coach", async () => {
    const calls = mockProvider();
    const out = await coachTurn(scenario, turns, { allowCue: true });
    expect(calls.map((c) => c.body.model)).toEqual(["model-coach"]);
    expect(out).toMatchObject({ source: "llm", model: "model-coach" });
  });

  it("grader", async () => {
    const calls = mockProvider();
    await evaluateCall(scenario, turns);
    expect(calls.map((c) => c.body.model)).toEqual(["model-grade"]);
  });

  it("text persona", async () => {
    vi.stubEnv("DEMO_MODE", "true");
    const calls = mockProvider("Hello there.");
    const res = await simulate(new NextRequest("http://localhost/api/simulate/turn", {
      method: "POST",
      body: JSON.stringify({ scenario, history: [{ role: "user", text: "Hi, thanks for taking my call." }] }),
      headers: { "content-type": "application/json", "x-forwarded-for": "10.7.0.1" },
    }));
    expect(res.status).toBe(200);
    expect(calls.map((c) => c.body.model)).toEqual(["model-persona"]);
  });

  it("persona wizard", async () => {
    const calls = mockProvider();
    await generatePersona({ role: scenario.role, industry: "", callType: "inbound", difficulty: "easy", product: "", contexts: [] });
    expect(calls.map((c) => c.body.model)).toEqual(["model-wizard"]);
  });

  it("stored provenance names the per-role model", async () => {
    const reply = JSON.stringify({
      summary: "ok", strengths: [], improvements: [], goalStatus: "partial", goalExplanation: "x",
      criteria: scenario.rubric.map((c) => ({ id: c.id, score: 50, rationale: "r", evidence: [] })),
    });
    mockProvider(reply);
    expect(await evaluateCall(scenario, turns)).toMatchObject({ method: "llm", model: "model-grade" });
  });

  it("falls back to LLM_MODEL for a role without its own variable", async () => {
    vi.stubEnv("LLM_MODEL_GRADE", "");
    const calls = mockProvider();
    await evaluateCall(scenario, turns);
    expect(calls[0].body.model).toBe("model-general");
  });
});

describe("a role on its own provider", () => {
  it("sends the role's key to the role's endpoint and skips response_format only on Anthropic", async () => {
    vi.stubEnv("LLM_BASE_URL", "https://api.anthropic.com/v1");
    vi.stubEnv("LLM_API_KEY", "anthropic-key");
    vi.stubEnv("LLM_MODEL", "claude-sonnet-5-5");
    vi.stubEnv("LLM_BASE_URL_COACH", "https://api.openai.com/v1");
    vi.stubEnv("LLM_API_KEY_COACH", "openai-key");
    vi.stubEnv("LLM_MODEL_COACH", "gpt-6-luna");
    const calls = mockProvider();

    await chatFull([{ role: "user", content: "x" }], { role: "grade", json: true });
    await chatFull([{ role: "user", content: "x" }], { role: "coach", json: true });

    expect(calls[0]).toMatchObject({ url: "https://api.anthropic.com/v1/chat/completions", auth: "Bearer anthropic-key" });
    expect(calls[0].body.model).toBe("claude-sonnet-5-5");
    expect(calls[0].body).not.toHaveProperty("response_format");
    expect(calls[1]).toMatchObject({ url: "https://api.openai.com/v1/chat/completions", auth: "Bearer openai-key" });
    expect(calls[1].body.model).toBe("gpt-6-luna");
    expect(calls[1].body.response_format).toEqual({ type: "json_object" });
  });

  it("throws LLM_NOT_CONFIGURED for a role that has no key, without calling out", async () => {
    vi.stubEnv("LLM_API_KEY", "anthropic-key");
    vi.stubEnv("LLM_BASE_URL", "https://api.anthropic.com/v1");
    vi.stubEnv("LLM_BASE_URL_COACH", "https://api.openai.com/v1");
    const calls = mockProvider();
    await expect(chatFull([{ role: "user", content: "x" }], { role: "coach" })).rejects.toThrow("LLM_NOT_CONFIGURED");
    expect(calls).toHaveLength(0);
  });
});

describe("parameter retries", () => {
  const roles: LlmRole[] = ["coach"];
  beforeEach(() => {
    vi.stubEnv("LLM_API_KEY", "k");
    vi.stubEnv("LLM_MODEL", "gpt-6-luna");
  });

  it("retries with max_completion_tokens when a 400 names max_tokens", async () => {
    const calls = mockProvider("ok", { status: 400, body: '{"error":{"message":"Unsupported parameter: \'max_tokens\' is not supported with this model."}}' });
    const out = await chatFull([{ role: "user", content: "x" }], { role: roles[0], maxTokens: 321 });
    expect(out.text).toBe("ok");
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toMatchObject({ max_tokens: 321 });
    expect(calls[1].body).toMatchObject({ max_completion_tokens: 321 });
    expect(calls[1].body).not.toHaveProperty("max_tokens");
  });

  it("still retries without temperature, and a 400 that names neither parameter fails with the status only", async () => {
    const calls = mockProvider("ok", { status: 400, body: '{"error":{"message":"temperature is not supported"}}' });
    await chatFull([{ role: "user", content: "x" }], { role: "coach" });
    expect(calls[1].body).not.toHaveProperty("temperature");

    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"error":{"message":"secret prompt echo"}}', { status: 400 })));
    await expect(chatFull([{ role: "user", content: "x" }], { role: "coach" })).rejects.toThrow(/^LLM_HTTP_400$/);
  });
});
