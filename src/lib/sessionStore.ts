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

/**
 * What /api/realtime/session hands back to identify one OpenAI Realtime call: the call id the server fixed before
 * minting (`sessionId`), the signed receipt bound to it (absent without JWT_SECRET), and the metering call id when
 * the call is metered (then equal to sessionId).
 */
export interface MintedCall { sessionId: string; receipt?: string; callId?: string }

/**
 * The POST /api/transcripts body. A minted voice call is saved under its server-fixed sessionId with its receipt;
 * a metered one also names its callId. Only a voice save carries any of them; text saves name themselves.
 */
export function transcriptSaveBody(
  s: Omit<StoredSession, "id" | "createdAt">,
  evaluation: StoredSession["evaluation"] | null | undefined,
  seal: string | undefined,
  call: MintedCall | undefined,
  now = Date.now(),
) {
  const voice = s.mode === "voice" ? call : undefined;
  return {
    sessionId: voice?.sessionId ?? `${s.mode}-${now}`,
    ...(voice?.callId ? { callId: voice.callId } : {}),
    transcript: s.transcript,
    durationSeconds: s.durationSeconds,
    scenario: { id: s.scenario.id, title: s.scenario.title, industry: s.scenario.industry, difficulty: s.scenario.difficulty },
    evaluation: evaluation ?? undefined,
    seal,
    ...(voice?.receipt ? { realtimeReceipt: voice.receipt } : {}),
  };
}

/**
 * Returns the new session id (prefixed `local-` when stored in the browser).
 * `meta.call` identifies the voice call /api/realtime/session minted. The call is saved under its sessionId with
 * its receipt, which the server checks before it logs the model inside it, and a metered call also sends its
 * callId so the transcript fills that call's own row. Opaque here and never stored in the browser.
 */
export async function saveSession(s: Omit<StoredSession, "id" | "createdAt">, useServer: boolean, meta: { call?: MintedCall } = {}): Promise<string> {
  const { evaluation, seal } = splitSeal(s.evaluation);
  if (useServer) {
    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transcriptSaveBody(s, evaluation, seal, meta.call)),
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
