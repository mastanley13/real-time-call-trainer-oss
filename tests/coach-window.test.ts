import { describe, expect, it } from "vitest";
import { coachHeuristic, trailingWindow, type CoachTurnInput } from "@/lib/coach";
import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import { WINDOW_CHARS, WINDOW_TURNS, coachWindow, mergeChips, mergeWindowed, shiftIndex, shiftResult } from "@/components/call/useCoach";

const scenario = BUILT_IN_SCENARIOS.find((s) => s.id === "home-services-inbound-lead")!;
const filler = (n: number): CoachTurnInput[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "user" : "assistant", text: i % 2 ? `Okay, noted point ${i}.` : `Fine, go on ${i}.` }));

const result = (over: Partial<CoachResult> = {}): CoachResult => ({
  estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 10, confirmed: false }, { id: "b", name: "B", weight: 50, score: 40, confirmed: true, evidenceLine: 300 }] },
  steps: [false, false],
  cue: null,
  talkRatio: 0.5,
  source: "heuristic",
  latencyMs: 1,
  ...over,
});

describe("coachWindow (client)", () => {
  it("sends a short call whole", () => {
    const turns = filler(10);
    expect(coachWindow(turns)).toEqual({ transcript: turns, offset: 0 });
  });

  it("keeps a 60-minute call under the route's limits and reports how many turns it left out", () => {
    const turns = filler(600).map((t) => ({ ...t, text: t.text.padEnd(150, ".") }));
    const { transcript, offset } = coachWindow(turns);
    expect(transcript.length).toBeLessThanOrEqual(WINDOW_TURNS);
    expect(transcript.reduce((n, t) => n + t.text.length, 0)).toBeLessThanOrEqual(WINDOW_CHARS);
    expect(transcript.length).toBeLessThan(200);
    expect(offset + transcript.length).toBe(600);
    expect(transcript[transcript.length - 1]).toEqual(turns[599]);
  });

  it("clips a single very long turn to the per-turn limit", () => {
    const { transcript } = coachWindow([{ role: "user", text: "word ".repeat(2000) }]);
    expect(transcript[0].text.length).toBe(4000);
  });
});

describe("trailingWindow (server)", () => {
  it("drops the oldest turns past the turn and character limits", () => {
    const turns = filler(250);
    const byTurns = trailingWindow(turns, 200, 1_000_000);
    expect(byTurns).toMatchObject({ dropped: 50 });
    expect(byTurns.turns[0]).toBe(turns[50]);
    const byChars = trailingWindow([{ text: "x".repeat(10) }, { text: "y".repeat(10) }, { text: "z".repeat(10) }], 200, 25);
    expect(byChars.dropped).toBe(1);
  });
});

describe("coach lineOffset", () => {
  it("keeps cue and evidence line numbers absolute for a windowed call", () => {
    const window: CoachTurnInput[] = [
      { role: "assistant", text: "What does a visit cost? Nobody mentioned a fee." },
      { role: "user", text: "Fair question. The diagnostic visit is $89, and it's credited toward the repair if you go ahead." },
      { role: "assistant", text: "How much is this going to cost me?" },
    ];
    const r = coachHeuristic(scenario, window, { allowCue: true, lineOffset: 140 });
    expect(r.cue?.triggerTurn).toBeGreaterThan(140);
    for (const c of r.estimate.criteria) if (c.evidenceLine) expect(c.evidenceLine).toBeGreaterThan(140);
  });
});

describe("mergeWindowed", () => {
  it("keeps a criterion confirmed by a line that scrolled out of the window", () => {
    const prev = result({ steps: [true, false] });
    const next = result({ estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 30, confirmed: true, evidenceLine: 420 }, { id: "b", name: "B", weight: 50, score: 15, confirmed: false }] } });
    const merged = mergeWindowed(prev, next, 380);
    expect(merged.estimate.criteria.map((c) => c.score)).toEqual([30, 40]);
    expect(merged.estimate.overall).toBe(35);
    expect(merged.steps).toEqual([true, false]);
  });

  it("returns the new result as is when nothing was left out", () => {
    const next = result();
    expect(mergeWindowed(result({ steps: [true, true] }), next, 0)).toBe(next);
  });
});

describe("mergeChips", () => {
  it("keeps one chip per criterion, newest delta wins", () => {
    const merged = mergeChips([{ id: "discovery", name: "Discovery", delta: 12 }], [{ id: "discovery", name: "Discovery", delta: 15 }, { id: "close", name: "Close", delta: 4 }]);
    expect(merged).toEqual([{ id: "discovery", name: "Discovery", delta: 15 }, { id: "close", name: "Close", delta: 4 }]);
  });
});

describe("shiftIndex and shiftResult", () => {
  it("moves indexes at or after an inserted reply down by one", () => {
    // [A, B] became [A, R1, B]: R1 went in at index 1.
    expect(shiftIndex(0, [1])).toBe(0);
    expect(shiftIndex(1, [1])).toBe(2);
    expect(shiftIndex(1, [1, 1])).toBe(3);
  });

  it("moves cue and evidence lines past the insert", () => {
    const r = result({ cue: { type: "objection", title: "Price", message: "", triggerTurn: 2 } });
    const shifted = shiftResult(r, [1]);
    expect(shifted.cue?.triggerTurn).toBe(3);
    expect(shifted.estimate.criteria[1].evidenceLine).toBe(301);
    expect(shiftResult(r, [])).toBe(r);
  });
});
