"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachMode, CoachResult, Cue } from "@/lib/coach-types";
import type { Scenario } from "@/lib/scenarios";
import type { StoredTurn } from "@/lib/sessionStore";

export interface LiveCue extends Cue {
  id: string;
  key?: string;
  /** Persona line that triggered it, copied from the transcript for display. */
  heard?: string;
  status: "active" | "used" | "dismissed";
}
export interface RubricChip { id: string; name: string; delta: number }

/** Non-objection cues that arrive within this long of the previous cue are dropped, not queued; objection alerts always show. */
const COOLDOWN_MS = 8000;
const MAX_ACTIVE = 3;

/**
 * What one coach request carries. Well under the route's limits (200 turns, 20,000 characters,
 * 4,000 per turn), so a long voice call keeps getting coached instead of failing every request.
 */
export const WINDOW_TURNS = 120;
export const WINDOW_CHARS = 16_000;
const TURN_CHARS = 4000;

/** The most recent turns that fit one coach request, and how many earlier turns were left out. */
export function coachWindow(turns: { role: StoredTurn["role"]; text: string }[], maxTurns = WINDOW_TURNS, maxChars = WINDOW_CHARS) {
  const out: { role: StoredTurn["role"]; text: string }[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && out.length < maxTurns; i--) {
    const text = turns[i].text.slice(0, TURN_CHARS);
    if (out.length && chars + text.length > maxChars) break;
    chars += text.length;
    out.unshift({ role: turns[i].role, text });
  }
  return { transcript: out, offset: turns.length - out.length };
}

/**
 * A windowed result only sees recent turns. Evidence that scrolled out of the window still
 * counts: a criterion confirmed earlier keeps its higher score, and finished talk-track steps stay done.
 */
export function mergeWindowed(prev: CoachResult | null, next: CoachResult, offset: number): CoachResult {
  // The server may read fewer turns than were sent (the LLM prompt keeps only recent lines): use whichever start is later.
  const unseen = Math.max(offset, (next.windowStart ?? 1) - 1);
  if (!prev || unseen <= 0) return next;
  const criteria = next.estimate.criteria.map((c) => {
    const p = prev.estimate.criteria.find((x) => x.id === c.id);
    // Evidence the new result could not see stands, unless the new result confirms the criterion at least as high.
    // A provisional score is only an estimate, so it never replaces confirmed evidence, whatever its value.
    const keep = p?.confirmed && (p.evidenceLine ?? 0) <= unseen && !(c.confirmed && c.score >= p.score);
    return keep && p ? p : c;
  });
  const total = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return {
    ...next,
    estimate: { overall: Math.round(criteria.reduce((a, c) => a + c.score * c.weight, 0) / total), criteria },
    steps: next.steps.map((done, i) => done || !!prev.steps[i]),
  };
}

/**
 * An active cue that is not an objection is retired (it stays in the log) once the rep has spoken this many times
 * after the line that triggered it without using it. A late or failed coach run then never leaves an old cue looking
 * current. Objection cues stay until used, dismissed or pushed out by MAX_ACTIVE.
 */
export const STALE_AFTER_REP_TURNS = 2;

/**
 * 1-based lines of the rep's turns, numbered the way coach requests number them (empty turns left out). With the
 * current transcript, these are in the same coordinates as cue trigger turns after the insert shift.
 */
export function repLinesOf(turns: { role: StoredTurn["role"]; text: string }[]): number[] {
  return turns.filter((t) => t.text.trim()).flatMap((t, i) => (t.role === "user" ? [i + 1] : []));
}

/** A non-objection cue the rep has already spoken past `after` times. Objection cues are never stale. */
export function isStaleCue(cue: Pick<Cue, "type" | "triggerTurn">, repLines: number[], after = STALE_AFTER_REP_TURNS): boolean {
  return cue.type !== "objection" && repLines.filter((n) => n > cue.triggerTurn).length >= after;
}

/** Retires active stale cues (see isStaleCue). Returns the same array when nothing changes, so a state update is a no-op. */
export function retireStaleCues(cues: LiveCue[], repLines: number[], after = STALE_AFTER_REP_TURNS): LiveCue[] {
  const stale = (c: LiveCue) => c.status === "active" && isStaleCue(c, repLines, after);
  return cues.some(stale) ? cues.map((c) => (stale(c) ? { ...c, status: "dismissed" as const } : c)) : cues;
}

