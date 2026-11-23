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
  /** Legacy only: older browser-stored sessions may carry a model id. New sessions never write it and the debrief never shows it. */
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

/**
 * Like listLocalSessions, but says when the read failed: null when storage is unavailable or throws, the stored value
 * is not valid JSON, or it is not an array. Nothing stored yet is a genuine empty list ([]). For callers that must not
 * treat a failed read as "no sessions" (the debrief's first-graded check). Entries are not validated beyond being objects.
 */
export function readLocalSessionsStrict(store?: Pick<Storage, "getItem"> | null): StoredSession[] | null {
  try {
    const raw = (store ?? localStorage).getItem(KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((s) => typeof s === "object" && s !== null)) return null;
    return parsed as StoredSession[];
  } catch {
    return null;
  }
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
 * minting (`sessionId`), the opaque encrypted receipt bound to it (absent without JWT_SECRET), and the metering call id when
 * the call is metered (then equal to sessionId).
 */
export interface MintedCall { sessionId: string; receipt?: string; callId?: string }

/**
 * The id a call is graded and saved under. /api/evaluate-call binds its grade seal to this id and POST /api/transcripts
 * stores the grade only under the same id, so the caller makes it once, before grading, and passes it to both. A minted
 * voice call uses its server-fixed sessionId. Anything else gets a fresh id with 96 random bits, so no two calls (of any
 * user) share one: the server keys a graded row on it. getRandomValues works outside secure contexts too.
 */
export function callSessionId(mode: StoredSession["mode"], call: MintedCall | undefined, now = Date.now()): string {
  const voice = mode === "voice" ? call : undefined;
  if (voice?.sessionId) return voice.sessionId;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `${mode}-${now}-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The POST /api/transcripts body. A minted voice call is saved under its server-fixed sessionId with its receipt;
 * a metered one also names its callId. Only a voice save carries any of them; text saves name themselves.
 * Pass the `sessionId` the call was graded under (callSessionId), or its seal won't verify.
 */
export function transcriptSaveBody(
  s: Omit<StoredSession, "id" | "createdAt">,
  evaluation: StoredSession["evaluation"] | null | undefined,
  seal: string | undefined,
  call: MintedCall | undefined,
  now = Date.now(),
  sessionId = callSessionId(s.mode, call, now),
) {
  const voice = s.mode === "voice" ? call : undefined;
  return {
    sessionId,
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
 * `meta.sessionId` is the id the call was graded under (callSessionId); the grade's seal verifies only under it.
 */
export async function saveSession(s: Omit<StoredSession, "id" | "createdAt">, useServer: boolean, meta: { call?: MintedCall; sessionId?: string } = {}): Promise<string> {
  const { evaluation, seal } = splitSeal(s.evaluation);
  if (useServer) {
    try {
      const res = await fetch("/api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transcriptSaveBody(s, evaluation, seal, meta.call, Date.now(), meta.sessionId)),
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
