/**
 * Copy for the debrief, "Next move first". Client-safe and pure. No example copy: a real debrief shows only what the
 * stored grade, the transcript and the persona pack contain.
 */
import { namesVendorOrEnv } from "@/components/call/callCopy";

export const DEBRIEF_HEADLINE = "Practice one better next question.";

export const NEXT_MOVE_LABELS = { buyerSaid: "Buyer said", whatHappened: "What happened", trySaying: "Try saying" } as const;

export const NEXT_MOVE_NOTES = {
  whatHappened: "From your grade's notes on this rubric area. An interpretation, not a quote.",
  trySaying: "A suggestion from this persona's prep answer, not a required script and not part of your grade. Use your real offer's details.",
} as const;

/** What the score is and what it is not. AI and rules-based grades both use the rubric's weighted average. */
export const SCORE_COPY = {
  ai: {
    heading: "Final score",
    definition: "The weighted average of the rubric scores below. Based on this transcript only: it says nothing about other calls or what the buyer decided later.",
  },
  rules: {
    heading: "Score estimate",
    definition: "A rules-based estimate, not an AI grade: the weighted average of the rubric scores below, which count the rubric topics you covered. Based on this transcript only.",
  },
  evidenceLink: "See the evidence for each score",
} as const;

/** Load failures and empty reports. Each has a plain next action. */
export const STATE_COPY = {
  loading: "Loading your debrief.",
  notFound: { title: "We couldn't find this session", body: "It may have been deleted, or the link is wrong.", action: "Back to progress" },
  forbidden: { title: "You can't open this session", body: "Only the rep who made the call and their team's managers can open it.", action: "Back to progress" },
  notLocal: { title: "This session isn't in this browser", body: "Practice calls on this server are saved in the browser that made them. Open the debrief there, or start a new call.", action: "Start a new call" },
  loadFailed: { title: "This session couldn't be loaded", body: "Check your connection and reload the page.", action: "Back to progress" },
  noTranscript: { title: "No transcript was saved for this call", body: "There is nothing to review or grade. Start a new call to practice.", action: "Practice again" },
  nothingSaid: { title: "Nothing to grade yet", body: "You didn't say anything on this call, so there's no score. Start a new call and try your opening line.", action: "Practice again" },
  notGraded: "This call wasn't graded. Your transcript is saved below.",
  insufficientEvidence: "Not enough evidence: no quote in this grade matches the transcript word for word, so no rubric score is backed by verified evidence. Treat the scores as a rough guide, read the transcript below, then retry the call.",
  noCriterionEvidence: "No direct transcript evidence found for this criterion.",
} as const;

export const QUOTE_LABELS = {
  inexact: (turn: number) => `Not an exact quote. Wording differs from turn ${turn}.`,
  unmatched: "Unverified quote. It wasn't found in this transcript.",
  /** Transcript annotation for a turn cited with wording that differs from it: not evidence, so it says so. */
  citedInexact: (criteria: string) => `Cited for ${criteria}, wording differs. Not verified evidence.`,
} as const;

/** Shown instead of a re-grade error that names a provider, a model or a server setting. */
export const REGRADE_UNAVAILABLE = "AI grading isn't available on this server right now. Ask your admin to check Settings, Models, then try again.";

export const regradeErrorText = (message: string): string => (namesVendorOrEnv(message) ? REGRADE_UNAVAILABLE : message);