/** The talk-track step a "step:N" cue key points at, if any. */
const stepOfKey = (key: string | undefined) => (key?.startsWith("step:") ? Number(key.slice(5)) : NaN);

/** A "step:N" cue whose step is already done in these (merged) steps. */
export function isDoneStepCue(key: string | undefined, steps: boolean[]): boolean {
  const n = stepOfKey(key);
  return Number.isInteger(n) && !!steps[n];
}

/**
 * Whether a result's new cue is still worth showing: not stale against the current rep lines, and not a step cue
 * for a step the merged result already has done (a windowed result may not have seen it done). A cue that fails
 * is dropped like a cooldown drop: never shown, key not recorded.
 */
export function freshCue(r: Pick<CoachResult, "cue" | "cueKey" | "steps">, repLines: number[]): boolean {
  return !!r.cue && !isStaleCue(r.cue, repLines) && !isDoneStepCue(r.cueKey, r.steps);
}

/** One coach request: which call (generation) it belongs to, and its order among all requests. */
export interface CoachTicket { gen: number; seq: number }

/**
 * One coach request in flight per call, results in order, and nothing from a previous call. `reset` starts a new
 * call: requests still in flight become stale, so their result or error is ignored, finishing them neither clears the
 * new call's in-flight flag nor triggers a rerun, and the new call can start its own request at once.
 */
export function requestGate() {
  let gen = 0;
  let seq = 0;
  let applied = 0;
  /** seq of the current call's request in flight. */
  let running: number | null = null;
  let pending = false;
  return {
    /** A ticket for a new request, or null (and a rerun is queued) while the current call has one in flight. */
    start(): CoachTicket | null {
      if (running !== null) {
        pending = true;
        return null;
      }
      running = ++seq;
      return { gen, seq: running };
    },
    isCurrent: (t: CoachTicket) => t.gen === gen,
    /** True for a result of the current call that is newer than the last one applied; marks it applied. */
    accept(t: CoachTicket): boolean {
      if (t.gen !== gen || t.seq <= applied) return false;
      applied = t.seq;
      return true;
    },
    /** Ends a request. True when the current call queued a rerun meanwhile. A stale ticket changes nothing. */
    finish(t: CoachTicket): boolean {
      if (t.gen !== gen || running !== t.seq) return false;
      running = null;
      const rerun = pending;
      pending = false;
      return rerun;
    },
    reset() {
      gen++;
      running = null;
      pending = false;
    },
  };
}

export type CoachRequestGate = ReturnType<typeof requestGate>;
export type CoachOutcome = { ok: true; result: CoachResult } | { ok: false; message: string };
export const COACH_OFFLINE_MESSAGE = "The coach is offline for this turn.";

/**
 * The lifecycle of one coach request. Only the current call's newest result reaches onResult, and only the current
 * call's failures reach onError (an HTTP error message, or COACH_OFFLINE_MESSAGE when request or onResult throws).
 * When the current call queued a rerun meanwhile, `rerun` is called; it should go through a ref to the latest run.
 */
export async function coachCycle(
  gate: CoachRequestGate,
  request: () => Promise<CoachOutcome>,
  handlers: { onResult: (r: CoachResult) => void; onError: (message: string) => void },
  rerun: () => void,
): Promise<void> {
  const ticket = gate.start();
  if (!ticket) return;
  try {
    const out = await request();
    if (out.ok) {
      if (gate.accept(ticket)) handlers.onResult(out.result);
    } else if (gate.isCurrent(ticket)) handlers.onError(out.message);
  } catch {
    if (gate.isCurrent(ticket)) handlers.onError(COACH_OFFLINE_MESSAGE);
  } finally {
    if (gate.finish(ticket)) rerun();
  }
}

/** POSTs one coach request. An HTTP error is an outcome; a network failure or bad JSON rejects. */
async function postCoach(body: unknown): Promise<CoachOutcome> {
  const res = await fetch("/api/coach/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    return { ok: false, message: res.status === 429 ? data.message || "The coach is taking a breather. It will pick up again shortly." : "The coach couldn't update this turn." };
  }
  return { ok: true, result: (await res.json()) as CoachResult };
}

/** One chip per criterion on a line: the newer delta replaces the older one, largest gains first. */
export function mergeChips(existing: RubricChip[], next: RubricChip[]): RubricChip[] {
  const byId = new Map(existing.map((c) => [c.id, c]));
  for (const c of next) byId.set(c.id, c);
  return [...byId.values()].sort((a, b) => b.delta - a.delta).slice(0, 3);
}

