import { describe, expect, it } from "vitest";
import { detectPriceQuote, gradeHeuristically, pricingCriterion, type Turn } from "@/lib/grader";
import { isFirstGradedCall, nextStepLine, resolveFirstCall, scoreHeadline } from "@/lib/debrief";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const pricing = (ev: ReturnType<typeof gradeHeuristically>) => ev.criteria.find((c) => c.id === "fee")!;

const call = (...reps: string[]): Turn[] =>
  reps.flatMap((text, i) => [{ role: "assistant" as const, text: i === 0 ? scenario.aiPersona.openingLine : "Okay, go on." }, { role: "user" as const, text }]);

const OPEN = "Thanks for calling Apex Plumbing, this is Sam. How long has it been leaking?";
const WITH_FEE = call(OPEN, "The visit costs $89 and we credit it toward the repair.", "Does tomorrow morning work?");
const NO_FEE = call(OPEN, "We send a technician out and look at it.", "Does tomorrow morning work?");

describe("price detector", () => {
  it("finds dollar figures, spelled amounts and zero-cost statements", () => {
    for (const t of ["It's $89.", "That is 89 dollars.", "About ninety bucks.", "There is no charge for the estimate."]) {
      expect(detectPriceQuote([{ text: t }]).quoted, t).toBeDefined();
    }
  });
  it("ignores sentences without a price", () => {
    expect(detectPriceQuote([{ text: "I can come at 2 pm tomorrow." }, { text: "We fix leaks fast." }]).quoted).toBeUndefined();
  });
  it("marks a number that is framed as a fee", () => {
    expect(detectPriceQuote([{ text: "The fee is $89." }]).framed).toBeDefined();
    expect(detectPriceQuote([{ text: "Eighty nine dollars, all in." }]).framed).toBeUndefined();
  });
  it("finds spelled-out amounts from voice transcripts, single and compound", () => {
    for (const t of ["Eighty nine dollars, all in.", "The fee is five dollars.", "It runs eighty-nine dollars.", "Two hundred and fifty dollars flat.", "That is a hundred bucks."]) {
      expect(detectPriceQuote([{ text: t }]).quoted, t).toBeDefined();
    }
    expect(detectPriceQuote([{ text: "The fee is five dollars." }]).framed).toBeDefined();
  });
  it("credits only an affirmative zero-cost statement", () => {
    for (const t of ["The estimate is free of charge.", "There is no charge for the visit.", "I can waive the fee today.", "The diagnostic is complimentary."]) {
      expect(detectPriceQuote([{ text: t }]).quoted, t).toBeDefined();
    }
    for (const t of ["The fee cannot be waived.", "No charge has been determined yet.", "I don't know if there is no charge.", "The fee is waived only if you book."]) {
      expect(detectPriceQuote([{ text: t }]).quoted, t).toBeUndefined();
    }
  });
});

describe("pricing criterion matching", () => {
  it("matches pricing words, not substrings of other words", () => {
    for (const [id, name] of [["fee", "Pricing transparency"], ["price_value", "Value"], ["quote", "Clear quote"], ["x", "Rates and fees"]]) {
      expect(pricingCriterion(id, name), `${id} ${name}`).toBe(true);
    }
    for (const [id, name] of [["accuracy", "Accurate claims and due diligence"], ["details", "Accurate reservation details"], ["x", "Corporate tone"], ["x", "Generate interest"]]) {
      expect(pricingCriterion(id, name), `${id} ${name}`).toBe(false);
    }
  });
  it("gives no pricing bonus or dollar-amount fix to an unrelated criterion", () => {
    const sc = { ...scenario, rubric: [{ id: "accuracy", name: "Accurate claims and due diligence", description: "States facts correctly.", weight: 100 }] };
    const ev = gradeHeuristically(sc, call(OPEN, "The visit costs $89."));
    expect(ev.criteria[0].rationale).not.toMatch(/price/i);
    expect(ev.improvements.join(" ")).not.toContain("dollar amount");
  });
});

