import { FREE_MINUTES, PRO_MINUTES, TEAM_MAX_SEATS, TEAM_MIN_SEATS, TEAM_MINUTES_PER_SEAT, type PlanTier } from "./usagePlan";
import { PRICE as PLAN_PRICE } from "./pricing";

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
/** Where Upgrade goes when billing is off on this server: there is nothing to buy, so it shows the plans. */
export const PRICING_PATH = "/pricing";
/** The usage lookup failed, so voice is refused. Shown with a link to the text sim. */
export const VOICE_UNAVAILABLE_MESSAGE = "Voice is unavailable right now. Text practice still works.";

/** For a Team pool member who cannot buy minutes themselves. Shown instead of the Upgrade link. */
export const ASK_ADMIN_MESSAGE = "Ask your team admin for more minutes.";
const POOL_MEMBER_CAP_MESSAGE = "You have used all your voice minutes for this period. Switch to Text to practice.";

/** True for the two messages that mean "out of voice minutes", so the UI can offer an upgrade next to them. */
export const isCapMessage = (message: string | null | undefined): boolean => message === CAP_REACHED_MESSAGE || message === CAP_STOPPED_MESSAGE;

/**
 * What to show for an error on the briefing or call screen. A cap message normally offers an Upgrade link. A member of a
 * Team pool who is not an owner or manager cannot buy anything, so they are told to ask their admin and get no link.
 * Other errors pass through unchanged.
 */
export function capCopy(message: string, canUpgrade = true): { text: string; action: "upgrade" | "ask_admin" | null } {
  if (!isCapMessage(message)) return { text: message, action: null };
  return canUpgrade ? { text: message, action: "upgrade" } : { text: POOL_MEMBER_CAP_MESSAGE, action: "ask_admin" };
}

/** Whether this person can buy or change a plan, from a /api/usage response. Defaults to yes when it is not said. */
export const canUpgradeFromUsage = (data: unknown): boolean => (data as { billing?: { canUpgrade?: unknown } } | null)?.billing?.canUpgrade !== false;

// ---- Minutes -------------------------------------------------------------------------------------

/** 12 stays "12"; a half minute shows as "9.5". */
export const formatMinutes = (n: number): string => String(Math.round(n * 100) / 100);

/** "10 voice minutes left", "1 voice minute left", "0.5 voice minutes left". */
export const minutesLeftLabel = (remaining: number): string => `${formatMinutes(remaining)} voice ${remaining === 1 ? "minute" : "minutes"} left`;

/** The count the briefing shows: minutes left and the plan's minutes for the period. */
export interface UsageSnapshot {
  remaining: number;
  cap: number;
  /** ISO date the minutes reset (the end of the period), when the server said. */
  resetsAt?: string;
  /** False when billing is off on this server, so Upgrade goes to the pricing page. */
  billingEnabled?: boolean;
}

/** "Nov 10" from an ISO date, in UTC so the server and the browser agree; empty when it is not a date. */
export function formatResetDate(iso: string | undefined): string {
  const t = iso ? new Date(iso) : null;
  return t && Number.isFinite(t.getTime()) ? t.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";
}

/** Where the Upgrade link goes: billing when it is on, the pricing page when it is off. */
export const upgradePath = (u: Pick<UsageSnapshot, "billingEnabled">): string => (u.billingEnabled === false ? PRICING_PATH : BILLING_PATH);

/** Shown near Start call in Voice mode when no minutes are left. The Upgrade link, or the ask-your-admin line, goes with it. */
export const OUT_OF_MINUTES_MESSAGE = "Out of voice minutes this month.";
/** Shown near Start call in Text mode when minutes are metered: text is never counted. */
export const TEXT_UNLIMITED_MESSAGE = "Text practice is unlimited.";

