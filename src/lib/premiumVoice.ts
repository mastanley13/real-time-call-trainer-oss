import { premiumUnits, premiumVoiceCap, type PlanTier } from "./usagePlan";

/**
 * Premium Voice add-on entitlement. Pure and client-safe: no database, no env.
 *
 * Stricter than the base plan (storedPlanEntitled): Premium needs a linked subscription that is `active` (no past_due
 * grace, and NOT during a Stripe `trialing` period: paid Premium is not part of a trial; Triage B2 and the accepted
 * criterion of Nov 5 2026, superseding draft section 7's "active or trialing"), the add-on flag on, an add-on quantity
 * above 0, and a stored current period end that has not passed. Anything else (trialing, past_due, unpaid, canceled,
 * incomplete, incomplete_expired, paused, a missing or past period end) gives no Premium minutes, so the NEXT call
 * mints Standard. A running call is never switched. The base plan's own trialing access is unchanged
 * (subscriptionStatus.ts), and the separate one-call Free organization trial (premiumTrial.ts) is not affected.
 *
 * A subscription set to cancel at period end stays `active` at Stripe until then, so Premium is honoured until its
 * current_period_end. A scheduled removal of the add-on works the same way: the item is still on the subscription
 * until the renewal phase drops it.
 *
 * Comped (Organization.voiceModelComped) is separate and overrides billing; see voiceTier.ts. Nothing here reads it.
 * Paid Premium at mint is also gated by PREMIUM_VOICE_ON_SALE (usage.ts ensureAllowance applies serverConfig.premiumOnSale
 * before calling premiumMinutesCapFor); this module stays pure and env-free.
 */

/** Subscription statuses that run paid Premium: `active` only. */
export const PREMIUM_STATUSES = ["active"] as const;

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

/**
 * The seat count Team Premium units are taken against: normally the seats (units = min(add-on quantity, seats)). While
 * a seat decrease is pending for renewal (`seatCountAtRenewal` set; cleared at the renewal), the Team keeps what it
 * paid for this period: the add-on quantity, which a portal decrease leaves in place until the renewal schedule lowers
 * it (spec section 7 line 65: "Removed seats lower qty at renewal"). Never more than the add-on quantity, and the plan's
 * own minutes still cap the pool (premiumVoiceCap), so a pending decrease cannot inflate anything.
 */
export function premiumSeatsForUnits(seatCount: number, seatCountAtRenewal: number | null | undefined, addonQuantity: number | null | undefined): number {
  if (seatCountAtRenewal == null) return seatCount;
  return Math.max(seatCount, Math.max(0, addonQuantity ?? 0));
}

/** Whole Premium minutes still free for a new call: cap less used and less what open calls hold. Never negative. */
export function premiumMinutesLeft(a: { premiumMinutesCap: number; premiumMinutesUsed: number; premiumMinutesReserved: number }): number {
  return Math.max(0, Math.floor(a.premiumMinutesCap - a.premiumMinutesUsed - a.premiumMinutesReserved));
}