describe("heuristic grading, first-call friendliness", () => {
  it("scores a quoted fee clearly higher on Pricing than a call that never states one", () => {
    const withFee = pricing(gradeHeuristically(scenario, WITH_FEE));
    const without = pricing(gradeHeuristically(scenario, NO_FEE));
    expect(withFee.score).toBeGreaterThanOrEqual(without.score + 20);
    expect(withFee.evidence[0].quote).toContain("$89");
  });

  it("always shows at least one strength for a reasonable first call, and at most two", () => {
    const ev = gradeHeuristically(scenario, NO_FEE);
    expect(ev.strengths.length).toBeGreaterThanOrEqual(1);
    expect(ev.strengths.length).toBeLessThanOrEqual(2);
    const best = [...ev.criteria].sort((a, b) => b.score - a.score)[0];
    expect(ev.strengths[0]).toContain(best.name);
  });

  it("shows no strengths when the rep said nothing", () => {
    expect(gradeHeuristically(scenario, [{ role: "assistant", text: "Hello?" }]).strengths).toEqual([]);
  });

  it("names the weakest criterion with its weight and score in each Improve item", () => {
    const ev = gradeHeuristically(scenario, NO_FEE);
    expect(ev.improvements.length).toBeGreaterThanOrEqual(1);
    for (const line of ev.improvements) {
      const c = ev.criteria.find((x) => line.startsWith(`${x.name} (worth ${Math.round(x.weight)}%): you scored ${x.score}%.`));
      expect(c, line).toBeDefined();
      expect(line).toMatch(/Work in .+\.|more completely/);
    }
    expect(ev.improvements.some((l) => l.includes("an actual dollar amount"))).toBe(true);
    expect(new Set(ev.improvements).size).toBe(ev.improvements.length);
  });

  it("keeps the automatic estimate label", () => {
    const ev = gradeHeuristically(scenario, NO_FEE);
    expect(ev.summary).toMatch(/^Automatic estimate:/);
    expect(ev.note).toMatch(/automatic estimate/);
  });
});

describe("baseline framing", () => {
  const ev = { overallScore: 41, grade: "F" as const };
  it("shows a first call as a baseline, never a bare grade", () => {
    const h = scoreHeadline(ev, true);
    expect(h.ring).toBe("Baseline");
    expect(h.label).toBe("Your baseline: 41%");
    expect(JSON.stringify(h)).not.toMatch(/Grade|\bF\b/);
  });
  it("shows the grade on later calls", () => {
    expect(scoreHeadline(ev, false)).toEqual({ ring: "Grade F" });
  });
  it("detects the first graded call, ignoring ungraded and later ones", () => {
    const at = "2026-01-02T00:00:00Z";
    expect(isFirstGradedCall(at, [])).toBe(true);
    expect(isFirstGradedCall(at, [{ createdAt: "2026-01-01T00:00:00Z", graded: false }, { createdAt: "2026-01-03T00:00:00Z", graded: true }])).toBe(true);
    expect(isFirstGradedCall(at, [{ createdAt: "2026-01-01T00:00:00Z", graded: true }])).toBe(false);
  });
  it("treats unresolved or other-session state as a baseline, so navigating never shows a stale grade", () => {
    expect(resolveFirstCall(null, "b")).toBe(true);
    expect(resolveFirstCall({ sessionId: "a", first: false }, "b")).toBe(true);
    expect(resolveFirstCall({ sessionId: "b", first: false }, "b")).toBe(false);
    // A late answer for session "a" cannot flip session "b": the state carries its own id.
    let state = { sessionId: "a", first: false };
    expect(resolveFirstCall(state, "a")).toBe(false);
    state = { sessionId: "a", first: false };
    expect(resolveFirstCall(state, "b")).toBe(true);
  });
  it("words the next step with score and weight", () => {
    expect(nextStepLine({ name: "Greeting & rapport", score: 35, weight: 15 })).toBe("You scored 35% on Greeting & rapport (worth 15%).");
  });
});