/** "10 of 10 voice minutes left", "0.5 of 10 voice minutes left". */
export const voiceMinutesLeftLabel = (u: UsageSnapshot): string => `${formatMinutes(u.remaining)} of ${formatMinutes(u.cap)} voice minutes left`;

/** Remaining and plan minutes from a /api/usage response; null when minutes are not metered or the answer is unusable. */
export function usageSnapshotFromUsage(data: unknown): UsageSnapshot | null {
  const d = data as { metered?: unknown; remaining?: unknown; minutesCap?: unknown; periodEnd?: unknown; billing?: { enabled?: unknown } } | null;
  if (d?.metered !== true || typeof d.remaining !== "number" || typeof d.minutesCap !== "number") return null;
  if (!Number.isFinite(d.remaining) || !Number.isFinite(d.minutesCap)) return null;
  return {
    remaining: Math.max(0, d.remaining),
    cap: Math.max(0, d.minutesCap),
    ...(typeof d.periodEnd === "string" ? { resetsAt: d.periodEnd } : {}),
    ...(typeof d.billing?.enabled === "boolean" ? { billingEnabled: d.billing.enabled } : {}),
  };
}

/** Minutes left from a /api/usage response, or null when minutes are not metered or the answer is unusable. */
export function minutesLeftFromUsage(data: unknown): number | null {
  const d = data as { metered?: unknown; remaining?: unknown } | null;
  return d?.metered === true && typeof d.remaining === "number" && Number.isFinite(d.remaining) ? Math.max(0, d.remaining) : null;
}

/** On the Pro and Team intro: a call can end up to half a minute past the plan's minutes, because the last minute counts in full. */
export const ROUND_UP_NOTE = "Calls are counted in whole minutes, rounded up.";

// ---- Billing page header ---------------------------------------------------------------------------

/**
 * The line under the page title. It says what is true for the plan: Free is checked only when a call starts,
 * paid plans stop a call when its minutes run out. Every plan resets monthly on its anchor date.
 */
export function usageHeaderCopy(plan: PlanTier | undefined, pooled = false): string {
  if (plan === "free") {
    return `Free includes ${FREE_MINUTES} voice minutes a month. Voice calls are checked only when they start, so a call that begins with minutes left runs to its end and counts toward the month. Your minutes reset monthly from your signup date and do not roll over. Text practice is never limited, and there are no overage charges.`;
  }
  if (plan === "pro" || plan === "team") {
    const when = plan === "team" || pooled ? "your organization's start date" : "your signup date";
    const pool = plan === "team" || pooled ? "Your team shares one pool of voice minutes. " : "";
    return `${pool}Voice minutes reset every month on ${when}. Unused minutes do not roll over, and a call stops when its minutes run out. ${ROUND_UP_NOTE} Text practice is never limited, and there are no overage charges.`;
  }
  return "Your plan and billing in one place.";
}

/**
 * What a Free account that has used up its voice minutes is told on the billing page: why it can be over the cap
 * (the last call was allowed to finish), when voice comes back, and that text practice is still open.
 * Null when there is nothing to explain: not Free, or minutes are left. `resetDate` is the already formatted date
 * the minutes reset.
 */
export function freeOverCapNotice(input: { plan: PlanTier | undefined; used: number; cap: number; resetDate: string }): string | null {
  const { plan, used, cap, resetDate } = input;
  if (plan !== "free" || cap <= 0 || used < cap) return null;
  const when = resetDate ? ` when your minutes reset on ${resetDate}` : " when your minutes reset next month";
  const lead = used > cap
    ? `Your last call was allowed to finish, so you have used ${formatMinutes(used)} of ${formatMinutes(cap)} voice minutes this month.`
    : `You have used all ${formatMinutes(cap)} voice minutes this month.`;
  return `${lead} Voice calls start again${when}. Text practice is still open.`;
}

// ---- Plans and prices ------------------------------------------------------------------------------

export type Interval = "month" | "year";

