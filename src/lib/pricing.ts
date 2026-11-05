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
/** Must equal PREMIUM_MINUTES_PER_UNIT in usagePlan: Premium minutes per Pro account, or per Team seat (shared). */
export const PREMIUM_MINUTES = 40;

/** Display prices in dollars. Premium is per account on Pro and per seat on Team, on the base plan's interval. */
export const PRICE = {
  pro: { month: 29, year: 290 },
  team: { month: 59, year: 590 },
  premium: { month: 20, year: 200 },
} as const;

export type Billing = "month" | "year";

/** Premium voice is held off sale until PREMIUM_VOICE_ON_SALE=true. The label shows on the card, the table and the FAQ. */
export const PREMIUM_COMING_SOON = "Coming soon (not on sale yet)";
/** The env var that puts Premium on sale. Only the exact string "true" turns it on; unset or anything else is off. */
export const PREMIUM_VOICE_ON_SALE_ENV = "PREMIUM_VOICE_ON_SALE";
/**
 * Whether Premium Voice is on sale: new checkouts with premium:true, the add-to-subscription preview and confirm, the
 * buy controls, and paid Premium at mint (off means every paid call mints Standard). Off by default. Comped Premium and
 * removing the add-on do not depend on it. Read on the server (serverConfig.premiumOnSale).
 */
export const isPremiumOnSale = (env: Record<string, string | undefined>): boolean => env[PREMIUM_VOICE_ON_SALE_ENV] === "true";

// ---- Premium voice copy --------------------------------------------------------------------------------------------
// Final strings: Margin Jev, Nov 5 2026. Source of truth: /workspace/ct-launch/margin/premium-voice-docs-input.md
// sections 5 (b, c, d) and 6, and /workspace/ct-launch/tier/premium-voice/final-spec-draft.md lines 118 to 122 ("Final
// copy (Margin Jev, Nov 5 2026, supersedes amendment wording)"). Kept verbatim; Pro never says "per seat", Team says
// pooled. Strings marked "adapted" have no final winner of their own and are documented in TRIAGE-PRISM-FIXES.md.

/** Final Team pricing line (Margin section 6, round 2 winner, gate 0.61), verbatim. */
export const PREMIUM_PRICE_LINE_TEAM = `Premium voice for Team: +$${PRICE.premium.month} per seat a month, ${PREMIUM_MINUTES} pooled minutes per seat.`;

/** The add-on line under the plan cards and on billing. Interval always matches the base plan. */
export function premiumPriceLine(plan: PlanIntent, interval: Billing = "month"): string {
  const p = PRICE.premium[interval];
  if (plan === "pro") {
    // Pro lines are unchanged (spec section 8 "Adapted (no per seat)"); no final Margin string replaces them.
    return interval === "year"
      ? `Premium voice: +$${p} a year. ${PREMIUM_MINUTES} Premium minutes a month, then Standard.`
      : `Premium voice: +$${p} a month. ${PREMIUM_MINUTES} Premium minutes, then Standard.`;
  }
  // Annual Team: the final monthly line with the annual price (adapted: the minutes are still monthly).
  return interval === "year"
    ? `Premium voice for Team: +$${p} per seat a year, ${PREMIUM_MINUTES} pooled minutes per seat each month.`
    : PREMIUM_PRICE_LINE_TEAM;
}

/** Where the plan's interval is not known yet (billing page before the preview): the annual price, same unit. */
export const premiumAnnualNote = (plan: PlanIntent): string => `Annual plans: $${PRICE.premium.year}${plan === "team" ? " per seat" : ""} a year.`;

/**
 * Pro disclosure. Based on Margin 5(c), with "a call in progress is never cut" replaced (Prism u63 Medium 1): a Premium
 * call is given a deadline of the Premium minutes left when it starts, so the old line overpromised.
 */
export const PREMIUM_DISCLOSURE_PRO = "After 40 Premium minutes, the next call switches to Standard voice. A Premium call is capped at your remaining Premium minutes, and we tell you before it starts. You are never charged extra.";
/** Team disclosure. Based on Margin 5(b), same change as Pro. Team minutes are pooled, so the cap is the pool's. */
export const PREMIUM_DISCLOSURE_TEAM = "Premium minutes are pooled, 40 per seat. After the pool is used, the next call starts on Standard voice. A Premium call is capped at the Premium minutes left in your pool, and we tell you before it starts. No overages.";
export const premiumDisclosure = (plan: PlanIntent): string => (plan === "team" ? PREMIUM_DISCLOSURE_TEAM : PREMIUM_DISCLOSURE_PRO);
/** Where Pro and Team are offered side by side (checkout choice): true for both, implies no per-rep cap. */
export const PREMIUM_DISCLOSURE_BOTH = "When your Premium minutes run out, your next call switches to Standard voice automatically. You are never charged extra.";

/**
 * Shown directly below the generic disclosure wherever Premium is offered or set up. Same policy as the disclosures:
 * a Premium call never switches voices mid-call, but it is given a deadline (its normal end) of the Premium minutes
 * left when it starts, and nothing extra is charged. The call setup and the live call then say exactly how long THIS
 * call can run (premiumCallLimitNotice in billingUi.ts).
 */
export const PREMIUM_CALL_LENGTH_NOTE = "A Premium call never switches voices. If fewer Premium minutes are left than a call can run, that call is set to end when they run out, and you see how long before it starts.";

/** Final Pro out-of-minutes nudge (Margin 5(d), round 2 winner, gate 0.63), verbatim. */
export const PREMIUM_NUDGE_PRO = "Premium minutes used. Your next call uses Standard voice, and nothing extra is charged. Premium resets on your billing date.";
/**
 * Team uses the same final string (adapted): Margin 5 retired the "Add a seat for 40 more" winner and found no Team
 * upgrade mention that passed, and the sentence is accurate for a shared pool.
 */
export const PREMIUM_NUDGE_TEAM = PREMIUM_NUDGE_PRO;
export const premiumNudge = (plan: PlanIntent): string => (plan === "team" ? PREMIUM_NUDGE_TEAM : PREMIUM_NUDGE_PRO);

/** FAQ answer once Premium is on sale. */
export const PREMIUM_FAQ = `Premium AI voice is a paid add-on for Pro and Team. Pro: +$${PRICE.premium.month}/mo with ${PREMIUM_MINUTES} Premium minutes. Team: +$${PRICE.premium.month}/seat/mo with ${PREMIUM_MINUTES} Premium minutes per seat, shared across the team. Those minutes come out of your plan minutes, not on top. After they are used, your next call uses Standard. No overages. Annual is $${PRICE.premium.year} (Pro) or $${PRICE.premium.year}/seat (Team).`;
/** Under "Start free" on Pro and Team only when checkout is not configured on this server (billingEnabled is false). */
export const OPEN_SOON_LINE = "Pro and Team checkout is not set up on this server. Free is live today, no card.";

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
