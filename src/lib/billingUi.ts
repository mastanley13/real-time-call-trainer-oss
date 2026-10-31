import { FREE_MINUTES, PRO_MINUTES, TEAM_MAX_SEATS, TEAM_MIN_SEATS, TEAM_MINUTES_PER_SEAT, type PlanTier } from "./usagePlan";

/**
 * Wording and small pure helpers for the billing page and the call screens. Client-safe: no env, no database.
 * Kept out of the components so the copy and the seat and price rules can be tested.
 */

// ---- Cap messages --------------------------------------------------------------------------------

/** Shown when a voice call is refused because the minutes are used up. The UI adds an Upgrade link next to it. */
export const CAP_REACHED_MESSAGE = "You have used all your voice minutes for this period. Switch to Text to practice, or upgrade your plan.";
/** Shown when a Pro or Team call is stopped by its reserved minutes. */
export const CAP_STOPPED_MESSAGE = "You have used all your voice minutes for this period.";

export const BILLING_PATH = "/settings/billing";

/** True for the two messages that mean "out of voice minutes", so the UI can offer an upgrade next to them. */
export const isCapMessage = (message: string | null | undefined): boolean => message === CAP_REACHED_MESSAGE || message === CAP_STOPPED_MESSAGE;

// ---- Minutes -------------------------------------------------------------------------------------

/** 12 stays "12"; a half minute shows as "9.5". */
export const formatMinutes = (n: number): string => String(Math.round(n * 100) / 100);

/** "10 voice minutes left", "1 voice minute left", "0.5 voice minutes left". */
export const minutesLeftLabel = (remaining: number): string => `${formatMinutes(remaining)} voice ${remaining === 1 ? "minute" : "minutes"} left`;

/** Minutes left from a /api/usage response, or null when minutes are not metered or the answer is unusable. */
export function minutesLeftFromUsage(data: unknown): number | null {
  const d = data as { metered?: unknown; remaining?: unknown } | null;
  return d?.metered === true && typeof d.remaining === "number" && Number.isFinite(d.remaining) ? Math.max(0, d.remaining) : null;
}

// ---- Billing page header ---------------------------------------------------------------------------

/**
 * The line under the page title. It says what is true for the plan: Free is checked only when a call starts,
 * paid plans stop a call when its minutes run out. Every plan resets monthly on its anchor date.
 */
export function usageHeaderCopy(plan: PlanTier | undefined, pooled = false): string {
  if (plan === "free") {
    return `Free includes ${FREE_MINUTES} voice minutes a month. Voice calls are checked only when they start, so a call that begins with minutes left runs to its end and counts toward the month. Minutes reset each month on your signup date and do not roll over. Text practice is never limited, and there are no overage charges.`;
  }
  if (plan === "pro" || plan === "team") {
    const when = plan === "team" || pooled ? "your organization's start date" : "your signup date";
    const pool = plan === "team" || pooled ? "Your team shares one pool of voice minutes. " : "";
    return `${pool}Voice minutes reset every month on ${when}. Unused minutes do not roll over, and a call stops when its minutes run out. Text practice is never limited, and there are no overage charges.`;
  }
  return "Your plan and billing in one place.";
}

// ---- Plans and prices ------------------------------------------------------------------------------

export type Interval = "month" | "year";

/** Display prices in dollars. Annual is ten months for twelve. The Stripe prices are the source of truth at checkout. */
export const PRICE = {
  pro: { month: 29, year: 290 },
  team: { month: 59, year: 590 },
  premium: { month: 30, year: 300 },
} as const;

const per = (i: Interval) => (i === "month" ? "month" : "year");

export function planPriceLine(plan: "pro" | "team", interval: Interval): string {
  if (plan === "pro") return `$${PRICE.pro[interval]} per user per ${per(interval)}. ${PRO_MINUTES} voice minutes a month.`;
  return `$${PRICE.team[interval]} per seat per ${per(interval)}, ${TEAM_MIN_SEATS} seats minimum. ${TEAM_MINUTES_PER_SEAT} pooled minutes per seat each month.`;
}

export const premiumLabel = (interval: Interval): string => `Add Premium Voice (+$${PRICE.premium[interval]} per seat per ${per(interval)})`;

/** The Pro button: a Team member already has Pro's minutes, so it says so. */
export function proButtonLabel(plan: PlanTier | undefined): string {
  return plan === "pro" ? "Current plan" : plan === "team" ? "Included in Team" : "Choose Pro";
}

export const teamButtonLabel = (plan: PlanTier | undefined): string => (plan === "team" ? "Current plan" : "Choose Team");

// ---- Seats -----------------------------------------------------------------------------------------

/**
 * The seat count for what is typed in the box. Empty or not a number is the minimum; decimals round down.
 * Called on blur and on submit, never on each keystroke, so the box can be cleared and 10 can be typed.
 */
export function clampSeats(text: string): number {
  const n = Math.floor(Number(text.trim()));
  if (!Number.isFinite(n)) return TEAM_MIN_SEATS;
  return Math.min(TEAM_MAX_SEATS, Math.max(TEAM_MIN_SEATS, n));
}