/**
 * Display prices in dollars. Annual is ten months for twelve. The Stripe prices are the source of truth at checkout.
 * The same object as pricing.ts, so the billing page and the pricing page cannot drift (Premium: $20/mo, $200/yr).
 */
export const PRICE = PLAN_PRICE;

const per = (i: Interval) => (i === "month" ? "month" : "year");

export function planPriceLine(plan: "pro" | "team", interval: Interval): string {
  if (plan === "pro") return `$${PRICE.pro[interval]} per user per ${per(interval)}. ${PRO_MINUTES} voice minutes a month.`;
  return `$${PRICE.team[interval]} per seat per ${per(interval)}, ${TEAM_MIN_SEATS} seats minimum. ${TEAM_MINUTES_PER_SEAT} pooled minutes per seat each month.`;
}

/** The new-buyer checkbox label. Pro is one account, so it never says "per seat". */
export const premiumLabel = (interval: Interval, plan: "pro" | "team" = "team"): string =>
  `Add Premium voice (+$${PRICE.premium[interval]}${plan === "team" ? " per seat" : ""} per ${per(interval)})`;

// ---- Premium voice: setup, live call, results and billing ---------------------------------------------------

/** What the call setup and billing page know about Premium, from /api/usage. Never a model id. */
export interface PremiumSnapshot {
  /** Entitled now: Premium minutes this period. */
  enabled: boolean;
  /** Whole Premium minutes left that a new call can use. */
  remaining: number;
  /** Premium minutes this period (40 per unit; Team scaled by min(add-on quantity, seats)). */
  cap: number;
  plan: "pro" | "team" | "free";
  /** Premium can be bought on this server now (PREMIUM_VOICE_ON_SALE). */
  onSale: boolean;
  /** This person may buy or change it (Pro subscriber, Team owner). */
  canBuy: boolean;
  /** ISO date a scheduled removal takes effect, or null. */
  removeAt: string | null;
}

/** "Premium: 12 of 40 min left". */
export const premiumLeftLabel = (p: Pick<PremiumSnapshot, "remaining" | "cap">): string => `Premium: ${formatMinutes(p.remaining)} of ${formatMinutes(p.cap)} min left`;

export const ADD_PREMIUM_LABEL = "Add Premium voice";
export const ASK_ADMIN_PREMIUM = "Ask your admin";
/** Live call, shown once (aria-live polite) when this Premium call holds the last Premium minutes. */
export const NEXT_CALL_STANDARD_NOTICE = "Your Premium minutes are used up after this call. Your next call uses Standard voice.";
/** The call screen notice on a Free organization's one Premium trial call (PREMIUM_TRIAL_SAMPLE_ON). */
export const TRIAL_CALL_NOTICE = "Your team's Premium voice trial call, up to 5 minutes. Later calls use Standard voice.";
/** Live call voice label. Static for the whole call: the voice never changes mid-call. */
export const voiceLabel = (tier: "premium" | "standard"): string => (tier === "premium" ? "Premium voice" : "Standard voice");
/** Billing page line for a scheduled removal. */
export const premiumFallbackLine = (dateIso: string | null | undefined): string => {
  const d = formatResetDate(dateIso ?? undefined);
  return d ? `Falls back to Standard on ${d}.` : "Falls back to Standard at the end of this billing period.";
};

/** Premium state from a /api/usage response, or null when minutes are not metered or the answer is unusable. */
export function premiumSnapshotFromUsage(data: unknown): PremiumSnapshot | null {
  const d = data as { metered?: unknown; plan?: unknown; premiumVoice?: { enabled?: unknown; remaining?: unknown; minutesCap?: unknown; onSale?: unknown; canBuy?: unknown; removeAt?: unknown } } | null;
  const p = d?.premiumVoice;
  if (d?.metered !== true || !p || typeof p.remaining !== "number" || typeof p.minutesCap !== "number") return null;
  if (!Number.isFinite(p.remaining) || !Number.isFinite(p.minutesCap)) return null;
  const plan = d.plan === "pro" || d.plan === "team" ? d.plan : "free";
  return {
    enabled: p.enabled === true,
    remaining: Math.max(0, p.remaining),
    cap: Math.max(0, p.minutesCap),
    plan,
    onSale: p.onSale === true,
    canBuy: p.canBuy === true,
    removeAt: typeof p.removeAt === "string" ? p.removeAt : null,
  };
}

