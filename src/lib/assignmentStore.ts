"use client";
/**
 * Browser-only team data for demo mode (and installs without a database):
 * training assignments, plus supervisor notes on the sample team's sessions.
 * With a database these live in Postgres behind /api/team/assignments and
 * /api/sessions/<id>/notes instead.
 */
import { AssignmentInputSchema, assignmentInputMessage, parseDueAt, type Assignment, type AssignmentInput } from "./team";

const KEY = "rtct.assignments.v1";
const NOTES_KEY = "rtct.team-notes.v1";
/** Fired on window after any change so other panels on the page can refresh. */
export const ASSIGNMENTS_CHANGED = "rtct:assignments";

function readAll(): Assignment[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw)
      ? raw.filter((a): a is Assignment => !!a && typeof a.id === "string" && typeof a.scenarioId === "string" && typeof a.createdAt === "string")
      : [];
  } catch {
    return [];
  }
}

function writeAll(list: Assignment[]): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, 200)));
    window.dispatchEvent(new CustomEvent(ASSIGNMENTS_CHANGED));
    return true;
  } catch {
    return false;
  }
}

/** Active assignments, newest first. */
export function listLocalAssignments(): Assignment[] {
  return readAll().filter((a) => !a.archivedAt).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Validates like the API route does, so demo mode behaves the same as a real install. */
export function createLocalAssignment(input: AssignmentInput, assignedById: string): { ok: true; assignment: Assignment } | { ok: false; message: string } {
  const parsed = AssignmentInputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, message: assignmentInputMessage(parsed.error.issues[0]?.path[0]) };
  const due = parseDueAt(parsed.data.dueAt, new Date());
  if (!due.ok) return { ok: false, message: due.message };
  const assignment: Assignment = {
    id: `local-asg-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    assignedById,
    assigneeId: parsed.data.assigneeId ?? null,
    scenarioId: parsed.data.scenarioId,
    scenarioTitle: parsed.data.scenarioTitle,
    note: parsed.data.note || null,
    dueAt: due.value?.toISOString() ?? null,
    createdAt: new Date().toISOString(),
    archivedAt: null,
  };
  if (!writeAll([assignment, ...readAll()])) return { ok: false, message: "This browser blocked local storage, so the assignment could not be saved. Allow site data and try again." };
  return { ok: true, assignment };
}

export function archiveLocalAssignment(id: string): boolean {
  const now = new Date().toISOString();
  return writeAll(readAll().map((a) => (a.id === id ? { ...a, archivedAt: now } : a)));
}

export interface LocalNote { note: string; by: string; at: string }

function readNotes(): Record<string, LocalNote> {
  try {
    const raw = JSON.parse(localStorage.getItem(NOTES_KEY) || "{}");
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function getLocalNote(sessionId: string): LocalNote | null {
  return readNotes()[sessionId] ?? null;
}

/** Saves (or, with an empty note, clears) a supervisor note. Returns false when storage is blocked. */
export function setLocalNote(sessionId: string, note: string, by: string): boolean {
  const all = readNotes();
  const trimmed = note.trim().slice(0, 4000);
  if (trimmed) all[sessionId] = { note: trimmed, by, at: new Date().toISOString() };
  else delete all[sessionId];
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false;
  }
}

export const localNoteIds = (): Set<string> => new Set(Object.keys(readNotes()));

/** Used by "Reset demo data"-style flows and tests. */
export function clearLocalTeamData() {
  try {
    localStorage.removeItem(KEY);
    localStorage.removeItem(NOTES_KEY);
    window.dispatchEvent(new CustomEvent(ASSIGNMENTS_CHANGED));
  } catch {
    /* storage blocked: nothing to clear */
  }
}
