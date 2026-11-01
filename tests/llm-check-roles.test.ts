import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST as checkRoute } from "@/app/api/llm/check/route";
import { LLM_ROLES } from "@/lib/serverConfig";

const CLEAR = [
  "LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY", "OPENAI_API_KEY", "DEMO_MODE",
  ...LLM_ROLES.flatMap((r) => [`LLM_MODEL_${r.toUpperCase()}`, `LLM_BASE_URL_${r.toUpperCase()}`, `LLM_API_KEY_${r.toUpperCase()}`]),
];

beforeEach(() => {
  for (const k of CLEAR) vi.stubEnv(k, "");
  vi.stubEnv("DEMO_MODE", "true");
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mockProvider() {
  const urls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 });
  }));
  return urls;
}

let ip = 0;
async function check() {
  const res = await checkRoute(new NextRequest("http://localhost/api/llm/check", { method: "POST", headers: { "x-forwarded-for": `10.9.0.${++ip}` } }));
  return (await res.json()) as { ok: boolean; hint: string; checks?: { roles: string[]; ok: boolean }[] };
}

describe("POST /api/llm/check with roles set up on purpose", () => {
  it("fails when a role has its own base URL but no key, even if the others connect", async () => {
    vi.stubEnv("LLM_API_KEY", "shared-key");
    vi.stubEnv("LLM_BASE_URL_COACH", "https://other.example/v1");
    const urls = mockProvider();
    const body = await check();
    expect(body.ok).toBe(false);
    expect(body.hint).toContain("LLM_API_KEY_COACH");
    expect(body.hint).not.toContain("other.example");
    expect(body.checks?.find((c) => c.roles.includes("coach"))).toMatchObject({ ok: false });
    // The shared key went only to the shared endpoint, once, for the other three roles.
    expect(urls).toEqual(["https://api.openai.com/v1/chat/completions"]);
  });

  it("fails when only a role's model is set and no key reaches it, without calling out", async () => {
    vi.stubEnv("LLM_MODEL_COACH", "gpt-6-luna");
    const urls = mockProvider();
    const body = await check();
    expect(body.ok).toBe(false);
    expect(body.hint).toContain("LLM_API_KEY_COACH");
    expect(urls).toHaveLength(0);
  });

  it("leaves roles with no variables of their own optional", async () => {
    vi.stubEnv("LLM_API_KEY_GRADE", "grade-key");
    vi.stubEnv("LLM_BASE_URL_GRADE", "https://api.anthropic.com/v1");
    mockProvider();
    const body = await check();
    expect(body.ok).toBe(true);
    expect(body.checks?.map((c) => c.roles)).toEqual([["grade"]]);
  });

  it("with nothing configured it still answers no key", async () => {
    const urls = mockProvider();
    const body = await check();
    expect(body.ok).toBe(false);
    expect(body.hint).toMatch(/No API key is set/);
    expect(urls).toHaveLength(0);
  });
});