/**
 * What the call setup shows for Premium. `left` with the count; `used_up` with the nudge (calls continue on Standard);
 * `locked` with Add Premium voice (a buyer) or Ask your admin (a Team member); nothing on Free, or when Premium is
 * off sale and not on the account (no new paid controls while the sale is off).
 */
export function premiumSetupState(p: PremiumSnapshot | null): { kind: "left" | "used_up" | "locked_buy" | "locked_ask" | "none" } {
  if (!p || p.plan === "free") return { kind: "none" };
  if (p.enabled) return { kind: p.remaining >= 1 ? "left" : "used_up" };
  if (!p.onSale) return { kind: "none" };
  return { kind: p.canBuy ? "locked_buy" : "locked_ask" };
}

/** "$12.34" from cents. Currency code shown only when it is not USD. */
export function formatCents(cents: number | null | undefined, currency = "usd"): string {
  if (cents == null || !Number.isFinite(cents)) return "Unavailable";
  const amount = (cents / 100).toFixed(2);
  return currency.toLowerCase() === "usd" ? `$${amount}` : `${amount} ${currency.toUpperCase()}`;
}

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

/** Always shown under the seats field. */
export const SEATS_HELP = `Team starts at ${TEAM_MIN_SEATS} seats.`;
/** Shown, and announced, when the box is set to the minimum because it was left below it. */
export const SEATS_CLAMPED_NOTE = `Set to ${TEAM_MIN_SEATS}, the Team minimum.`;

/** Shown, and announced, when the box is set to the maximum because it was left above it. */
export const SEATS_MAX_NOTE = `Team plans go up to ${TEAM_MAX_SEATS} seats here. Contact us for more.`;

/**
 * What leaving the seats box does: the text it ends up with, and the note to show when that changed the number because
 * it was below the minimum (empty and non-numbers count as below) or above the maximum.
 */
export function seatsOnBlur(text: string): { value: string; note: string | null } {
  const typed = Math.floor(Number(text.trim()));
  const below = !Number.isFinite(typed) || typed < TEAM_MIN_SEATS;
  const above = Number.isFinite(typed) && typed > TEAM_MAX_SEATS;
  return { value: String(clampSeats(text)), note: below ? SEATS_CLAMPED_NOTE : above ? SEATS_MAX_NOTE : null };
}

// ---- Checkout failures -------------------------------------------------------------------------------

/** For any server or configuration failure starting checkout. No charge was made. */
export const CHECKOUT_UNAVAILABLE_MESSAGE = "Checkout is unavailable right now. Your plan has not changed.";
/** Only for a request that never got an answer (network error or timeout). */
export const CHECKOUT_NETWORK_MESSAGE = "Could not start checkout. Try again in a moment.";
/** Where to report a checkout problem. There is no support email until billing is live. */
export const SUPPORT_URL = "https://github.com/mastanley13/real-time-call-trainer-oss/issues";

/**
 * The message for a failed checkout start. A failed request (network error or timeout) says to try again; a server or
 * config error (5xx, or an answer with no checkout address) says checkout is unavailable and points to the issues page;
 * a 4xx keeps the server's own sentence, because it says what to fix (seats, an existing plan).
 */
export function checkoutFailure(input: { status?: number; networkError?: boolean; message?: string }): { message: string; help: boolean } {
  if (input.networkError) return { message: CHECKOUT_NETWORK_MESSAGE, help: false };
  const { status } = input;
  if (typeof status === "number" && status >= 400 && status < 500 && input.message) return { message: input.message, help: false };
  return { message: CHECKOUT_UNAVAILABLE_MESSAGE, help: true };
}

