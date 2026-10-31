import { describe, expect, it } from "vitest";
import { detectPriceQuote, gradeHeuristically, type Turn } from "@/lib/grader";
import { isFirstGradedCall, nextStepLine, scoreHeadline } from "@/lib/debrief";
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
  it("words the next step with score and weight", () => {
    expect(nextStepLine({ name: "Greeting & rapport", score: 35, weight: 15 })).toBe("You scored 35% on Greeting & rapport (worth 15%).");
  });
});
