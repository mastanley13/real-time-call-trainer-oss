import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The purge itself must never run in these tests: a database call fails the test.
vi.mock("@/lib/db", () => ({
  prisma: new Proxy({}, { get: () => { throw new Error("database touched by an unauthorized request"); } }),
}));

import { cronAuthorized, resolveLlmKey } from "@/lib/serverConfig";
import { GET as purge } from "@/app/api/cron/purge-expired/route";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveLlmKey", () => {
  it("prefers LLM_API_KEY wherever the base URL points", () => {
    expect(resolveLlmKey({ LLM_API_KEY: "llm", OPENAI_API_KEY: "sk-openai", LLM_BASE_URL: "https://openrouter.ai/api/v1" })).toBe("llm");
  });

  it("falls back to OPENAI_API_KEY for the default OpenAI base URL", () => {
    expect(resolveLlmKey({ OPENAI_API_KEY: "sk-openai" })).toBe("sk-openai");
    expect(resolveLlmKey({ OPENAI_API_KEY: "sk-openai", LLM_BASE_URL: "https://api.openai.com/v1" })).toBe("sk-openai");
  });

  it("never sends OPENAI_API_KEY to a custom base URL", () => {
    expect(resolveLlmKey({ OPENAI_API_KEY: "sk-openai", LLM_BASE_URL: "https://openrouter.ai/api/v1" })).toBeUndefined();
    expect(resolveLlmKey({ OPENAI_API_KEY: "sk-openai", LLM_BASE_URL: "http://localhost:11434/v1" })).toBeUndefined();
    // A look-alike host is not OpenAI.
    expect(resolveLlmKey({ OPENAI_API_KEY: "sk-openai", LLM_BASE_URL: "https://api.openai.com.evil.example/v1" })).toBeUndefined();
  });

  it("returns undefined when nothing is set", () => {
    expect(resolveLlmKey({})).toBeUndefined();
    expect(resolveLlmKey({ LLM_API_KEY: "  " })).toBeUndefined();
  });
});

describe("cronAuthorized", () => {
  it("accepts only the CRON_SECRET bearer token", () => {
    expect(cronAuthorized("Bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(cronAuthorized("bearer s3cret-value", "s3cret-value")).toBe(true);
    expect(cronAuthorized("Bearer wrong", "s3cret-value")).toBe(false);
    expect(cronAuthorized("s3cret-value", "s3cret-value")).toBe(false);
  });

  it("rejects everything when CRON_SECRET is unset", () => {
    expect(cronAuthorized("Bearer anything", undefined)).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
  });

});

describe("GET /api/cron/purge-expired", () => {
  const call = (headers: Record<string, string>) => purge(new NextRequest("https://trainer.example/api/cron/purge-expired", { headers }));

  it("returns 401 to a request that carries only x-vercel-cron", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    const res = await call({ "x-vercel-cron": "1" });
    expect(res.status).toBe(401);
  });

  it("returns 401 to x-vercel-cron with a wrong bearer token", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect((await call({ "x-vercel-cron": "1", authorization: "Bearer guess" })).status).toBe(401);
  });

  it("returns 401 when CRON_SECRET is not configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await call({ "x-vercel-cron": "1", authorization: "Bearer " })).status).toBe(401);
  });
});
