import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  INFO_CREDIT_THRESHOLD, evaluateCandidate, isVerbatim, letterFor, percentile, renderReport,
  type FixtureRef, type RunResult,
} from "../scripts/grade-regression-eval";
import { gradeFor } from "@/lib/grader";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

// Synthetic data only: no model is called here. The script itself needs keys and is run by hand.
const fixtures: FixtureRef[] = [
  { id: "w1", kind: "weak_no_contact" },
  { id: "w2", kind: "weak_no_contact" },
  { id: "n1", kind: "name_only" },
  { id: "s1", kind: "contact_captured" },
];

const run = (fixtureId: string, score: number, over: Partial<RunResult> = {}): RunResult => ({
  fixtureId, run: 1, parsed: true, score, infoCapture: 0, quotesTotal: 4, quotesVerbatim: 4, latencyMs: 1000, ...over,
});
/** Three runs per fixture at the given scores. */
const runs = (scores: Record<string, number>, over: Partial<RunResult> = {}) =>
  Object.entries(scores).flatMap(([id, s]) => [1, 2, 3].map((n) => run(id, s, { run: n, ...over })));

const BASE = { w1: 4, w2: 5, n1: 7, s1: 60 };
const baseline = runs(BASE);
const failedRule = (r: ReturnType<typeof evaluateCandidate>) => r.rules.filter((x) => !x.pass).map((x) => x.id);

describe("evaluateCandidate pass rules", () => {
  it("passes a candidate that matches the baseline on every rule", () => {
    const r = evaluateCandidate(fixtures, baseline, runs({ w1: 5, w2: 4, n1: 8, s1: 62 }));
    expect(failedRule(r)).toEqual([]);
    expect(r.pass).toBe(true);
    expect(r.fixtures).toHaveLength(4);
  });

  it("a) fails when fewer than 90% of fixtures keep the baseline letter", () => {
    // 60 D against 69 D keeps the letter; 60 against 70 moves to C. One of four fixtures moving is 75%.
    const r = evaluateCandidate(fixtures, baseline, runs({ ...BASE, s1: 71 }));
    expect(failedRule(r)).toContain("a");
  });

  it("a) fails when a fixture is two letters apart, even if 90% match", () => {
    const many: FixtureRef[] = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, kind: "contact_captured" as const }));
    const b = runs(Object.fromEntries(many.map((f) => [f.id, 85])));
    const c = runs(Object.fromEntries(many.map((f, i) => [f.id, i === 0 ? 65 : 85])));
    const r = evaluateCandidate(many, b, c);
    expect(r.rules.find((x) => x.id === "a")?.pass).toBe(false);
    expect(r.rules.find((x) => x.id === "a")?.detail).toContain("furthest apart 2 letters");
  });

  it("a) passes at exactly 90% with a one-letter move", () => {
    const many: FixtureRef[] = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, kind: "contact_captured" as const }));
    const b = runs(Object.fromEntries(many.map((f) => [f.id, 85])));
    const c = runs(Object.fromEntries(many.map((f, i) => [f.id, i === 0 ? 79 : 85])));
    expect(evaluateCandidate(many, b, c).rules.find((x) => x.id === "a")?.pass).toBe(true);
  });

  it("b) fails when the mean absolute difference is over 5 points, and passes at exactly 5", () => {
    const over = evaluateCandidate(fixtures, baseline, runs({ w1: 10, w2: 11, n1: 13, s1: 66 }));
    expect(over.rules.find((x) => x.id === "b")?.pass).toBe(false);
    const at = evaluateCandidate(fixtures, baseline, runs({ w1: 9, w2: 10, n1: 12, s1: 65 }));
    expect(at.rules.find((x) => x.id === "b")?.pass).toBe(true);
  });

  it("c) fails when any weak run credits information capture, but not name-only runs", () => {
    const candidate = runs({ w1: 4, w2: 5, n1: 7, s1: 60 });
    candidate.find((r) => r.fixtureId === "w2" && r.run === 2)!.infoCapture = INFO_CREDIT_THRESHOLD + 1;
    expect(failedRule(evaluateCandidate(fixtures, baseline, candidate))).toEqual(["c"]);

    const nameOnly = runs({ w1: 4, w2: 5, n1: 7, s1: 60 }).map((r) => (r.fixtureId === "n1" ? { ...r, infoCapture: 15 } : r));
    expect(evaluateCandidate(fixtures, baseline, nameOnly).rules.find((x) => x.id === "c")?.pass).toBe(true);
  });

  it("c) allows the small credit the baseline itself gave (2) and cannot pass with no weak runs", () => {
    const small = runs(BASE).map((r) => ({ ...r, infoCapture: 2 }));
    expect(evaluateCandidate(fixtures, baseline, small).rules.find((x) => x.id === "c")?.pass).toBe(true);
    const noWeak = evaluateCandidate([{ id: "s1", kind: "contact_captured" }], runs({ s1: 60 }), runs({ s1: 60 }));
    expect(noWeak.rules.find((x) => x.id === "c")?.pass).toBe(false);
  });

  it("d) fails on a single quote that is not verbatim", () => {
    const candidate = runs(BASE);
    candidate[0].quotesVerbatim = 3;
    expect(failedRule(evaluateCandidate(fixtures, baseline, candidate))).toEqual(["d"]);
  });

  it("e) fails when any run does not parse", () => {
    const candidate = runs(BASE);
    candidate[5] = { ...candidate[5], parsed: false };
    expect(evaluateCandidate(fixtures, baseline, candidate).rules.find((x) => x.id === "e")?.pass).toBe(false);
  });

  it("f) fails when p95 latency is more than 20% over the baseline, and passes at exactly 20%", () => {
    expect(evaluateCandidate(fixtures, baseline, runs(BASE, { latencyMs: 1201 })).rules.find((x) => x.id === "f")?.pass).toBe(false);
    expect(evaluateCandidate(fixtures, baseline, runs(BASE, { latencyMs: 1200 })).rules.find((x) => x.id === "f")?.pass).toBe(true);
    expect(evaluateCandidate(fixtures, baseline, runs(BASE, { latencyMs: 300 })).rules.find((x) => x.id === "f")?.pass).toBe(true);
  });

  it("a candidate that never parses fails and is not scored as a match", () => {
    const r = evaluateCandidate(fixtures, baseline, runs(BASE, { parsed: false }));
    expect(r.pass).toBe(false);
    expect(failedRule(r)).toEqual(expect.arrayContaining(["a", "b", "c", "e"]));
  });

  it("the baseline is compared against itself on the mean of its runs", () => {
    const wobbly = [run("w1", 2), run("w1", 6, { run: 2 }), run("w1", 4, { run: 3 })];
    const r = evaluateCandidate([{ id: "w1", kind: "weak_no_contact" }], wobbly, runs({ w1: 4 }));
    expect(r.fixtures[0]).toMatchObject({ baselineScore: 4, candidateScore: 4, absDiff: 0 });
  });
});

