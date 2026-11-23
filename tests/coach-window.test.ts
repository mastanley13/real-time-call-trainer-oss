import { describe, expect, it } from "vitest";
import { coachHeuristic, trailingWindow, type CoachTurnInput } from "@/lib/coach";
import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import {
  STALE_AFTER_REP_TURNS,
  WINDOW_CHARS,
  WINDOW_TURNS,
  coachWindow,
  mergeChips,
  mergeWindowed,
  resultGate,
  retireStaleCues,
  shiftIndex,
  shiftResult,
  type LiveCue,
} from "@/components/call/useCoach";

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
    expect(mergeWindowed(result({ steps: [true, true] }), result({ windowStart: 1 }), 0).steps).toEqual([false, false]);
  });

  it("keeps evidence from lines the server's prompt window left out, even when the client sent them", () => {
    // Client sent the whole call (offset 0); the LLM only read from line 31, so line 12's evidence stays.
    const prev = result({ steps: [true, false], estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 55, confirmed: true, evidenceLine: 12 }, { id: "b", name: "B", weight: 50, score: 40, confirmed: true, evidenceLine: 40 }] } });
    const next = result({ windowStart: 31, estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 20, confirmed: false }, { id: "b", name: "B", weight: 50, score: 15, confirmed: false }] } });
    const merged = mergeWindowed(prev, next, 0);
    // a's evidence (line 12) is before the window and is kept; b's (line 40) was in view, so the new score stands.
    expect(merged.estimate.criteria.map((c) => c.score)).toEqual([55, 15]);
    expect(merged.steps).toEqual([true, false]);
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
    expect(shiftResult(result({ windowStart: 5 }), [1]).windowStart).toBe(6);
    expect(shiftResult(result({ windowStart: 5 }), [7]).windowStart).toBe(5);
  });
});

describe("retireStaleCues", () => {
  const cue = (over: Partial<LiveCue>): LiveCue => ({ id: "c", type: "next_question", title: "Next: ask about timing", message: "", triggerTurn: 10, status: "active", ...over });

  it("retires an unused non-objection cue once the rep has spoken twice after its trigger", () => {
    expect(STALE_AFTER_REP_TURNS).toBe(2);
    const cs = [cue({ id: "next" }), cue({ id: "guard", type: "guardrail", triggerTurn: 11 }), cue({ id: "whisper", type: "whisper", triggerTurn: 9 })];
    // Rep lines 11 and 13 came after line 10.
    const out = retireStaleCues(cs, [3, 5, 7, 9, 11, 13]);
    expect(out.map((c) => c.status)).toEqual(["dismissed", "active", "dismissed"]);
  });

  it("keeps a cue the rep has answered only once", () => {
    expect(retireStaleCues([cue({})], [9, 11])[0].status).toBe("active");
  });

  it("never retires objection cues or touches used and dismissed ones", () => {
    const cs = [cue({ id: "o", type: "objection" }), cue({ id: "u", status: "used" }), cue({ id: "d", status: "dismissed" })];
    expect(retireStaleCues(cs, [11, 13, 15, 17]).map((c) => c.status)).toEqual(["active", "used", "dismissed"]);
  });
});

describe("resultGate", () => {
  it("applies results in order and drops one older than the last applied", () => {
    const g = resultGate();
    const a = g.issue();
    const b = g.issue();
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
    expect(g.accept(g.issue())).toBe(true);
  });

  it("drops a result that was in flight when the call was reset", () => {
    const g = resultGate();
    const before = g.issue();
    g.invalidate();
    expect(g.accept(before)).toBe(false);
    expect(g.accept(g.issue())).toBe(true);
  });
});
