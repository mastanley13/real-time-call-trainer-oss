"use client";
/**
 * Practice-session persistence. Signed-in users with a database save to the
 * API; demo mode / no-database setups keep sessions in localStorage.
 */
import type { Scenario } from "./scenarios";
import type { Evaluation } from "./grader-types";
import type { CoachMode, CueType } from "./coach-types";
import { clearLocalTeamData } from "./assignmentStore";

export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

/** What the live coach did during the call (kept with browser-stored sessions for the debrief). */
export interface CoachLog {
  mode: CoachMode;
  source?: "llm" | "heuristic";
  model?: string;
  p50Ms?: number | null;
  cues: { triggerTurn: number; type: CueType; title: string; used: boolean }[];
}

export interface StoredSession {
  id: string;
  createdAt: string;
  mode: "voice" | "text";
  durationSeconds: number;
  scenario: Scenario;
  transcript: StoredTurn[];
  evaluation: Evaluation | null;
  coach?: CoachLog;
}

/**
 * /api/evaluate-call adds a `seal` to each grade it returns. The server checks it before it
 * stores a score; it means nothing in the browser, so it is split off and never kept.
 */
export function splitSeal(evaluation: Evaluation | null | undefined): { evaluation: Evaluation | null; seal?: string } {
  if (!evaluation) return { evaluation: null };
  const { seal, ...rest } = evaluation as Evaluation & { seal?: unknown };
  return { evaluation: rest, ...(typeof seal === "string" ? { seal } : {}) };
}

/** Replace a browser-stored session's evaluation (re-grade). */
export function updateLocalEvaluation(id: string, evaluation: Evaluation) {
  const clean = splitSeal(evaluation).evaluation;
  const all = readLocal().map((s) => (s.id === id ? { ...s, evaluation: clean } : s));
  localStorage.setItem(KEY, JSON.stringify(all));
}

const KEY = "rtct.sessions.v1";

function readLocal(): StoredSession[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function listLocalSessions(): StoredSession[] {
  return readLocal().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getLocalSession(id: string): StoredSession | undefined {
  return readLocal().find((s) => s.id === id);
}

export function deleteLocalSession(id: string) {
  localStorage.setItem(KEY, JSON.stringify(readLocal().filter((s) => s.id !== id)));
}

function saveLocal(s: Omit<StoredSession, "id" | "createdAt">): string {
  const id = `local-${Date.now().toString(36)}`;
  const all = [{ ...s, id, createdAt: new Date().toISOString() }, ...readLocal()].slice(0, 50);
  localStorage.setItem(KEY, JSON.stringify(all));
  return id;
}

/** Returns the new session id (prefixed `local-` when stored in the browser). */
export async function saveSession(s: Omit<StoredSession, "id" | "createdAt">, useServer: boolean): Promise<string> {
  const { evaluation, seal } = splitSeal(s.evaluation);
  if (useServer) {
    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: `${s.mode}-${Date.now()}`,
          transcript: s.transcript,
          durationSeconds: s.durationSeconds,
          scenario: { id: s.scenario.id, title: s.scenario.title, industry: s.scenario.industry, difficulty: s.scenario.difficulty },
          evaluation: evaluation ?? undefined,
          seal,
        }),
      });
      if (res.ok) return (await res.json()).id as string;
    } catch {
      /* fall through to local storage */
    }
  }
  return saveLocal({ ...s, evaluation });
}

/** Re-insert a deleted session (undo), keeping newest-first order. */
export function restoreLocalSession(s: StoredSession) {
  const all = readLocal().filter((x) => x.id !== s.id);
  localStorage.setItem(KEY, JSON.stringify([s, ...all].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50)));
}

/** Demo mode: wipe browser-stored sessions, custom scenarios and the editor draft. */
export function resetDemoData() {
  for (const k of [KEY, "rtct.scenarios.v1"]) localStorage.removeItem(k);
  // Demo assignments and supervisor notes live in the browser too.
  clearLocalTeamData();
  try {
    sessionStorage.removeItem("rtct.editor.draft.v1");
  } catch {
    /* ignore */
  }
}
