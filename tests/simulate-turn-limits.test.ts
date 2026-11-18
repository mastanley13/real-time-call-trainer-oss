import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST /api/simulate/turn is the text caller. It must 429 on the per-IP cap and the
 * per-account cap of 40 a minute before it talks to a model. Invalid bodies are used
 * on purpose: a 429 then means the limiter fired before parse.
 * The session check and chatFull are the only fakes.
 */

const mocks = vi.hoisted(() => ({
  user: { id: "u-0", email: "rep@example.test" },
  chatFull: vi.fn(),
}));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  chatFull: mocks.chatFull,
}));

import { POST as simulate } from "@/app/api/simulate/turn/route";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const KEY = "sk-test-simulate-not-real";
const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const badBody = { scenario: { id: "x" }, history: [{ role: "user", text: "hi" }] };
const goodBody = {
  scenario,
  history: [{ role: "user" as const, text: "Hi, thanks for taking my call. Do you have a few minutes?" }],
};

let users = 0;
let ips = 0;
const signIn = () => (mocks.user = { id: `sim-${++users}`, email: `sim-${users}@example.test` });
const ip = () => `198.18.62.${(++ips % 250) + 1}`;

function post(body: unknown, from = ip()) {
  return simulate(new NextRequest("http://localhost/api/simulate/turn", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  signIn();
  mocks.chatFull.mockReset();
  mocks.chatFull.mockRejectedValue(new Error("simulate-turn-limits tests must not call the model"));
  vi.stubEnv("LLM_API_KEY", KEY);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_CALLER_MAX", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/simulate/turn rate limits", () => {
  it("limits one IP across accounts, then 429s with Retry-After before parse", async () => {
    vi.stubEnv("RATE_LIMIT_CALLER_MAX", "2");
    const from = ip();
    expect((await post(badBody, from)).status).toBe(400);
    signIn();
    expect((await post(badBody, from)).status).toBe(400);
    signIn();
    const limited = await post(badBody, from);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(mocks.chatFull).not.toHaveBeenCalled();

    signIn();
    expect((await post(badBody)).status).toBe(400);
    expect(mocks.chatFull).not.toHaveBeenCalled();
  });

  it("limits one account to 40 turns a minute before parse, with the account-specific 429", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 40; i++) codes.push((await post(badBody)).status);
    expect(codes.every((c) => c === 400)).toBe(true);
    const limited = await post(badBody);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });
    expect(mocks.chatFull).not.toHaveBeenCalled();

    signIn();
    expect((await post(badBody)).status).toBe(400);
    expect(mocks.chatFull).not.toHaveBeenCalled();
  });

  it("a scripted turn still 429s past the per-account cap, and never calls the model", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    for (let i = 0; i < 40; i++) {
      const res = await post(goodBody);
      expect(res.status).toBe(200);
      expect((await res.json()).source).toBe("scripted");
    }
    const limited = await post(goodBody);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });
    expect(mocks.chatFull).not.toHaveBeenCalled();
  });
});
