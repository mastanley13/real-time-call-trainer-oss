import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SCENARIOS,
  ScenarioSchema,
  buildAgentPrompt,
  newBlankScenario,
  normalizeWeights,
  talkTrackSteps,
  type RubricCriterion,
  type Scenario,
} from "@/lib/scenarios";

const criterion = (id: string, weight: number): RubricCriterion => ({ id, name: `Criterion ${id}`, description: `About ${id}`, weight });
const sum = (rubric: RubricCriterion[]) => rubric.reduce((a, c) => a + c.weight, 0);

describe("normalizeWeights", () => {
  it("scales weights so they sum to 100 and keeps their proportions", () => {
    const out = normalizeWeights([criterion("a", 10), criterion("b", 30)]);
    expect(out.map((c) => c.weight)).toEqual([25, 75]);
  });

  it("leaves a rubric that already sums to 100 unchanged", () => {
    const rubric = BUILT_IN_SCENARIOS[0].rubric;
    expect(normalizeWeights(rubric)).toEqual(rubric);
  });

  it("handles uneven totals", () => {
    const out = normalizeWeights([criterion("a", 1), criterion("b", 1), criterion("c", 1)]);
    expect(sum(out)).toBeCloseTo(100);
    for (const c of out) expect(c.weight).toBeCloseTo(100 / 3);
  });

  it("splits evenly when every weight is zero", () => {
    const out = normalizeWeights([criterion("a", 0), criterion("b", 0), criterion("c", 0), criterion("d", 0)]);
    expect(out.map((c) => c.weight)).toEqual([25, 25, 25, 25]);
  });

  it("keeps the other fields and does not mutate its input", () => {
    const rubric = [criterion("a", 2), criterion("b", 6)];
    const copy = structuredClone(rubric);
    const out = normalizeWeights(rubric);
    expect(rubric).toEqual(copy);
    expect(out.map(({ id, name, description }) => ({ id, name, description }))).toEqual(copy.map(({ id, name, description }) => ({ id, name, description })));
  });
});

describe("talkTrackSteps", () => {
  it("strips numbering and bullets and drops blank lines", () => {
    expect(talkTrackSteps("1. Greet them\n2) Ask why\n\n - Collect details\n* Offer a slot\n• Confirm\n10. Close")).toEqual([
      "Greet them",
      "Ask why",
      "Collect details",
      "Offer a slot",
      "Confirm",
      "Close",
    ]);
  });

  it("keeps unnumbered lines and trims whitespace", () => {
    expect(talkTrackSteps("  Greet warmly  \nAsk about urgency")).toEqual(["Greet warmly", "Ask about urgency"]);
  });

  it("returns no steps for an empty script", () => {
    expect(talkTrackSteps("")).toEqual([]);
    expect(talkTrackSteps("\n \n")).toEqual([]);
  });

  it("reads the built-in talk tracks", () => {
    const home = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
    const steps = talkTrackSteps(home.callScript);
    expect(steps).toHaveLength(6);
    expect(steps[0]).toBe("Greet warmly, give company name and your name.");
  });
});

