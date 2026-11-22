import { FREE_VOICE_MIN } from "@/lib/pricing";

/** Home page (Practice Desk) copy. Page files may only export Next.js fields, so shared strings live here. */
export const HERO_HEADLINE = "Practice the price objection before your next call.";

/** The Free plan line, built from the locked plan numbers so it never drifts from pricing. */
const freeMin: number = FREE_VOICE_MIN;
export const FREE_LINE = `${freeMin === 10 ? "Ten" : freeMin} voice minutes monthly, unlimited text.`;

export const HOME_STEPS = [
  { step: "Brief", title: "Know the buyer", body: "Pick a persona. Read the goal, the objections to expect and the talk track." },
  { step: "Call", title: "Try your answer", body: "Talk or type. A coach rail only you can see whispers the next move." },
  { step: "Debrief", title: "Work from evidence", body: "Scores cite your own words. Return to the difficult moment and practice again." },
] as const;
