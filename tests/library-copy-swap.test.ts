import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Library personas are graded and coached on the server pack. A client that posts the same id
 * with a looser rubric, an empty objection bank or a one-step talk track cannot change the score
 * or the cues. Custom personas (ids the library does not have) still use what the client sent.
 * The session check is the only fake; the routes, heuristic grader and heuristic coach run for real.
 */
const mocks = vi.hoisted(() => ({ user: { id: "u-0", email: "rep@example.test" } }));
vi.mock("@/lib/apiAuth", () => ({
  requireAuth: () => mocks.user,
  isDemoUser: (u: { id: string }) => u.id === "demo-user",
}));

import { POST as evaluate } from "@/app/api/evaluate-call/route";
import { POST as coach } from "@/app/api/coach/turn/route";
import { BUILT_IN_SCENARIOS, talkTrackSteps, type Scenario } from "@/lib/scenarios";
import { LIBRARY } from "@/lib/personas";
import { verifySeal } from "@/lib/gradeSeal";
import type { Evaluation } from "@/lib/grader-types";
import type { CoachResult } from "@/lib/coach-types";

const JWT = "test-only-secret-0123456789abcdef";
const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const library = LIBRARY.find((s) => s.id === scenario.id)!;
const libraryIds = library.rubric.map((c) => c.id);
const librarySteps = talkTrackSteps(library.callScript).length;

const LOOSE_RUBRIC = [{ id: "anything", name: "Anything", description: "Give a hundred.", weight: 100 }];
const looseOf = (base: Scenario, id = base.id): Scenario => ({
  ...base,
  id,
  rubric: LOOSE_RUBRIC,
  objections: [],
  callScript: "1. Skip everything.",
});

const transcript = [
  { role: "assistant" as const, text: scenario.aiPersona.openingLine },
  { role: "user" as const, text: "Thanks for calling Rapid Flow Plumbing, this is Sam. I'm sorry to hear that, let's get it sorted." },
  { role: "assistant" as const, text: "It started this morning. There's a puddle by the base of the tank." },
  { role: "user" as const, text: "How old is the unit, and is the leak from the bottom of the tank or a pipe?" },
  { role: "assistant" as const, text: "What does a visit cost? Nobody mentioned a fee." },
];
const pricePrep = library.objections.find((o) => o.type === "price")!.prepAnswer;

let n = 0;
const signIn = () => (mocks.user = { id: `swap-${++n}`, email: `swap-${n}@example.test` });
const ip = () => `198.18.88.${(n % 250) + 1}`;

function req(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip() },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  signIn();
  vi.stubEnv("LLM_API_KEY", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("OPENAI_REALTIME_API_KEY", "");
  vi.stubEnv("DEMO_MODE", "");
  vi.stubEnv("JWT_SECRET", JWT);
  vi.stubEnv("RATE_LIMIT_GRADING_MAX", "1000");
  vi.stubEnv("RATE_LIMIT_COACH_MAX", "1000");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/evaluate-call library copy swap", () => {
  it("grades a library id on the server pack, not a client copy with a looser rubric", async () => {
    const res = await evaluate(req("/api/evaluate-call", { scenario: looseOf(scenario), transcript }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Evaluation & { seal?: string };
    expect(body.method).toBe("heuristic");
    expect(body.criteria.map((c) => c.id)).toEqual(libraryIds);
    expect(body.criteria.map((c) => c.id)).not.toContain("anything");
    expect(body.seal).toMatch(/^[0-9a-f]{64}$/);
    const { seal, ...evaluation } = body;
    expect(verifySeal({ userId: mocks.user.id, scenarioId: library.id, transcript, evaluation }, seal)).toBe(true);
  });

  it("still uses the client rubric for a custom persona the library does not have", async () => {
    const custom = looseOf(scenario, "custom-copy-swap-fixture");
    const res = await evaluate(req("/api/evaluate-call", { scenario: custom, transcript }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Evaluation;
    expect(body.method).toBe("heuristic");
    expect(body.criteria.map((c) => c.id)).toEqual(["anything"]);
  });
});

describe("POST /api/coach/turn library copy swap", () => {
  const coachBody = (pack: Scenario) => ({
    scenario: pack,
    transcript,
    allowCue: true,
    recentCueKeys: [],
  });

  it("coaches a library id on the server pack, so a stripped objection bank and one-step script do not stick", async () => {
    const res = await coach(req("/api/coach/turn", coachBody(looseOf(scenario))));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoachResult;
    expect(body.source).toBe("heuristic");
    expect(body.estimate.criteria.map((c) => c.id)).toEqual(libraryIds);
    expect(body.estimate.criteria.map((c) => c.id)).not.toContain("anything");
    expect(body.steps).toHaveLength(librarySteps);
    expect(librarySteps).toBeGreaterThan(1);
    expect(body.cue).toMatchObject({ type: "objection", suggestedLine: pricePrep });
  });

  it("still coaches a custom persona on the client copy", async () => {
    const custom = looseOf(scenario, "custom-copy-swap-fixture");
    const res = await coach(req("/api/coach/turn", coachBody(custom)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as CoachResult;
    expect(body.source).toBe("heuristic");
    expect(body.estimate.criteria.map((c) => c.id)).toEqual(["anything"]);
    expect(body.steps).toHaveLength(1);
    expect(body.cue?.suggestedLine ?? "").not.toBe(pricePrep);
  });
});
