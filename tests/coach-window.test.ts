import { describe, expect, it } from "vitest";
import { coachHeuristic, trailingWindow, type CoachTurnInput } from "@/lib/coach";
import type { CoachResult } from "@/lib/coach-types";
import { BUILT_IN_SCENARIOS } from "@/lib/scenarios";
import {
  COACH_OFFLINE_MESSAGE,
  STALE_AFTER_REP_TURNS,
  WINDOW_CHARS,
  WINDOW_TURNS,
  coachCycle,
  coachWindow,
  freshCue,
  isDoneStepCue,
  isStaleCue,
  mergeChips,
  mergeWindowed,
  repLinesOf,
  requestGate,
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

  it("never lets a provisional score, equal or higher, erase confirmed evidence outside the window", () => {
    const prev = result({ estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 50, confirmed: true, evidenceLine: 12 }, { id: "b", name: "B", weight: 50, score: 40, confirmed: true, evidenceLine: 14 }] } });
    const next = result({ windowStart: 31, estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 50, confirmed: false }, { id: "b", name: "B", weight: 50, score: 70, confirmed: false }] } });
    const merged = mergeWindowed(prev, next, 0);
    expect(merged.estimate.criteria).toEqual(prev.estimate.criteria);
    expect(merged.estimate.overall).toBe(45);
  });

  it("takes a new confirmed score that is equal or higher, and keeps the old one over a lower confirmed score", () => {
    const prev = result({ estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 50, confirmed: true, evidenceLine: 12 }, { id: "b", name: "B", weight: 50, score: 40, confirmed: true, evidenceLine: 14 }] } });
    const next = result({ windowStart: 31, estimate: { overall: 0, criteria: [{ id: "a", name: "A", weight: 50, score: 50, confirmed: true, evidenceLine: 33 }, { id: "b", name: "B", weight: 50, score: 30, confirmed: true, evidenceLine: 35 }] } });
    const merged = mergeWindowed(prev, next, 0);
    expect(merged.estimate.criteria.map((c) => [c.score, c.evidenceLine])).toEqual([[50, 33], [40, 14]]);
    expect(merged.estimate.overall).toBe(45);
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

describe("stale cues against the current transcript", () => {
  type T = { role: "user" | "assistant"; text: string };
  // The rep speaks on the odd lines (1, 3, ... 11, 13), the persona on the even ones.
  const call = (n: number): T[] => Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: `line ${i + 1}` }));
  const nextCue = (triggerTurn: number) => ({ type: "next_question" as const, title: "Next: ask about timing", message: "", triggerTurn });

  it("numbers rep lines like coach requests do, skipping empty turns", () => {
    expect(repLinesOf([{ role: "assistant", text: "Hi" }, { role: "user", text: "  " }, { role: "user", text: "Hello" }, { role: "assistant", text: "Yes?" }, { role: "user", text: "So" }])).toEqual([2, 4]);
  });

  it("drops a late non-objection cue when the rep spoke twice while its request was in flight", () => {
    // Request sent with lines 1-10; the cue is for line 10. Before it came back the rep spoke at 11 and 13.
    expect(isStaleCue(nextCue(10), repLinesOf(call(10)))).toBe(false);
    expect(isStaleCue(nextCue(10), repLinesOf(call(13)))).toBe(true);
    expect(isStaleCue(nextCue(10), repLinesOf(call(12)))).toBe(false);
    expect(isStaleCue({ ...nextCue(10), type: "objection" }, repLinesOf(call(13)))).toBe(false);
  });

  it("compares a cue shifted past inserted replies with the transcript as it is now", () => {
    // Snapshot [A, U, U'] with a cue on U' (line 3). The persona's reply R then went in at index 2: [A, U, R, U', A, U].
    const now: T[] = [{ role: "assistant", text: "a" }, { role: "user", text: "u" }, { role: "assistant", text: "r" }, { role: "user", text: "u2" }, { role: "assistant", text: "a2" }, { role: "user", text: "u3" }];
    const raw = result({ cue: nextCue(3) });
    const shifted = shiftResult(raw, [2]).cue!;
    expect(shifted.triggerTurn).toBe(4);
    // Only one rep line (6) follows U' now, so it is still fresh; unshifted, line 4 would wrongly count against it.
    expect(isStaleCue(shifted, repLinesOf(now))).toBe(false);
    expect(isStaleCue(raw.cue!, repLinesOf(now))).toBe(true);
  });

  it("retires a cue from turns alone after a failed request, and leaves state untouched otherwise", () => {
    const cs: LiveCue[] = [{ ...nextCue(10), id: "n", status: "active" }, { ...nextCue(10), id: "o", type: "objection", status: "active" }];
    // The coach request after line 10 failed; no result arrives. The turns effect still runs as the call moves.
    const quiet = retireStaleCues(cs, repLinesOf(call(12)));
    expect(quiet).toBe(cs);
    const moved = retireStaleCues(cs, repLinesOf(call(13)));
    expect(moved.map((c) => c.status)).toEqual(["dismissed", "active"]);
  });
});