// ---- Checkout notices ----------------------------------------------------------------------------------

/** What the billing page shows for a checkout that did not start. The page picks it by error code, never by status range. */
export interface CheckoutNotice {
  kind: "already_active" | "already_past_due" | "already_unpaid" | "already_paused" | "already_incomplete" | "price_unavailable";
  headline: string;
  body: string;
  button: string;
  /** Adds the GitHub issues link under the button. */
  help: boolean;
  /** past_due and price_unavailable interrupt (alert); the active notice is polite (status). */
  role: "status" | "alert";
}

export const ACTIVE_NOTICE: CheckoutNotice = {
  kind: "already_active",
  headline: "You already have a plan",
  body: "Your subscription is active, so we did not start a new checkout and nothing was charged. Change your plan, seats or add-ons in Manage billing.",
  button: "Manage billing",
  help: false,
  role: "status",
};
export const PAST_DUE_NOTICE: CheckoutNotice = {
  kind: "already_past_due",
  headline: "Last payment failed",
  body: "We could not collect your last payment and will try again. Update your card in Manage billing to keep your plan. Nothing new was charged.",
  button: "Update payment method",
  help: false,
  role: "alert",
};
export const UNPAID_NOTICE: CheckoutNotice = {
  kind: "already_unpaid",
  headline: "Payment is overdue",
  body: "Paid access is off because we could not collect payment. Update your card in Manage billing to restore it. Nothing new was charged.",
  button: "Update payment method",
  help: false,
  role: "alert",
};
export const PAUSED_NOTICE: CheckoutNotice = {
  kind: "already_paused",
  headline: "Your plan is paused",
  body: "Your trial ended without a payment method. Add one in Manage billing to resume your plan. Nothing was charged.",
  button: "Add payment method",
  help: false,
  role: "alert",
};
export const INCOMPLETE_NOTICE: CheckoutNotice = {
  kind: "already_incomplete",
  headline: "Your first payment is not finished",
  body: "Your first payment is still pending or needs action. Finish it in Manage billing. We did not start a new checkout and nothing new was charged.",
  button: "Manage billing",
  help: false,
  role: "alert",
};
export const PRICE_UNAVAILABLE_NOTICE: CheckoutNotice = {
  kind: "price_unavailable",
  headline: "This plan is not available to buy",
  body: "Nothing was charged and your plan has not changed. Try a different plan or billing period.",
  button: "Choose another plan",
  help: true,
  role: "alert",
};
/** Shown in the 409 banner when opening the portal failed. The button then reads "Try again". */
export const PORTAL_FAILED_MESSAGE = "Could not open billing. Try again in a moment.";

/** Copy for each blocking status the checkout route can report. active and trialing share the active copy. */
const ALREADY_SUBSCRIBED_NOTICES = new Map<unknown, CheckoutNotice>([
  ["active", ACTIVE_NOTICE],
  ["trialing", ACTIVE_NOTICE],
  ["past_due", PAST_DUE_NOTICE],
  ["unpaid", UNPAID_NOTICE],
  ["paused", PAUSED_NOTICE],
  ["incomplete", INCOMPLETE_NOTICE],
]);

/**
 * The notice for a checkout answer, chosen by its error code. An already_subscribed answer uses the copy for the
 * status the server reports; a missing or unknown status uses the active copy. Null for any other answer.
 */
export function checkoutNotice(input: { code?: unknown; status?: unknown }): CheckoutNotice | null {
  if (input.code === "already_subscribed") return ALREADY_SUBSCRIBED_NOTICES.get(input.status) ?? ACTIVE_NOTICE;
  if (input.code === "price_not_configured") return PRICE_UNAVAILABLE_NOTICE;
  return null;
}
