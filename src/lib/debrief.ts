/** Pure helpers for the debrief: where to retry from, and which persona to drill next. */
import type { Evaluation } from "./grader-types";
import type { ObjectionType, Scenario } from "./scenarios";

const STOP = new Set("the a an and or of to in on for with is are be your you their this that it as at by from about when what how any all can will has have was were not but if then them they her his its our out up per get gets got into also more most very just than so do does did clearly before after".split(" "));
const SYNONYMS: Record<string, string[]> = {
  price: ["cost", "fee", "pricing", "expensive", "budget", "afford", "pay", "quote", "rate"],
  pricing: ["cost", "fee", "price", "expensive", "budget", "afford", "pay", "quote"],
  fee: ["cost", "price", "charge", "pay"],
  objection: ["but", "worried", "concern", "not sure", "too"],
  booking: ["schedule", "appointment", "time", "today", "tomorrow", "window"],
  close: ["commit", "sign", "decide", "next step"],
  contract: ["term", "months", "commitment", "lock"],
};

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

function keywordsFor(name: string, description: string) {
  const base = words(`${name} ${description}`);
  const extra = base.flatMap((w) => SYNONYMS[w] ?? []);
  return [...new Set([...base, ...extra])];
}

/**
 * The 1-based caller turn to restart from so the rep can redo the weakest moment:
 * the first persona line that touches the weakest criterion's topic, else the persona
 * line just before that criterion's best evidence, else the persona's second line.
 */
export function retryPoint(transcript: { role: string; text: string }[], ev: Evaluation): { turn: number; criterion: string; score: number } | null {
  if (!ev.criteria.length || transcript.length < 2) return null;
  const weakest = [...ev.criteria].sort((a, b) => a.score - b.score)[0];
  const kws = keywordsFor(weakest.name, "");
  const callerIdx = transcript.map((t, i) => (t.role === "assistant" ? i : -1)).filter((i) => i >= 0);
  if (!callerIdx.length) return null;
  const topical = callerIdx.find((i) => i > 0 && kws.some((k) => transcript[i].text.toLowerCase().includes(k)));
  const evidenceLine = weakest.evidence[0]?.line;
  const beforeEvidence = evidenceLine ? [...callerIdx].reverse().find((i) => i < evidenceLine - 1) : undefined;
  const idx = topical ?? beforeEvidence ?? callerIdx[Math.min(1, callerIdx.length - 1)];
  return { turn: idx + 1, criterion: weakest.name, score: weakest.score };
}

/**
 * Whether the viewer's own session list can decide the first-graded demo button for this debrief. Browser sessions
 * live in the viewer's own storage, so yes. A server session counts only when the viewer made the call: a manager
 * opening a trainee's debrief would otherwise be judged on the manager's history, so the button stays hidden.
 */
export function viewerOwnsSession(view: { local: boolean; ownerId?: string | null }, viewerId: string | null | undefined): boolean {
  if (view.local) return true;
  return !!viewerId && !!view.ownerId && view.ownerId === viewerId;
}

/** GET /api/transcripts returns at most this many sessions, newest first (`take: 100` in the route). */
export const TRANSCRIPT_LIST_CAP = 100;
/** The browser keeps at most this many sessions, newest first (saveLocal in sessionStore.ts). */
export const LOCAL_SESSION_CAP = 50;

/**
 * Whether the debrief shows "Book a demo for your team": only when this call has a grade and none of the rep's other
 * sessions does, so it is their first graded debrief. `sessions` is what the rep has (browser sessions, or the
 * GET /api/transcripts list); this call may or may not be in it.
 * `cap` is the most the list can hold. A list at the cap with no other graded session may be cut off before an older
 * graded one, so it counts as incomplete and the button stays hidden. A shorter list is complete.
 */
export function showFirstGradedDemo(currentId: string, currentGraded: boolean, sessions: { id: string; graded: boolean }[], cap?: number): boolean {
  if (!currentGraded) return false;
  if (sessions.some((s) => s.id !== currentId && s.graded)) return false;
  return cap === undefined || sessions.length < cap;
}

const TOPIC_TO_OBJECTION: [RegExp, ObjectionType][] = [
  [/price|pricing|fee|cost|value|budget/i, "price"],
  [/compet|compar/i, "competitor"],
  [/decision|authority|stakeholder|spouse/i, "authority"],
  [/trust|credib|rapport/i, "trust"],
  [/timing|urgency|contract/i, "timing"],
];

/** A different library persona that drills the weakest criterion's topic. */
export function nextDrill(library: Scenario[], current: { id?: string; role?: string }, weakestName: string): Scenario | undefined {
  const pool = library.filter((s) => s.id !== current.id);
  const type = TOPIC_TO_OBJECTION.find(([re]) => re.test(weakestName))?.[1];
  const byObjection = type ? pool.filter((s) => s.objections.some((o) => o.type === type)) : [];
  const sameRole = byObjection.filter((s) => s.role === current.role);
  return sameRole[0] ?? byObjection.find((s) => s.status === "reviewed") ?? byObjection[0] ?? pool.find((s) => s.role === current.role) ?? pool[0];
}