describe("freshCue against the merged steps", () => {
  const stepCue = (n: number): Pick<CoachResult, "cue" | "cueKey"> => ({ cue: { type: "next_question", title: `Next: step ${n}`, message: "", triggerTurn: 40 }, cueKey: `step:${n}` });

  it("drops a step cue for a step done before the prompt window", () => {
    // Step 1 was done on an early line; the windowed LLM result no longer sees it and cues it again.
    const prev = result({ steps: [true, true] });
    const next = result({ ...stepCue(1), windowStart: 31, steps: [true, false] });
    const merged = mergeWindowed(prev, next, 0);
    expect(merged.steps).toEqual([true, true]);
    expect(freshCue(merged, [])).toBe(false);
    expect(freshCue(next, [])).toBe(true);
  });

  it("keeps a step cue for a step not done yet, and cues that are not step cues", () => {
    expect(freshCue({ ...stepCue(1), steps: [true, false] }, [])).toBe(true);
    expect(freshCue({ ...stepCue(0), cueKey: "objection:price", steps: [true, true] }, [])).toBe(true);
    expect(isDoneStepCue("step:x", [true])).toBe(false);
    expect(isDoneStepCue(undefined, [true])).toBe(false);
  });

  it("still drops a stale cue and allows no cue", () => {
    expect(freshCue({ ...stepCue(1), steps: [false, false] }, [41, 43])).toBe(false);
    expect(freshCue({ cue: null, steps: [] }, [])).toBe(false);
  });
});

describe("requestGate", () => {
  it("runs one request per call and applies results in order", () => {
    const g = requestGate();
    const a = g.start()!;
    expect(g.start()).toBeNull();
    expect(g.finish(a)).toBe(true);
    const b = g.start()!;
    expect(g.accept(b)).toBe(true);
    expect(g.accept(a)).toBe(false);
    expect(g.finish(b)).toBe(false);
  });
});

describe("coachCycle and reset", () => {
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
    return { promise, resolve, reject };
  }
  type Out = Awaited<ReturnType<Parameters<typeof coachCycle>[1]>>;
  /** Starts one cycle whose request settles when the test says so; records what reached the call's state. */
  const cycle = (g: ReturnType<typeof requestGate>, events: string[], tag: string) => {
    const d = deferred<Out>();
    const done = coachCycle(g, () => d.promise, { onResult: () => events.push(`${tag}:result`), onError: (m) => events.push(`${tag}:error:${m}`) }, () => events.push(`${tag}:rerun`));
    return { ...d, done };
  };

  it("applies a result and reruns once when turns landed while it was in flight", async () => {
    const g = requestGate();
    const events: string[] = [];
    const first = cycle(g, events, "a");
    await cycle(g, events, "queued").done;
    first.resolve({ ok: true, result: result() });
    await first.done;
    expect(events).toEqual(["a:result", "a:rerun"]);
  });

  it.each([
    ["success", (d: ReturnType<typeof deferred<Out>>) => d.resolve({ ok: true, result: result() })],
    ["HTTP error", (d: ReturnType<typeof deferred<Out>>) => d.resolve({ ok: false, message: "The coach couldn't update this turn." })],
    ["rejection", (d: ReturnType<typeof deferred<Out>>) => d.reject(new TypeError("Failed to fetch"))],
  ])("ignores a %s from before a reset, and never reruns or unblocks through the old call", async (_name, settle) => {
    const g = requestGate();
    const events: string[] = [];
    const old = cycle(g, events, "old");
    // A turn landed during the old request, so it queued a rerun for the old call.
    await cycle(g, events, "old-queued").done;
    g.reset();
    // The new call starts its own request at once instead of waiting for the old one.
    const fresh = cycle(g, events, "new");
    settle(old);
    await old.done;
    expect(events).toEqual([]);
    // The old request finishing did not clear the new call's in-flight flag: another run still queues behind it.
    await cycle(g, events, "new-queued").done;
    expect(events).toEqual([]);
    fresh.resolve({ ok: false, message: "The coach couldn't update this turn." });
    await fresh.done;
    expect(events).toEqual(["new:error:The coach couldn't update this turn.", "new:rerun"]);
  });

  it("reports a rejection or a throwing result handler of the current call as offline", async () => {
    const g = requestGate();
    const events: string[] = [];
    const c = cycle(g, events, "a");
    c.reject(new TypeError("Failed to fetch"));
    await c.done;
    expect(events).toEqual([`a:error:${COACH_OFFLINE_MESSAGE}`]);
    await coachCycle(g, async () => ({ ok: true, result: result() }), { onResult: () => { throw new Error("boom"); }, onError: (m) => events.push(m) }, () => {});
    expect(events.at(-1)).toBe(COACH_OFFLINE_MESSAGE);
  });
});
