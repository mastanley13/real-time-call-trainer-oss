/**
 * First run: a new user's first /trainer visit skips the briefing and opens a text call that grades itself.
 * Pure and client-safe, so the predicate and the auto-grade trigger can be tested without a browser.
 *
 * Only once per user: a saved session is the persisted flag (no schema change). A first visit left before grading,
 * or switched to voice, saves nothing, so this browser also remembers the last persona practised and a per-user
 * "first run started" marker; either one turns first run off.
 */

/** Query flag that forces first run. Sign-up appends it on its /trainer landing for a new account only. */
export const FIRST_RUN_PARAM = "firstrun";
/** User replies before the call grades itself. */
export const FIRST_RUN_REPLIES = 3;
/** Seconds before the call grades itself, whatever the reply count. */
export const FIRST_RUN_SECONDS = 300;

export interface FirstRunInput {
  /** Signed in, or the demo user (whose sessions live in this browser). */
  authenticated: boolean;
  /** Saved sessions for this user. Null when the lookup failed or has not answered: then it is not a first run. */
  sessionCount: number | null;
  params: { get(name: string): string | null };
  /** This browser has a last practised persona saved. */
  lastScenario?: boolean;
  /** This user already started a first-run call in this browser. */
  started?: boolean;
}

/**
 * True when this /trainer visit should open the first-run call. A link that names a persona or a retry always gets
 * the briefing. ?firstrun=1 forces it; otherwise only a user with no saved sessions, no saved last persona and no
 * first-run marker gets it.
 */
export function isFirstRun({ authenticated, sessionCount, params, lastScenario = false, started = false }: FirstRunInput): boolean {
  if (!authenticated) return false;
  if (params.get("scenario") || params.get("retry")) return false;
  if (params.get(FIRST_RUN_PARAM) === "1") return true;
  if (lastScenario || started) return false;
  return sessionCount === 0;
}

/**
 * A new account's landing path with ?firstrun=1 added, when it lands on a plain /trainer (no persona or retry named).
 * Any other path, such as checkout or /library, is returned unchanged.
 */
export function withFirstRun(path: string): string {
  const url = new URL(path, "http://x");
  if (url.pathname !== "/trainer" || url.searchParams.has("scenario") || url.searchParams.has("retry")) return path;
  url.searchParams.set(FIRST_RUN_PARAM, "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const MARKER = "rtct.firstRunStarted.";

/** The localStorage key for one user's first-run marker. */
export const firstRunMarkerKey = (userId: string) => `${MARKER}${userId}`;

/** True when this user's first-run call has started in this browser. Blocked storage reads as not started. */
export function hasStartedFirstRun(userId: string | undefined, store?: Store | null): boolean {
  if (!userId) return false;
  try {
    return (store ?? localStorage).getItem(firstRunMarkerKey(userId)) === "1";
  } catch {
    return false;
  }
}

/** Remembers that this user's first-run call began, so leaving it does not bring it back. */
export function markFirstRunStarted(userId: string | undefined, store?: Store | null): void {
  if (!userId) return;
  try {
    (store ?? localStorage).setItem(firstRunMarkerKey(userId), "1");
  } catch {
    // Blocked storage: the saved session and last persona still stop a repeat once a call is saved.
  }
}

/**
 * Numbers each call so work started for one call (a text reply in flight) can tell that a newer call, or the
 * briefing, has replaced it, and drop its result.
 */
export function callGeneration() {
  let n = 0;
  return {
    /** Starts a new call (or ends the current one) and returns its number. */
    next: () => ++n,
    get current() { return n; },
    isCurrent: (g: number) => g === n,
  };
}

type Turn = { role: "user" | "assistant"; text: string };

/** Replies the user has sent so far. */
export const repliesSent = (turns: Turn[]) => turns.filter((t) => t.role === "user" && t.text.trim()).length;

/** True once the target reply has its caller answer, or the time is up. */
export function autoFinishDue(turns: Turn[], elapsed: number, replies = FIRST_RUN_REPLIES, seconds = FIRST_RUN_SECONDS): boolean {
  if (elapsed >= seconds) return true;
  let sent = 0;
  for (const t of turns) {
    if (t.role === "user" && t.text.trim()) sent++;
    else if (t.role === "assistant" && sent >= replies) return true;
  }
  return false;
}

/** Fires at most once per call: true the first time the call is due, false on every check after that. */
export function autoFinishGate(replies = FIRST_RUN_REPLIES, seconds = FIRST_RUN_SECONDS) {
  let fired = false;
  return {
    check(turns: Turn[], elapsed: number): boolean {
      if (fired || !autoFinishDue(turns, elapsed, replies, seconds)) return false;
      fired = true;
      return true;
    },
    get fired() { return fired; },
    reset() { fired = false; },
  };
}

/** What /trainer renders: a skeleton while deciding or starting the first-run call, the briefing when idle, else the deck. */
export type FirstRunState = "deciding" | "start" | "on" | "off";
export function trainerView(phase: "idle" | "live" | "grading", firstRun: FirstRunState): "skeleton" | "briefing" | "deck" {
  if (phase !== "idle") return "deck";
  return firstRun === "deciding" || firstRun === "start" ? "skeleton" : "briefing";
}
