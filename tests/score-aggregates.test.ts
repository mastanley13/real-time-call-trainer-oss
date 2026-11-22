import { describe, expect, it } from "vitest";
import { aggregateScore, averageScore, bestScore, isLlmFailedEvaluation, trendPoints } from "@/lib/scoreAggregates";
import { buildOverview, gradeOf, scoreOf, sparkline, type TeamMember, type TeamSession } from "@/lib/team";

/**
 * Failed AI grades (evaluation.llmFailed) keep a rules-based rough score in the stored row. That score must stay out
 * of every score aggregate on the rep dashboard and in the team view, while the call still counts as a call.
 */

const FAILED = { method: "heuristic", graderVersion: "heuristic-v2", llmFailed: true, criteria: [{ name: "Discovery", score: 5 }] };
const RULES = { method: "heuristic", graderVersion: "heuristic-v2", criteria: [{ name: "Discovery", score: 70 }] };
const AI = { method: "llm", graderVersion: "llm-v2", criteria: [{ name: "Discovery", score: 82 }] };

describe("aggregateScore (the one include/exclude rule)", () => {
  it("keeps a finite score and drops a failed-grade rough score", () => {
    expect(aggregateScore({ score: 64 })).toBe(64);
    expect(aggregateScore({ score: 64, llmFailed: false })).toBe(64);
    expect(aggregateScore({ score: 12, llmFailed: true })).toBeNull();
  });

  it("drops missing and non-finite scores", () => {
    for (const score of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(aggregateScore({ score })).toBeNull();
  });
});

describe("isLlmFailedEvaluation", () => {
  it("reads the stored flag on a non-AI grade only", () => {
    expect(isLlmFailedEvaluation(FAILED)).toBe(true);
    expect(isLlmFailedEvaluation(RULES)).toBe(false);
    expect(isLlmFailedEvaluation({ ...AI, llmFailed: true })).toBe(false);
    expect(isLlmFailedEvaluation({ method: "heuristic", llmFailed: "true" })).toBe(false);
    for (const v of [null, undefined, "x", 3, [], [FAILED]]) expect(isLlmFailedEvaluation(v)).toBe(false);
  });
});

describe("dashboard aggregates", () => {
  // Newest first, the way the dashboard orders rows.
  const clean = [{ id: "c", score: 80 }, { id: "b", score: null }, { id: "a", score: 60 }].map((r) => ({ ...r, llmFailed: false }));
  const failed = [{ id: "f1", score: 10, llmFailed: true }, { id: "f2", score: 99, llmFailed: true }];
  const mixed = [failed[0], ...clean.slice(0, 2), failed[1], clean[2]];

  it("average and best ignore failed-grade scores", () => {
    expect(averageScore(mixed)).toBe(70);
    expect(bestScore(mixed)).toBe(80);
  });

  it("are unchanged when there are no failed grades", () => {
    expect(averageScore(clean)).toBe(70);
    expect(bestScore(clean)).toBe(80);
    expect(averageScore(clean)).toBe(averageScore(mixed));
    expect(bestScore(clean)).toBe(bestScore(mixed));
  });

  it("are null when only failed grades have scores", () => {
    expect(averageScore(failed)).toBeNull();
    expect(bestScore(failed)).toBeNull();
    expect(averageScore([])).toBeNull();
  });

  it("the trend skips failed grades, keeps order oldest first, and caps the count", () => {
    expect(trendPoints(mixed).map((r) => r.id)).toEqual(["a", "c"]);
    expect(trendPoints(clean).map((r) => r.id)).toEqual(["a", "c"]);
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, score: i, llmFailed: i % 3 === 0 }));
    const pts = trendPoints(many, 5);
    expect(pts.map((r) => r.id)).toEqual(["r7", "r5", "r4", "r2", "r1"]);
    expect(pts.every((r) => !r.llmFailed)).toBe(true);
  });
});

describe("team math", () => {
  it("scoreOf and gradeOf leave out a failed grade's score and criteria, and mark it pending", () => {
    expect(scoreOf(12, FAILED)).toBeNull();
    expect(gradeOf(12, FAILED)).toEqual({ score: null, criteria: [], scorePending: true });
    // Unchanged for everything else, including the exact shape.
    expect(gradeOf(70, RULES)).toEqual({ score: 70, criteria: [{ name: "Discovery", score: 70 }] });
    expect(gradeOf(82, AI)).toEqual({ score: 82, criteria: [{ name: "Discovery", score: 82 }] });
  });

  const now = new Date("2026-11-20T12:00:00Z");
  const ago = (d: number) => new Date(now.getTime() - d * 86_400_000).toISOString();
  const members: TeamMember[] = [{ id: "ana", name: "Ana", role: "trainee" }, { id: "ben", name: "Ben", role: "trainee" }];
  const session = (id: string, userId: string, daysAgo: number, overallScore: number, evaluation: unknown): TeamSession => ({
    id, userId, scenarioId: "quote-follow-up", scenarioTitle: "Quote follow-up", goalAchieved: true,
    ...gradeOf(overallScore, evaluation), createdAt: ago(daysAgo), hasNotes: false,
  });
  const base = [
    session("a1", "ana", 5, 80, AI),
    session("a2", "ana", 3, 60, RULES),
    session("b1", "ben", 4, 90, AI),
  ];
  // Very low and very high rough scores, so including either would move every aggregate.
  const withFailed = [...base, session("a3", "ana", 1, 5, FAILED), session("b2", "ben", 2, 100, FAILED)];
  const overview = (sessions: TeamSession[]) =>
    buildOverview({ org: { id: "o", name: "Org" }, days: 30, now, members, sessions, libraryIds: ["quote-follow-up"] });

  it("team and per-rep averages, sparklines and the matrix ignore failed grades", () => {
    const clean = overview(base);
    const mixed = overview(withFailed);
    expect(mixed.kpis.avgScore).toBe(clean.kpis.avgScore);
    expect(mixed.kpis.avgScore).toBe(77);
    for (const id of ["ana", "ben"]) {
      const c = clean.roster.find((r) => r.id === id)!;
      const m = mixed.roster.find((r) => r.id === id)!;
      expect(m.avgScore).toBe(c.avgScore);
      expect(m.spark).toEqual(c.spark);
      expect(m.weakestScore).toBe(c.weakestScore);
    }
    expect(mixed.matrix).toEqual(clean.matrix);
    expect(sparkline(withFailed.filter((s) => s.userId === "ana"))).toEqual([80, 60]);
  });

  it("a failed-grade call still counts as a session and shows as pending, not as a score", () => {
    const mixed = overview(withFailed);
    expect(mixed.kpis.sessions).toBe(5);
    const ana = mixed.roster.find((r) => r.id === "ana")!;
    expect(ana.sessions).toBe(3);
    expect(ana.lastScore).toBeNull();
    expect(ana.lastScorePending).toBe(true);
    // A failed grade never lands in the coaching queue on its rough score.
    expect(mixed.queue.some((q) => q.sessionId === "a3" || q.sessionId === "b2")).toBe(false);
  });

  it("is unchanged when there are no failed grades", () => {
    const clean = overview(base);
    expect(clean.kpis).toMatchObject({ sessions: 3, avgScore: 77 });
    const ana = clean.roster.find((r) => r.id === "ana")!;
    expect(ana).toMatchObject({ avgScore: 70, lastScore: 60, lastScorePending: false, spark: [80, 60] });
  });
});
