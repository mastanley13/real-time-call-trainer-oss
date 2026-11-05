import { premiumUnits, premiumVoiceCap, type PlanTier } from "./usagePlan";

/**
 * Premium Voice add-on entitlement. Pure and client-safe: no database, no env.
 *
 * Stricter than the base plan (storedPlanEntitled): Premium needs a linked subscription in `active` or `trialing`
 * (no past_due grace), the add-on flag on, an add-on quantity above 0, and a stored current period end that has not
 * passed. Anything else (past_due, unpaid, canceled, incomplete, incomplete_expired, paused, a missing or past period
 * end) gives no Premium minutes, so the NEXT call mints Standard. A running call is never switched.
 *
 * A subscription set to cancel at period end stays `active` at Stripe until then, so Premium is honoured until its
 * current_period_end. A scheduled removal of the add-on works the same way: the item is still on the subscription
 * until the renewal phase drops it.
 *
 * Comped (Organization.voiceModelComped) is separate and overrides billing; see voiceTier.ts. Nothing here reads it.
 * Paid Premium at mint is also gated by PREMIUM_VOICE_ON_SALE (usage.ts ensureAllowance applies serverConfig.premiumOnSale
 * before calling premiumMinutesCapFor); this module stays pure and env-free.
 */

export const PREMIUM_STATUSES = ["active", "trialing"] as const;

export interface PremiumBillingRow {
  premiumVoice: boolean | null | undefined;
  premiumVoiceQuantity: number | null | undefined;
  subscriptionStatus: string | null | undefined;
  stripeSubscriptionId: string | null | undefined;
  subscriptionPeriodEnd: Date | null | undefined;
  /** Set by invoice.payment_failed; cleared only by invoice.paid for that invoice. Any value blocks Premium. */
  premiumSuspendedAt?: Date | null;
}

/** Why a row has no Premium right now, or null when it does. */
export type PremiumBlock = "no_addon" | "status" | "expired" | "no_subscription" | "suspended";

export function premiumBlock(row: PremiumBillingRow, now: Date): PremiumBlock | null {
  if (!row.premiumVoice || !((row.premiumVoiceQuantity ?? 0) > 0)) return "no_addon";
  if (!row.stripeSubscriptionId) return "no_subscription";
  // A failed payment suspends Premium until that invoice is paid, whatever later updates report.
  if (row.premiumSuspendedAt) return "suspended";
  if (!(PREMIUM_STATUSES as readonly string[]).includes(row.subscriptionStatus ?? "")) return "status";
  const end = row.subscriptionPeriodEnd;
  if (!end || !(end.getTime() > now.getTime())) return "expired";
  return null;
}

export const premiumEntitled = (row: PremiumBillingRow, now: Date): boolean => premiumBlock(row, now) === null;

/**
 * Premium minutes this period for a billing subject: 40 per unit when entitled, else 0. `plan` must already be the
 * plan in effect (a Free plan gets 0 whatever the row says). `seats` is the Team seat count.
 */
export function premiumMinutesCapFor(plan: PlanTier, row: PremiumBillingRow, now: Date, seats = 1, planCap?: number): number {
  if (plan === "free" || !premiumEntitled(row, now)) return 0;
  return premiumVoiceCap(premiumUnits(plan, row.premiumVoiceQuantity ?? 0, seats), planCap);
}

/** Whole Premium minutes still free for a new call: cap less used and less what open calls hold. Never negative. */
export function premiumMinutesLeft(a: { premiumMinutesCap: number; premiumMinutesUsed: number; premiumMinutesReserved: number }): number {
  return Math.max(0, Math.floor(a.premiumMinutesCap - a.premiumMinutesUsed - a.premiumMinutesReserved));
}
