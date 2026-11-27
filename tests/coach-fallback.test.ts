import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The live coach must keep the rail moving when the model fails. coachTurn catches every LLM
 * error (timeout, bad JSON, HTTP failure) and returns the heuristic result. The HTTP route
 * then answers 200. Cues stay on this channel; the response must never echo a key or a
 * provider body.
 *
 * Coach talks to chatFull (not chat). These tests mock chatFull so a timeout, LLM_HTTP_500,
 * or unparseable text still falls back. The deeper structured-output retry path lives in
 * tests/coach-llm-json.test.ts.
 */

const mocks = vi.hoisted(() => ({
  chatFull: vi.fn(),
  user: { id: "u-0", email: "rep@example.test" },
}));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm")>()),
  chatFull: mocks.chatFull,
}));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));

import { POST as coach } from "@/app/api/coach/turn/route";
import { coachHeuristic, coachTurn } from "@/lib/coach";
import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const KEY = "sk-test-coach-not-real";
const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const transcript = [
  { role: "assistant" as const, text: scenario.aiPersona.openingLine },
  { role: "user" as const, text: "Thanks for calling Rapid Flow Plumbing, this is Sam. I'm sorry to hear that, let's get it sorted." },
  { role: "assistant" as const, text: "It started this morning. There's a puddle by the base of the tank." },
  { role: "user" as const, text: "How old is the unit, and is the leak from the bottom of the tank or a pipe?" },
  { role: "assistant" as const, text: "What does a visit cost? Nobody mentioned a fee." },
];
const pricePrep = scenario.objections.find((o) => o.type === "price")!.prepAnswer;
const heuristic = () => coachHeuristic(scenario, transcript, { allowCue: true, recentCueKeys: [] });

let n = 0;
const signIn = () => (mocks.user = { id: `coach-${++n}`, email: `coach-${n}@example.test` });
const ip = () => `198.18.40.${(n % 250) + 1}`;

function coachReq(body: unknown) {
  return new NextRequest("http://localhost/api/coach/turn", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify(body),
  });
}

const turnBody = {
  scenario,
  transcript,
  allowCue: true,
  recentCueKeys: [] as string[],
};

function llmPayload(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    criteria: scenario.rubric.map((c) => ({
      id: c.id,
      score: 41,
      quote: "How old is the unit, and is the leak from the bottom of the tank or a pipe?",
    })),
    steps: scenario.callScript.split("\n").map(() => false),
    cue: null,
    ...patch,
  });
}

function llmOk(text: string) {
  return { text, truncated: false };
}

beforeEach(() => {
  signIn();
  mocks.chatFull.mockReset();
  vi.stubEnv("LLM_API_KEY", KEY);
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("RATE_LIMIT_COACH_MAX", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("coachTurn LLM failure falls back to the heuristic", () => {
  it("does not call the model when no key is set", async () => {
    vi.stubEnv("LLM_API_KEY", "");
    const result = await coachTurn(scenario, transcript, { allowCue: true });
    expect(mocks.chatFull).not.toHaveBeenCalled();
    expect(result.source).toBe("heuristic");
    expect(result.cueKey).toBe("objection:price");
  });

  it("maps a timeout to the heuristic, including the price objection cue", async () => {
    mocks.chatFull.mockRejectedValue(new Error("COACH_LLM_TIMEOUT"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await coachTurn(scenario, transcript, { allowCue: true });
    expect(result.source).toBe("heuristic");
    expect(result.cueKey).toBe(heuristic().cueKey);
    expect(result.cue).toMatchObject({ type: "objection", suggestedLine: pricePrep });
    expect(result.estimate.criteria.map((c) => c.id)).toEqual(scenario.rubric.map((c) => c.id));
  });

  it("maps unparseable model text that contains a key-looking string to the heuristic, and the result does not echo it", async () => {
    mocks.chatFull.mockResolvedValue(llmOk(`Sorry, quota_exceeded ${KEY} (not json)`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await coachTurn(scenario, transcript, { allowCue: true });
    expect(result.source).toBe("heuristic");
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("quota_exceeded");
    expect(result.cueKey).toBe("objection:price");
  });

  it("maps LLM_HTTP_500 to the heuristic without putting the provider body on the result", async () => {
    mocks.chatFull.mockRejectedValue(new Error("LLM_HTTP_500"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await coachTurn(scenario, transcript, { allowCue: true });
    expect(result.source).toBe("heuristic");
    expect(result).not.toHaveProperty("model");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("uses the LLM result when the model returns valid JSON", async () => {
    mocks.chatFull.mockResolvedValue(llmOk(llmPayload()));
    const result = await coachTurn(scenario, transcript, { allowCue: true });
    expect(result.source).toBe("llm");
    expect(result.cue).toBeNull();
    expect(result.estimate.criteria.every((c) => c.score === 41)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result).not.toHaveProperty("model");
  });

  it("times the 15 second coach budget out and falls back, without waiting for the model", async () => {
    vi.useFakeTimers();
    mocks.chatFull.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = coachTurn(scenario, transcript, { allowCue: true });
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await pending;
    expect(result.source).toBe("heuristic");
    expect(result.cueKey).toBe("objection:price");
  });
});

describe("POST /api/coach/turn stays up when the model fails", () => {
  it("answers 200 heuristic on a model timeout, with no key in the body", async () => {
    mocks.chatFull.mockRejectedValue(new Error("COACH_LLM_TIMEOUT"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await coach(coachReq(turnBody));
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as CoachResult;
    expect(body.source).toBe("heuristic");
    expect(body.cueKey).toBe("objection:price");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("COACH_LLM_TIMEOUT");
    expect(body).not.toHaveProperty("model");
  });

  it("answers 200 heuristic when the model returns unparseable text, and does not forward the key", async () => {
    mocks.chatFull.mockResolvedValue(llmOk(`upstream 500 quota_exceeded ${KEY} not json`));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await coach(coachReq(turnBody));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text).source).toBe("heuristic");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("quota_exceeded");
  });

  it("still answers 200 llm when the model is fine, with no key or model id", async () => {
    mocks.chatFull.mockResolvedValue(llmOk(llmPayload()));
    const res = await coach(coachReq(turnBody));
    const text = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(text) as CoachResult;
    expect(body.source).toBe("llm");
    expect(text).not.toContain(KEY);
    expect(body).not.toHaveProperty("model");
  });

  it("returns 400 on a body that is not a scenario, without calling the model", async () => {
    const res = await coach(coachReq({ scenario: { id: "x" }, transcript, allowCue: true }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid request body");
    expect(mocks.chatFull).not.toHaveBeenCalled();
  });
});
