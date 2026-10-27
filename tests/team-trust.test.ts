import { describe, expect, it } from "vitest";
import { gradeOf, isOverdue, weakestAcross, withRetention, type AssignmentProgress, type TeamSession } from "@/lib/team";

const legacy = { method: "heuristic", overallScore: 40, criteria: [{ name: "Discovery", score: 20 }] };
const current = { method: "llm", graderVersion: "llm-v2", overallScore: 80, criteria: [{ name: "Discovery", score: 75 }] };

const session = (id: string, g: { score: number | null; criteria: { name: string; score: number }[] }): TeamSession => ({
  id, userId: "rep-1", scenarioId: "p", scenarioTitle: "Persona", goalAchieved: null, createdAt: "2026-10-20T10:00:00.000Z", hasNotes: false, ...g,
});

describe("gradeOf", () => {
  it("drops criteria together with the score for legacy keyword-grader evaluations", () => {
    expect(gradeOf(40, legacy)).toEqual({ score: null, criteria: [] });
  });

  it("keeps both for current graders", () => {
    expect(gradeOf(80, current)).toEqual({ score: 80, criteria: [{ name: "Discovery", score: 75 }] });
  });

  it("ignores criteria on an ungraded row", () => {
    expect(gradeOf(null, current)).toEqual({ score: null, criteria: [] });
  });

  it("keeps legacy rows out of the weakest criterion", () => {
    const sessions = [1, 2, 3].map((n) => session(`l${n}`, gradeOf(40, legacy)));
    expect(weakestAcross(sessions)).toBeNull();
    expect(weakestAcross([...sessions, session("c1", gradeOf(80, current))])).toMatchObject({ name: "Discovery", avg: 75, n: 1 });
  });
});

describe("withRetention", () => {
  const now = new Date("2026-10-27T12:00:00.000Z");
  const open: AssignmentProgress = { done: 0, total: 1, lastDoneAt: null, sessionId: null };
  const done: AssignmentProgress = { done: 1, total: 1, lastDoneAt: "2026-10-01T00:00:00.000Z", sessionId: "s1" };

  it("flags incomplete assignments older than the retention window", () => {
    expect(withRetention(open, "2026-09-01T00:00:00.000Z", 30, now).historyPurged).toBe(true);
  });

  it("leaves recent, complete or retention-free assignments alone", () => {
    expect(withRetention(open, "2026-10-20T00:00:00.000Z", 30, now).historyPurged).toBeUndefined();
    expect(withRetention(done, "2026-09-01T00:00:00.000Z", 30, now)).toBe(done);
    expect(withRetention(open, "2026-01-01T00:00:00.000Z", null, now)).toBe(open);
  });

  it("never marks a possibly-purged assignment overdue", () => {
    const progress = withRetention(open, "2026-09-01T00:00:00.000Z", 30, now);
    expect(isOverdue({ dueAt: "2026-09-10T00:00:00.000Z", progress }, now)).toBe(false);
    expect(isOverdue({ dueAt: "2026-09-10T00:00:00.000Z", progress: open }, now)).toBe(true);
  });
});
