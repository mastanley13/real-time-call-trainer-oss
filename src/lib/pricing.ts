/** Locked plan numbers. Pricing and landing pages render from here so they never drift. */

/** Must equal FREE_MINUTES in usagePlan (PR #20). Import it here once #20 merges. */
export const FREE_VOICE_MIN = 10;
/** One-line Free plan summary, used on the Free card and in the FAQ. */
export const FREE_SUMMARY = `Free: ${FREE_VOICE_MIN} voice minutes a month, enough for a full graded call, plus unlimited text practice. No card.`;
/** Exact in-app billing copy for how call length is counted. */
export const MINUTES_ROUNDED_NOTE = "Calls are counted in whole minutes, rounded up.";
export const PRO_VOICE_MIN = 200;
export const TEAM_VOICE_MIN_PER_SEAT = 300;
export const TEAM_MIN_SEATS = 3;
export const PREMIUM_VOICE_CAP_PCT = 60;

export const PRICE = {
  pro: { month: 29, year: 290 },
  team: { month: 59, year: 590 },
  premium: { month: 30, year: 300 },
} as const;

export type Billing = "month" | "year";

/** Premium AI voice is held off sale. The label shows on the card, the comparison table and the FAQ. */
export const PREMIUM_COMING_SOON = "Coming soon (not on sale yet)";
/** The checkout route rejects premium:true while this is false. Flip it only when Premium goes on sale. */
export const PREMIUM_VOICE_ON_SALE = false;
/** Under "Start free" on Pro and Team while billing is off. */
export const OPEN_SOON_LINE = "Pro and Team open soon. Free is live today, no card.";

export type PlanIntent = "pro" | "team";

/** What a sign-up link may carry. Every field is optional and already whitelisted. */
export interface SignupIntent {
  plan?: PlanIntent;
  interval?: Billing;
  src?: string;
  seg?: string;
}

const TAG = /^[a-z0-9_-]{1,40}$/;
/** Accepted interval spellings. The stored and emitted value is always month or year. */
const INTERVAL_ALIASES = new Map<string, Billing>([
  ["month", "month"], ["monthly", "month"], ["year", "year"], ["yearly", "year"], ["annual", "year"],
]);

/**
 * Whitelists sign-up link values: plan is pro or team, interval is month or year, src and seg are 1 to 40 chars of
 * [a-z0-9_-] (lowercased first). Anything else is dropped. Interval also accepts monthly, yearly and annual. Used by the register page and the register route.
 */
export function sanitizeSignupIntent(raw: { plan?: unknown; interval?: unknown; src?: unknown; seg?: unknown }): SignupIntent {
  const tag = (v: unknown) => (typeof v === "string" && TAG.test(v.toLowerCase()) ? v.toLowerCase() : undefined);
  const out: SignupIntent = {};
  if (raw.plan === "pro" || raw.plan === "team") out.plan = raw.plan;
  const interval = typeof raw.interval === "string" ? INTERVAL_ALIASES.get(raw.interval.toLowerCase()) : undefined;
  if (interval) out.interval = interval;
  const src = tag(raw.src);
  if (src) out.src = src;
  const seg = tag(raw.seg);
  if (seg) out.seg = seg;
  return out;
}

/** What /register shows for a plan link: name, period, price for that period and, for Team, the seat minimum. */
export function planSummary(intent: SignupIntent): { name: string; periodLabel: string; price: string; seats?: string } | null {
  if (!intent.plan) return null;
  const interval = intent.interval ?? "month";
  const team = intent.plan === "team";
  const unit = interval === "year" ? "yr" : "mo";
  return {
    name: team ? "Team" : "Pro",
    periodLabel: interval === "year" ? "Annual" : "Monthly",
    price: `$${PRICE[intent.plan][interval]}${team ? "/seat" : ""}/${unit}`,
    ...(team ? { seats: `${TEAM_MIN_SEATS} seats minimum. You choose seats at checkout.` } : {}),
  };
}

/** Sign-up link for a CTA. Query params are kept in a fixed order. */
export function registerHref(params: { plan?: PlanIntent; interval?: Billing; seg?: string; src: string }): string {
  const q = new URLSearchParams();
  if (params.plan) q.set("plan", params.plan);
  if (params.plan && params.interval) q.set("interval", params.interval);
  if (params.seg) q.set("seg", params.seg);
  q.set("src", params.src);
  return `/register?${q.toString()}`;
}

/** The checkout step for a plan and period. Team seats are chosen on that page. */
export function checkoutStartHref(plan: PlanIntent, interval: Billing = "month"): string {
  return `/checkout/start?plan=${plan}&interval=${interval}`;
}
