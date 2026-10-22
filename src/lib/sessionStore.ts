"use client";
/**
 * Practice-session persistence. Signed-in users with a database save to the
 * API; demo mode / no-database setups keep sessions in localStorage.
 */
import type { Scenario } from "./scenarios";
import type { Evaluation } from "./grader-types";

export interface StoredTurn {
  role: "user" | "assistant";
  text: string;
  timestamp?: string;
}

export interface StoredSession {
  id: string;
  createdAt: string;
  mode: "voice" | "text";
  durationSeconds: number;
  scenario: Scenario;
  transcript: StoredTurn[];
  evaluation: Evaluation | null;
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
          evaluation: s.evaluation ?? undefined,
        }),
      });
      if (res.ok) return (await res.json()).id as string;
    } catch {
      /* fall through to local storage */
    }
  }
  return saveLocal(s);
}