describe("helpers", () => {
  it("letterFor matches the app's gradeFor", () => {
    for (let s = 0; s <= 100; s++) expect(letterFor(s)).toBe(gradeFor(s));
  });

  it("percentile uses the nearest rank", () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 95)).toBe(19);
    expect(percentile([9, 1, 5], 50)).toBe(5);
  });

  it("isVerbatim ignores case, spacing and curly quotes, and rejects paraphrases", () => {
    const turns = [{ text: "Do you need my  address or something?" }, { text: "It’s Dana." }];
    expect(isVerbatim("do you need my address", turns)).toBe(true);
    expect(isVerbatim("It's Dana", turns)).toBe(true);
    expect(isVerbatim("the caller offered her address", turns)).toBe(false);
    expect(isVerbatim("  ", turns)).toBe(false);
  });

  it("renders a markdown report with the verdict and every rule", () => {
    const result = evaluateCandidate(fixtures, baseline, runs(BASE, { latencyMs: 5000 }));
    const md = renderReport({ baselineModel: "base-m", candidateModel: "cand-m", runsPerFixture: 3, result, when: "2026-11-01T00:00:00Z" });
    expect(md).toContain("# Grading regression: cand-m against base-m");
    expect(md).toContain("Verdict: **FAIL**");
    expect(md).toContain("must not become LLM_MODEL_GRADE");
    for (const id of ["a)", "b)", "c)", "d)", "e)", "f)"]) expect(md).toContain(`| ${id} `);
    expect(md).not.toContain("—");
  });
});

describe("grading fixtures", () => {
  const dir = path.resolve(__dirname, "fixtures/grading");
  const all = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")));

  it("each fixture is well formed and matches its scenario", () => {
    expect(all.length).toBeGreaterThanOrEqual(9);
    for (const f of all) {
      const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === f.scenarioId);
      expect(scenario, f.id).toBeTruthy();
      expect(["weak_no_contact", "name_only", "contact_captured"]).toContain(f.kind);
      expect(f.transcript.length).toBeGreaterThan(1);
      expect(f.transcript.every((t: { role: string; text: string }) => (t.role === "user" || t.role === "assistant") && t.text.trim())).toBe(true);
      // Recorded criteria use the persona's rubric ids, and the weighted score and letter agree with them.
      const ids = scenario!.rubric.map((c) => c.id).sort();
      expect(Object.keys(f.recorded.criteria).sort()).toEqual(ids);
      const total = scenario!.rubric.reduce((a, c) => a + c.weight, 0);
      const weighted = Math.round(scenario!.rubric.reduce((a, c) => a + f.recorded.criteria[c.id] * c.weight, 0) / total);
      expect(weighted, f.id).toBe(f.recorded.score);
      expect(letterFor(f.recorded.score)).toBe(f.recorded.letter);
      expect(f.recorded.infoCapture).toBe(f.recorded.criteria.capture);
    }
  });

  it("weak no-contact fixtures never have the trainee ask for contact details, and the rest do", () => {
    const asks = /\b(address|phone|number|callback)\b/i;
    for (const f of all) {
      const traineeAsked = f.transcript.some((t: { role: string; text: string }) => t.role === "user" && asks.test(t.text));
      if (f.kind === "weak_no_contact") expect(traineeAsked, f.id).toBe(false);
      if (f.kind === "contact_captured") expect(traineeAsked, f.id).toBe(true);
    }
  });

  it("uses no real names: only the fictional caller and trainee names", () => {
    for (const f of all) expect(JSON.stringify(f)).not.toMatch(/mykel/i);
  });
});