describe("buildAgentPrompt", () => {
  // Distinctive markers so a leak cannot be a coincidence.
  const scenario: Scenario = ScenarioSchema.parse({
    id: "custom-test-abcd",
    title: "Prompt leak check",
    industry: "Pool cleaning",
    callScript: "1. Greet the caller.\n2. Ask about the pool.",
    aiPersona: {
      name: "Rowan Pike",
      role: "Homeowner with a green pool",
      behavior: "Impatient and wants a quote today.",
      openingLine: "Hi, my pool turned green.",
    },
    traineeGoal: "Book a visit.",
    rubric: [
      { id: "zz_greet", name: "ZZ greeting marker", description: "ZZ secret rubric description one.", weight: 37 },
      { id: "zz_close", name: "ZZ close marker", description: "ZZ secret rubric description two.", weight: 63 },
    ],
    objections: [{ type: "price", line: "That sounds expensive.", prepAnswer: "ZZ secret prep answer." }],
  });
  const prompt = buildAgentPrompt(scenario);

  it("plays the persona", () => {
    expect(prompt).toContain("You are Rowan Pike, Homeowner with a green pool.");
    expect(prompt).toContain("Impatient and wants a quote today.");
    expect(prompt).toContain("Industry: Pool cleaning");
  });

  it("tells the persona never to coach or break character", () => {
    expect(prompt).toMatch(/Never coach/);
    expect(prompt).toMatch(/Never break character/);
  });

  it("never leaks rubric weights, rubric text or prep answers", () => {
    expect(prompt).not.toMatch(/\b37\b|\b63\b/);
    expect(prompt).not.toMatch(/weight/i);
    expect(prompt).not.toContain("ZZ");
    for (const c of scenario.rubric) {
      expect(prompt).not.toContain(c.id);
      expect(prompt).not.toContain(c.description);
    }
  });

  it("does not leak rubric weights for any built-in scenario", () => {
    for (const s of BUILT_IN_SCENARIOS) {
      const p = buildAgentPrompt(s);
      expect(p).toContain(s.aiPersona.name);
      expect(p).toMatch(/Never coach/);
      expect(p).not.toMatch(/weight|\d+%/i);
      for (const c of s.rubric) expect(p).not.toContain(c.description);
      for (const o of s.objections) expect(p).not.toContain(o.prepAnswer);
    }
  });

  it("falls back to a neutral behavior and skips an empty role", () => {
    const p = buildAgentPrompt({ ...scenario, aiPersona: { ...scenario.aiPersona, role: "", behavior: "" }, callScript: "" });
    expect(p).toContain("You are Rowan Pike. You are playing");
    expect(p).toContain("Act like a typical person in this situation.");
    expect(p).not.toContain("Expected talk track");
  });
});

describe("ScenarioSchema", () => {
  // A custom scenario saved before difficulty, family, call type, duration, objections, replies and status existed.
  const legacy = {
    id: "custom-legacy-1a2b",
    title: "Old custom scenario",
    industry: "Plumbing",
    callScript: "1. Greet.\n2. Book.",
    aiPersona: { name: "Pat", role: "Homeowner", behavior: "Calm.", openingLine: "Hello?" },
    traineeGoal: "Book a visit.",
    rubric: [{ id: "c1", name: "Booking", description: "", weight: 100 }],
  };

  it("fills defaults for old custom scenarios without the new fields", () => {
    const parsed = ScenarioSchema.parse(legacy);
    expect(parsed).toMatchObject({
      difficulty: "medium",
      role: "general",
      callType: "inbound",
      durationMin: 6,
      objections: [],
      sampleReplies: [],
      status: "reviewed",
    });
    expect(parsed.builtIn).toBeUndefined();
    expect(parsed.aiPersona.voiceId).toBeUndefined();
  });

  it("keeps values that are present", () => {
    const parsed = ScenarioSchema.parse({ ...legacy, difficulty: "hard", role: "sdr", callType: "cold", durationMin: 9, status: "draft" });
    expect(parsed).toMatchObject({ difficulty: "hard", role: "sdr", callType: "cold", durationMin: 9, status: "draft" });
  });

  it("rejects invalid data", () => {
    expect(ScenarioSchema.safeParse({ ...legacy, rubric: [] }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...legacy, callType: "telepathy" }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...legacy, durationMin: 0 }).success).toBe(false);
    expect(ScenarioSchema.safeParse({ ...legacy, objections: [{ type: "weather", line: "It's raining.", prepAnswer: "" }] }).success).toBe(false);
    const nine = Array.from({ length: 9 }, () => ({ type: "price", line: "Too much.", prepAnswer: "" }));
    expect(ScenarioSchema.safeParse({ ...legacy, objections: nine }).success).toBe(false);
  });

  it("accepts every built-in scenario and a new blank one", () => {
    for (const s of BUILT_IN_SCENARIOS) {
      expect(ScenarioSchema.safeParse(s).success).toBe(true);
      expect(sum(s.rubric)).toBe(100);
    }
    const blank = newBlankScenario();
    expect(ScenarioSchema.safeParse(blank).success).toBe(true);
    expect(blank.id).toMatch(/^custom-/);
    expect(blank.builtIn).toBeUndefined();
  });
});