/** 0-based index after turns were inserted at these positions, in order. */
export function shiftIndex(i: number, inserts: number[]): number {
  return inserts.reduce((n, at) => (n >= at ? n + 1 : n), i);
}

/** Moves a result's 1-based line numbers past turns inserted since its snapshot was taken. */
export function shiftResult(r: CoachResult, inserts: number[]): CoachResult {
  if (!inserts.length) return r;
  const line = (n: number) => shiftIndex(n - 1, inserts) + 1;
  return {
    ...r,
    estimate: { ...r.estimate, criteria: r.estimate.criteria.map((c) => (c.evidenceLine ? { ...c, evidenceLine: line(c.evidenceLine) } : c)) },
    cue: r.cue ? { ...r.cue, triggerTurn: line(r.cue.triggerTurn) } : null,
    ...(r.windowStart ? { windowStart: line(r.windowStart) } : {}),
  };
}

/**
 * Drives the copilot rail: posts the transcript to /api/coach/turn as the call
 * moves (debounced, one request in flight), keeps the latest live estimate, and
 * collects cues. Objection cues stay until the rep uses or dismisses them; other cues also retire once the rep has
 * moved past them (retireStaleCues).
 */
export function useCoach(scenario: Scenario | undefined, turns: StoredTurn[], opts: { mode: CoachMode; live: boolean }) {
  const [result, setResultState] = useState<CoachResult | null>(null);
  const [cues, setCues] = useState<LiveCue[]>([]);
  const [chips, setChips] = useState<Record<number, RubricChip[]>>({});
  const [latencies, setLatencies] = useState<number[]>([]);
  const [error, setError] = useState("");
  const lastCueAt = useRef(0);
  const keys = useRef<string[]>([]);
  const prevScores = useRef<Record<string, number>>({});
  /** Scores just before the rep's latest line, so repeat runs on that line update one chip per criterion instead of stacking. */
  const base = useRef<{ turn: number; scores: Record<string, number> }>({ turn: -1, scores: {} });
  /** Insert positions of text replies, so results for older snapshots land on the right lines. */
  const inserts = useRef<number[]>([]);
  const resultRef = useRef<CoachResult | null>(null);
  const gate = useRef(requestGate());
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const setResult = useCallback((r: CoachResult | null) => { resultRef.current = r; setResultState(r); }, []);

  const reset = useCallback(() => {
    setResult(null); setCues([]); setChips({}); setLatencies([]); setError("");
    keys.current = []; prevScores.current = {}; lastCueAt.current = 0;
    base.current = { turn: -1, scores: {} }; inserts.current = [];
    gate.current.reset();
  }, [setResult]);

  /**
   * A text reply was inserted at this 0-based index, ahead of rep lines sent while the persona was typing.
   * Everything keyed by a later turn moves down one, so chips, cue markers and the saved coach log stay on their lines.
   */
  const shift = useCallback((at: number) => {
    inserts.current.push(at);
    const up = (i: number) => (i >= at ? i + 1 : i);
    setChips((c) => Object.fromEntries(Object.entries(c).map(([k, v]) => [up(Number(k)), v])));
    setCues((cs) => cs.map((q) => ({ ...q, triggerTurn: up(q.triggerTurn - 1) + 1 })));
    if (resultRef.current) setResult(shiftResult(resultRef.current, [at]));
    if (base.current.turn >= at) base.current = { ...base.current, turn: base.current.turn + 1 };
  }, [setResult]);

  const run = useCallback(async () => {
    if (!scenario || opts.mode === "blind") return;
    const snapshot = turnsRef.current.filter((t) => t.text.trim());
    if (!snapshot.some((t) => t.role === "user")) return;
    const mark = inserts.current.length;
    const win = coachWindow(snapshot.map(({ role, text }) => ({ role, text })));
    const body = { scenario, transcript: win.transcript, lineOffset: win.offset, allowCue: opts.mode === "coached", recentCueKeys: keys.current.slice(-20) };

    const apply = (raw: CoachResult) => {
      setError("");
      // Replies inserted while this request was in flight moved later turns down; line numbers follow them.
      const later = inserts.current.slice(mark);
      const r = mergeWindowed(resultRef.current, shiftResult(raw, later), win.offset);
      setResult(r);
      setLatencies((l) => [...l.slice(-30), r.latencyMs]);

      // Credit score movement to the rep's latest line in this snapshot.
      const lastIdx = snapshot.map((t, i) => (t.role === "user" ? i : -1)).filter((i) => i >= 0).pop();
      const lastUser = lastIdx === undefined ? undefined : shiftIndex(lastIdx, later);
      if (lastUser !== undefined && lastUser !== base.current.turn) base.current = { turn: lastUser, scores: prevScores.current };
      // Only quote-confirmed gains earn a chip; provisional movement stays on the hatched tapes.
      const deltas = r.estimate.criteria
        .filter((c) => c.confirmed)
        .map((c) => ({ id: c.id, name: c.name, delta: Math.round(c.score - (base.current.scores[c.id] ?? 0)) }))
        .filter((d) => d.delta >= 3);
      // Judged against the transcript as it is now, not the request snapshot: the rep may have spoken while this was in flight.
      // r is already shifted past replies inserted since then, so its lines match the current transcript.
      const repLines = repLinesOf(turnsRef.current);
      // A "next step" cue is stale once that talk-track step is done, and any non-objection cue once the rep has moved on.
      setCues((cs) => retireStaleCues(cs.map((c) => (c.status === "active" && isDoneStepCue(c.key, r.steps) ? { ...c, status: "dismissed" as const } : c)), repLines));
      prevScores.current = Object.fromEntries(r.estimate.criteria.map((c) => [c.id, c.score]));
      if (lastUser !== undefined && deltas.length) setChips((c) => ({ ...c, [lastUser]: mergeChips(c[lastUser] ?? [], deltas) }));

      // r is the merged result, so a step done before the prompt window still counts. A cue that is stale or for a
      // done step is dropped like a cooldown drop: never shown, key not recorded.
      if (r.cue && opts.mode === "coached" && freshCue(r, repLines)) {
        const now = Date.now();
        const isObjection = r.cue.type === "objection";
        if (isObjection || now - lastCueAt.current >= COOLDOWN_MS) {
          lastCueAt.current = now;
          if (r.cueKey) keys.current.push(r.cueKey);
          const said = raw.cue ? snapshot[raw.cue.triggerTurn - 1] : undefined;
          const heard = said?.role === "assistant" ? said.text : undefined;
          const cue: LiveCue = { ...r.cue, id: `${now}-${r.cueKey ?? r.cue.type}`, key: r.cueKey, heard, status: "active" };
          setCues((cs) => {
            const active = cs.filter((c) => c.status === "active");
            // Keep at most three on screen; the oldest active one is retired (it stays in the log).
            const retire = active.length >= MAX_ACTIVE ? active[active.length - 1].id : null;
            return [cue, ...cs.map((c) => (c.id === retire ? { ...c, status: "dismissed" as const } : c))];
          });
        }
      }
    };

    // Turns that landed while this request was in flight: the rerun goes through runRef (this call's scenario and
    // mode) and reads turnsRef when it starts, so it coaches the newest snapshot. A request from before a reset is ignored.
    await coachCycle(gate.current, () => postCoach(body), { onResult: apply, onError: setError }, () => void runRef.current());
  }, [scenario, opts.mode, setResult]);
  const runRef = useRef(run);
  runRef.current = run;

  // Retire stale cues as the call moves, not only when a coach run succeeds: a slow or failed run must not leave one current.
  useEffect(() => {
    setCues((cs) => retireStaleCues(cs, repLinesOf(turns)));
  }, [turns]);

  // Debounce: react quickly after the persona speaks (that's when the rep needs help), slower after the rep speaks.
  const lastRole = turns[turns.length - 1]?.role;
  useEffect(() => {
    if (!opts.live || opts.mode === "blind" || !turns.length) return;
    const t = setTimeout(() => void run(), lastRole === "assistant" ? 500 : 2500);
    return () => clearTimeout(t);
  }, [turns.length, lastRole, opts.live, opts.mode, run, turns]);

  const setStatus = useCallback((id: string, status: LiveCue["status"]) => setCues((cs) => cs.map((c) => (c.id === id ? { ...c, status } : c))), []);

  const sorted = [...latencies].sort((a, b) => a - b);
  const p50 = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  return { result, cues, chips, error, p50, reset, shift, use: (id: string) => setStatus(id, "used"), dismiss: (id: string) => setStatus(id, "dismissed") };
}
