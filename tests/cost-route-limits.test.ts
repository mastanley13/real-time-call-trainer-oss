import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Cost-bearing practice routes must 429 before they grade, coach, or relay SDP.
 * Invalid bodies are used on purpose: a 429 then means the limiter fired before
 * parse and before any provider call. Realtime mint IP and per-account caps are
 * already covered in voice-tier.test.ts; this file covers grade, live coach, and
 * the SDP relay (which has a per-account cap and no per-IP cap).
 * The session check is the only fake.
 */

const mocks = vi.hoisted(() => ({ user: { id: "u-0", email: "rep@example.test" } }));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));

import { POST as evaluate } from "@/app/api/evaluate-call/route";
import { POST as coach } from "@/app/api/coach/turn/route";
import { POST as sdp } from "@/app/api/realtime/sdp/route";

let users = 0;
let ips = 0;
const signIn = () => (mocks.user = { id: `lim-${++users}`, email: `lim-${users}@example.test` });
const ip = () => `198.18.74.${(++ips % 250) + 1}`;

function post(path: string, body: unknown, from = ip()) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": from },
    body: JSON.stringify(body),
  });
}

const badGrade = { scenario: { id: "x" }, transcript: [{ role: "user", text: "hi" }] };
const badCoach = { scenario: { id: "x" }, transcript: [], allowCue: true };
const badSdp = { clientSecret: "not-a-secret", sdp: "short" };

beforeEach(() => {
  signIn();
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
  vi.stubEnv("RATE_LIMIT_COACH_MAX", "1000");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("cost-route-limits tests must not call fetch");
  }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/evaluate-call rate limits", () => {
  it("limits one IP across accounts, then 429s with Retry-After before grading", async () => {
    vi.stubEnv("RATE_LIMIT_GRADING_MAX", "2");
    const from = ip();
    expect((await evaluate(post("/api/evaluate-call", badGrade, from))).status).toBe(400);
    signIn();
    expect((await evaluate(post("/api/evaluate-call", badGrade, from))).status).toBe(400);
    signIn();
    const limited = await evaluate(post("/api/evaluate-call", badGrade, from));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
  });

  it("limits one account across IPs at 10 grades a minute, with the grade-specific message", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await evaluate(post("/api/evaluate-call", badGrade))).status);
    expect(codes.every((c) => c === 400)).toBe(true);
    const limited = await evaluate(post("/api/evaluate-call", badGrade));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect(await limited.json()).toMatchObject({
      error: "Rate limit exceeded",
      message: expect.stringMatching(/You've graded 10 calls in the last minute/),
      retryAfter: expect.any(Number),
    });

    signIn();
    expect((await evaluate(post("/api/evaluate-call", badGrade))).status).toBe(400);
  });
});

describe("POST /api/coach/turn rate limits", () => {
  it("limits one IP across accounts, then 429s with Retry-After before coaching", async () => {
    vi.stubEnv("RATE_LIMIT_COACH_MAX", "2");
    const from = ip();
    expect((await coach(post("/api/coach/turn", badCoach, from))).status).toBe(400);
    signIn();
    expect((await coach(post("/api/coach/turn", badCoach, from))).status).toBe(400);
    signIn();
    const limited = await coach(post("/api/coach/turn", badCoach, from));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBeTruthy();
    expect((await limited.json()).error).toBe("rate_limited");
  });

  it("limits one account to 60 coach calls a minute before parse", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 60; i++) codes.push((await coach(post("/api/coach/turn", badCoach))).status);
    expect(codes.every((c) => c === 400)).toBe(true);
    const limited = await coach(post("/api/coach/turn", badCoach));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });

    signIn();
    expect((await coach(post("/api/coach/turn", badCoach))).status).toBe(400);
  });
});

describe("POST /api/realtime/sdp rate limits", () => {
  it("limits one account to 10 SDP relays a minute, and does not call OpenAI on the extra try", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await sdp(post("/api/realtime/sdp", badSdp))).status);
    expect(codes.every((c) => c === 400)).toBe(true);
    const limited = await sdp(post("/api/realtime/sdp", badSdp));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({
      error: "rate_limited",
      message: "Too many connection attempts. Wait a minute, then start the call again.",
    });
    expect(fetch).not.toHaveBeenCalled();

    signIn();
    expect((await sdp(post("/api/realtime/sdp", badSdp))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});
