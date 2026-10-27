import { beforeEach, describe, expect, it } from "vitest";
import { LIBRARY } from "@/lib/personas";
import {
  assignmentInputMessage, assignmentProgress, AssignmentInputSchema, average, buildMatrix, buildOverview, buildQueue, canManageTeam,
  completedBy, criteriaOf, csvCell, dueLabel, isOverdue, memberName, parseDueAt, parseWindow, progressFor, relativeDay, rosterCsv,
  scoreBand, scoreOf, sessionReasons, sortForAssignee, sparkline, summarizeAssignments, teamIdsOf, toAssignmentView, topCriteria,
  weakestAcross, weakestCriterion, type Assignment, type AssignmentView, type TeamMember, type TeamSession,
} from "@/lib/team";
import { buildSampleOverview, isSampleId, SAMPLE_CRITERIA } from "@/lib/teamSample";

const NOW = new Date("2026-10-27T15:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

let n = 0;
function session(p: Partial<TeamSession> & { userId: string }): TeamSession {
  n++;
  return { id: `s${n}`, scenarioId: "sc-a", scenarioTitle: "Scenario A", score: 75, goalAchieved: true, criteria: [], createdAt: ago(1), hasNotes: false, ...p };
}
const crit = (pairs: Record<string, number>) => Object.entries(pairs).map(([name, score]) => ({ name, score }));

const MEMBERS: TeamMember[] = [
  { id: "u1", name: "Ana Ruiz", role: "trainee" },
  { id: "u2", name: "Ben Ode", role: "trainee" },
  { id: "m1", name: "Mia Chen", role: "manager" },
];

function assignment(p: Partial<Assignment> = {}): Assignment {
  return { id: "a1", assignedById: "m1", assigneeId: null, scenarioId: "sc-a", scenarioTitle: "Scenario A", note: null, dueAt: null, createdAt: ago(5), archivedAt: null, ...p };
}

describe("access and parsing", () => {
  it("lets managers, owners and platform admins in, and nobody else", () => {
    expect(canManageTeam("manager")).toBe(true);
    expect(canManageTeam("owner")).toBe(true);
    expect(canManageTeam("trainee")).toBe(false);
    expect(canManageTeam(undefined)).toBe(false);
    expect(canManageTeam("trainee", true)).toBe(true);
  });

  it("accepts only 7, 30 or 90 day windows", () => {
    expect(parseWindow("7")).toBe(7);
    expect(parseWindow(90)).toBe(90);
    expect(parseWindow("14")).toBe(30);
    expect(parseWindow(null)).toBe(30);
  });

  it("builds display names without exposing full emails", () => {
    expect(memberName({ firstName: "Ana", lastName: "Ruiz", email: "ana@x.io" })).toBe("Ana Ruiz");
    expect(memberName({ firstName: null, lastName: null, email: "ben.ode@x.io" })).toBe("ben.ode");
  });
});

describe("criteria and scores", () => {
  it("reads criteria from evaluation JSON and skips malformed entries", () => {
    expect(criteriaOf({ criteria: [{ name: " Discovery ", score: 72 }, { name: "", score: 50 }, { name: "Close", score: "80" }, { name: "Tone", score: 140 }] }))
      .toEqual([{ name: "Discovery", score: 72 }, { name: "Tone", score: 100 }]);
    expect(criteriaOf(null)).toEqual([]);
    expect(criteriaOf({ criteria: "nope" })).toEqual([]);
  });

  it("drops legacy keyword-grader scores from team math", () => {
    expect(scoreOf(64, { method: "heuristic" })).toBeNull();
    expect(scoreOf(64, { method: "heuristic", graderVersion: "heuristic-v2" })).toBe(64);
    expect(scoreOf(64, { method: "llm" })).toBe(64);
    expect(scoreOf(null, { method: "llm" })).toBeNull();
  });

  it("averages, rounding and ignoring nulls", () => {
    expect(average([70, 71, null, undefined])).toBe(71);
    expect(average([])).toBeNull();
  });

  it("finds the weakest criterion per session and across sessions", () => {
    expect(weakestCriterion(crit({ A: 60, B: 55, C: 55 }))).toEqual({ name: "B", score: 55 });
    expect(weakestCriterion([])).toBeNull();
    const list = [session({ userId: "u1", criteria: crit({ A: 50, B: 90 }) }), session({ userId: "u1", criteria: crit({ A: 80, B: 60 }) })];
    expect(weakestAcross(list)).toEqual({ name: "A", avg: 65, n: 2 });
  });

  it("keeps the last eight graded scores, oldest first", () => {
    const list = Array.from({ length: 10 }, (_, i) => session({ userId: "u1", score: i === 3 ? null : 50 + i, createdAt: ago(10 - i) }));
    expect(sparkline(list.reverse())).toEqual([51, 52, 54, 55, 56, 57, 58, 59]);
  });

  it("bands scores on the shared ramp", () => {
    expect(scoreBand(80)).toBe("ok");
    expect(scoreBand(79)).toBe("signal");
    expect(scoreBand(60)).toBe("signal");
    expect(scoreBand(59)).toBe("caution");
    expect(scoreBand(null)).toBe("none");
  });
});

describe("matrix", () => {
  it("picks the most common criteria and leaves gaps as null", () => {
    const list = [
      session({ userId: "u1", criteria: crit({ Discovery: 70, Close: 50 }) }),
      session({ userId: "u1", criteria: crit({ Discovery: 80 }) }),
      session({ userId: "u2", criteria: crit({ Discovery: 60, Tone: 90 }) }),
    ];
    const cols = topCriteria(list, 2);
    expect(cols).toEqual(["Discovery", "Close"]);
    const m = buildMatrix([{ id: "u1", name: "Ana" }, { id: "u2", name: "Ben" }], list, cols);
    expect(m.rows[0].cells).toEqual([75, 50]);
    expect(m.rows[0].counts).toEqual([2, 1]);
    expect(m.rows[1].cells).toEqual([60, null]);
  });
});

describe("coaching queue", () => {
  it("explains low scores and missed goals in plain words", () => {
    expect(sessionReasons({ score: 52, goalAchieved: false }).map((r) => r.label)).toEqual(["Scored 52, under 60", "Missed the call goal"]);
    expect(sessionReasons({ score: 60, goalAchieved: null })).toEqual([]);
  });

  it("flags a repeated weak spot once, on the latest call, only when it scored under 70", () => {
    const weak = (d: number, score = 62) => session({ userId: "u1", score: 72, criteria: crit({ Objections: score, Discovery: 85 }), createdAt: ago(d) });
    const list = [weak(9), weak(6), weak(3), session({ userId: "u2", score: 90, criteria: crit({ Close: 75, Tone: 88 }) })];
    const q = buildQueue(list, MEMBERS);
    expect(q).toHaveLength(1);
    expect(q[0].sessionId).toBe(list[2].id);
    expect(q[0].reasons).toEqual([{ kind: "repeat_weakness", label: "Weakest on Objections 3 times" }]);
    expect(buildQueue([weak(9, 75), weak(6, 75), weak(3, 75)], MEMBERS)).toEqual([]);
  });

  it("puts unnoted items first, then more reasons, then newest", () => {
    const a = session({ userId: "u1", score: 40, goalAchieved: false, hasNotes: true, createdAt: ago(1) });
    const b = session({ userId: "u2", score: 55, createdAt: ago(3) });
    const c = session({ userId: "u2", score: 50, goalAchieved: false, createdAt: ago(5) });
    const d = session({ userId: "gone", score: 45, createdAt: ago(2) });
    const q = buildQueue([a, b, c, d], MEMBERS);
    expect(q.map((x) => x.sessionId)).toEqual([c.id, d.id, b.id, a.id]);
    expect(q[1].repName).toBe("Former member");
    expect(q[0].reason).toBe("Scored 50, under 60 · Missed the call goal");
  });
});

describe("assignments", () => {
  const sessions = [
    { id: "x1", userId: "u1", scenarioId: "sc-a", createdAt: ago(7) }, // before the assignment
    { id: "x2", userId: "u1", scenarioId: "sc-b", createdAt: ago(2) }, // other persona
    { id: "x3", userId: "u2", scenarioId: "sc-a", createdAt: ago(1) },
  ];

  it("counts only sessions on the same persona after the assignment", () => {
    const a = assignment();
    expect(completedBy(a, "u1", sessions)).toBeNull();
    expect(completedBy(a, "u2", sessions)?.id).toBe("x3");
  });

  it("tracks whole-team progress across reps and individual progress for one", () => {
    const team = teamIdsOf(MEMBERS);
    expect(team).toEqual(["u1", "u2"]);
    expect(assignmentProgress(assignment(), sessions, team)).toEqual({ done: 1, total: 2, lastDoneAt: ago(1), sessionId: null });
    expect(assignmentProgress(assignment({ assigneeId: "u2" }), sessions, team)).toEqual({ done: 1, total: 1, lastDoneAt: ago(1), sessionId: "x3" });
    expect(progressFor(assignment(), "u1", sessions).done).toBe(0);
  });

  it("summarizes, flags overdue work and sorts open work first", () => {
    const names = new Map(MEMBERS.map((m) => [m.id, m.name]));
    const views: AssignmentView[] = [
      toAssignmentView(assignment({ id: "done", assigneeId: "u2" }), names, { done: 1, total: 1, lastDoneAt: ago(1), sessionId: "x3" }),
      toAssignmentView(assignment({ id: "late", assigneeId: "u1", dueAt: ago(1) }), names, { done: 0, total: 1, lastDoneAt: null, sessionId: null }),
      toAssignmentView(assignment({ id: "team", dueAt: ago(-3) }), names, { done: 1, total: 2, lastDoneAt: null, sessionId: null }),
    ];
    expect(views[1].assigneeName).toBe("Ana Ruiz");
    expect(views[2].assigneeName).toBeNull();
    expect(views[0].assignedByName).toBe("Mia Chen");
    expect(isOverdue(views[1], NOW)).toBe(true);
    expect(isOverdue(views[2], NOW)).toBe(false);
    expect(summarizeAssignments(views, NOW)).toEqual({ active: 3, teamWide: 1, completed: 1, overdue: 1 });
    expect(sortForAssignee(views).map((v) => v.id)).toEqual(["late", "team", "done"]);
  });

  it("validates due dates and input", () => {
    expect(parseDueAt(undefined, NOW)).toEqual({ ok: true, value: null });
    expect(parseDueAt("2026-11-03", NOW)).toEqual({ ok: true, value: new Date("2026-11-03T23:59:59.999Z") });
    expect(parseDueAt("2026-11-03T17:00:00.000Z", NOW).ok).toBe(true);
    expect(parseDueAt("next friday", NOW).ok).toBe(false);
    expect(parseDueAt("2026-02-31", NOW).ok).toBe(false);
    expect(parseDueAt("2020-01-01", NOW).ok).toBe(false);
    expect(parseDueAt("2028-01-01", NOW).ok).toBe(false);
    const bad = AssignmentInputSchema.safeParse({ scenarioId: "sc-a", scenarioTitle: "A", note: "x".repeat(501) });
    expect(bad.success).toBe(false);
    expect(assignmentInputMessage(bad.success ? null : bad.error.issues[0].path[0])).toBe("Keep the note under 500 characters.");
    expect(AssignmentInputSchema.safeParse({ scenarioId: "x".repeat(81), scenarioTitle: "A" }).success).toBe(false);
    expect(AssignmentInputSchema.safeParse({ scenarioId: "sc-a", scenarioTitle: "A", assigneeId: null }).success).toBe(true);
  });
});

describe("overview", () => {
  it("computes KPIs, roster and coverage from sessions", () => {
    const sessions = [
      session({ userId: "u1", score: 50, goalAchieved: false, scenarioId: LIBRARY[0].id, criteria: crit({ Discovery: 40 }), createdAt: ago(2) }),
      session({ userId: "u1", score: 70, scenarioId: LIBRARY[1].id, criteria: crit({ Discovery: 70 }), createdAt: ago(4) }),
      session({ userId: "u1", score: 90, scenarioId: LIBRARY[2].id, createdAt: ago(40) }), // outside a 30-day window
      session({ userId: "m1", score: 88, scenarioId: "custom-x", createdAt: ago(3) }),
    ];
    const o = buildOverview({ org: { id: "o", name: "Org" }, days: 30, now: NOW, members: MEMBERS, sessions, libraryIds: LIBRARY.map((s) => s.id), lastSeen: { u2: ago(200) } });
    expect(o.kpis.sessions).toBe(3);
    expect(o.kpis.activeReps).toBe(2);
    expect(o.kpis.totalReps).toBe(3);
    expect(o.kpis.avgScore).toBe(69);
    expect(o.kpis.coverage).toEqual({ practised: 2, library: LIBRARY.length, pct: Math.round((2 / LIBRARY.length) * 100) });
    const ana = o.roster.find((r) => r.id === "u1")!;
    expect(ana).toMatchObject({ sessions: 2, avgScore: 60, lastScore: 50, weakest: "Discovery", weakestScore: 55, spark: [90, 70, 50] });
    expect(o.roster.find((r) => r.id === "u2")).toMatchObject({ sessions: 0, avgScore: null, lastSessionAt: ago(200) });
    expect(o.queue.map((q) => q.sessionId)).toEqual([sessions[0].id]);
    expect(o.sample).toBe(false);
  });
});

describe("display helpers", () => {
  it("formats relative days and due labels", () => {
    expect(relativeDay(NOW.toISOString(), NOW)).toBe("today");
    expect(relativeDay(ago(1), NOW)).toBe("yesterday");
    expect(relativeDay(ago(4), NOW)).toBe("4 days ago");
    expect(dueLabel(ago(-3), NOW)).toBe("Due in 3 days");
    expect(dueLabel(ago(2), NOW)).toBe("Overdue by 2 days");
    expect(dueLabel(ago(-1), NOW)).toBe("Due tomorrow");
  });

  it("escapes CSV and defuses spreadsheet formulas", () => {
    expect(csvCell('Says "hi", then leaves')).toBe('"Says ""hi"", then leaves"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(null)).toBe("");
    const csv = rosterCsv([{ id: "u1", name: "Ana, R", role: "trainee", sessions: 2, avgScore: 60, lastSessionAt: "2026-10-25T10:00:00.000Z", lastScore: 50, weakest: "Discovery", weakestScore: 55, spark: [70, 50] }], 30);
    expect(csv.split("\r\n")[1]).toBe('"Ana, R",Rep,2,60,2026-10-25,50,Discovery,55,70 50');
  });
});

describe("sample team", () => {
  it("is deterministic, labelled and built from real library personas", () => {
    const viewer = { id: "demo-user", name: "Demo User" };
    const a = buildSampleOverview(30, NOW, viewer);
    const b = buildSampleOverview(30, new Date(NOW.getTime() + 20 * 60_000), viewer);
    expect(a).toEqual(b);
    expect(a.sample).toBe(true);
    const ids = new Set(LIBRARY.map((s) => s.id));
    expect(a.queue.length).toBeGreaterThan(0);
    expect(a.queue.every((q) => ids.has(q.scenarioId) && isSampleId(q.sessionId))).toBe(true);
    expect(a.matrix.criteria.every((c) => SAMPLE_CRITERIA.includes(c))).toBe(true);
    expect(a.matrix.criteria).toContain("Objection handling");
    expect(a.matrix.rows.some((r) => r.cells.includes(null))).toBe(true);
    expect(a.members.find((m) => m.id === "demo-user")?.role).toBe("owner");
    expect(a.queue.some((q) => q.reasons.some((r) => r.kind === "repeat_weakness"))).toBe(true);
  });

  it("keeps the same team across windows", () => {
    const week = buildSampleOverview(7, NOW);
    const quarter = buildSampleOverview(90, NOW);
    expect(week.roster.map((r) => r.id)).toEqual(quarter.roster.map((r) => r.id));
    expect(week.kpis.sessions).toBeLessThan(quarter.kpis.sessions);
    expect(week.roster.find((r) => r.name === "Luis Moreno")?.sessions).toBe(0);
  });
});

describe("demo assignment store", () => {
  const mem = new Map<string, string>();
  beforeEach(() => {
    mem.clear();
    // Newer Node versions define a read-only localStorage, so redefine rather than assign.
    const define = (key: string, value: unknown) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    define("localStorage", { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) });
    define("window", { dispatchEvent: () => true });
  });

  it("creates, validates and archives assignments in the browser", async () => {
    const store = await import("@/lib/assignmentStore");
    const ok = store.createLocalAssignment({ scenarioId: "sc-a", scenarioTitle: "Scenario A", assigneeId: null, note: "  focus on price  ", dueAt: null }, "demo-user");
    expect(ok.ok).toBe(true);
    const list = store.listLocalAssignments();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ assignedById: "demo-user", assigneeId: null, note: "focus on price" });
    expect(store.createLocalAssignment({ scenarioId: "", scenarioTitle: "A" }, "demo-user")).toEqual({ ok: false, message: "Pick a persona to assign." });
    expect(store.createLocalAssignment({ scenarioId: "sc-a", scenarioTitle: "A", dueAt: "soon" }, "demo-user").ok).toBe(false);
    store.archiveLocalAssignment(list[0].id);
    expect(store.listLocalAssignments()).toEqual([]);
  });

  it("saves and clears sample session notes", async () => {
    const store = await import("@/lib/assignmentStore");
    expect(store.setLocalNote("sample-x", "Talk me through the close", "Demo User")).toBe(true);
    expect(store.getLocalNote("sample-x")?.note).toBe("Talk me through the close");
    expect(store.localNoteIds().has("sample-x")).toBe(true);
    store.setLocalNote("sample-x", "   ", "Demo User");
    expect(store.getLocalNote("sample-x")).toBeNull();
  });
});
