/**
 * First run: a new user's first /trainer visit skips the briefing and opens a text call that grades itself.
 * Pure and client-safe, so the predicate and the auto-grade trigger can be tested without a browser.
 *
 * Only once per user: a saved session is the persisted flag. Once the first call is saved (server for stored
 * accounts, this browser in demo mode) the predicate is false on every later visit. No extra column or key.
 */

/** Query flag that forces first run for testing. Sign-up appends it on its /trainer landing. */
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
}

/**
 * True when this /trainer visit should open the first-run call. A link that names a persona or a retry always gets
 * the briefing. ?firstrun=1 forces it for testing; otherwise only a user with no saved sessions gets it.
 */
export function isFirstRun({ authenticated, sessionCount, params }: FirstRunInput): boolean {
  if (!authenticated) return false;
  if (params.get("scenario") || params.get("retry")) return false;
  if (params.get(FIRST_RUN_PARAM) === "1") return true;
  return sessionCount === 0;
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
