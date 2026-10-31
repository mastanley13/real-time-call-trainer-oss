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
  if (!prev || offset <= 0) return next;
  const criteria = next.estimate.criteria.map((c) => {
    const p = prev.estimate.criteria.find((x) => x.id === c.id);
    return p?.confirmed && (p.evidenceLine ?? 0) <= offset && p.score > c.score ? p : c;
  });
  const total = criteria.reduce((a, c) => a + c.weight, 0) || 1;
  return {
    ...next,
    estimate: { overall: Math.round(criteria.reduce((a, c) => a + c.score * c.weight, 0) / total), criteria },
    steps: next.steps.map((done, i) => done || !!prev.steps[i]),
  };
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
  };
}

/**
 * Drives the copilot rail: posts the transcript to /api/coach/turn as the call
 * moves (debounced, one request in flight), keeps the latest live estimate, and
 * collects cues. Cues stay until the rep uses or dismisses them.
 */
export function useCoach(scenario: Scenario | undefined, turns: StoredTurn[], opts: { mode: CoachMode; live: boolean }) {
  const [result, setResultState] = useState<CoachResult | null>(null);
  const [cues, setCues] = useState<LiveCue[]>([]);
  const [chips, setChips] = useState<Record<number, RubricChip[]>>({});
  const [latencies, setLatencies] = useState<number[]>([]);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const pending = useRef(false);
  const lastCueAt = useRef(0);
  const keys = useRef<string[]>([]);
  const prevScores = useRef<Record<string, number>>({});
  /** Scores just before the rep's latest line, so repeat runs on that line update one chip per criterion instead of stacking. */
  const base = useRef<{ turn: number; scores: Record<string, number> }>({ turn: -1, scores: {} });
  /** Insert positions of text replies, so results for older snapshots land on the right lines. */
  const inserts = useRef<number[]>([]);
  const resultRef = useRef<CoachResult | null>(null);
  const turnsRef = useRef(turns);
  turnsRef.current = turns;

  const setResult = useCallback((r: CoachResult | null) => { resultRef.current = r; setResultState(r); }, []);

  const reset = useCallback(() => {
    setResult(null); setCues([]); setChips({}); setLatencies([]); setError("");
    keys.current = []; prevScores.current = {}; lastCueAt.current = 0;
    base.current = { turn: -1, scores: {} }; inserts.current = [];
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
    if (inFlight.current) { pending.current = true; return; }
    const snapshot = turnsRef.current.filter((t) => t.text.trim());
    if (!snapshot.some((t) => t.role === "user")) return;
    inFlight.current = true;
    const mark = inserts.current.length;
    const win = coachWindow(snapshot.map(({ role, text }) => ({ role, text })));
    try {
      const res = await fetch("/api/coach/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenario,
          transcript: win.transcript,
          lineOffset: win.offset,
          allowCue: opts.mode === "coached",
          recentCueKeys: keys.current.slice(-20),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(res.status === 429 || res.status === 503 ? data.message || "The coach is taking a breather. It will pick up again shortly." : "The coach couldn't update this turn.");
        return;
      }
      setError("");
      const raw: CoachResult = await res.json();
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
      // A "next step" cue is stale once that talk-track step is done.
      setCues((cs) => cs.map((c) => {
        const step = c.status === "active" && c.key?.startsWith("step:") ? Number(c.key.slice(5)) : NaN;
        return Number.isInteger(step) && r.steps[step] ? { ...c, status: "dismissed" as const } : c;
      }));
      prevScores.current = Object.fromEntries(r.estimate.criteria.map((c) => [c.id, c.score]));
      if (lastUser !== undefined && deltas.length) setChips((c) => ({ ...c, [lastUser]: mergeChips(c[lastUser] ?? [], deltas) }));

      if (r.cue && opts.mode === "coached") {
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
    } catch {
      setError("The coach is offline for this turn.");
    } finally {
      inFlight.current = false;
      if (pending.current) { pending.current = false; void run(); }
    }
  }, [scenario, opts.mode, setResult]);

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
