/**
 * One Premium voice trial call per Free organization (the "five-minute sample"). Pure and client-safe: no env reads
 * beyond the explicit `env` argument, no model ids, no database. The atomic claim lives in src/lib/usage.ts beginCall.
 *
 * Feature gate: PREMIUM_TRIAL_SAMPLE_ON, exactly "true". Default off (unset, empty or any other value). It is
 * independent of PREMIUM_VOICE_ON_SALE: either may be on while the other is off. Paid Premium still needs the sale flag;
 * the trial needs only this one. Demo mode never offers it (there is no organization row to claim on).
 *
 * Who gets it (decided on the server from database rows, never from the client), a "free-trial organization":
 * - the caller belongs to an organization that exists (an org-less account gets no trial; metered voice already
 *   requires an organization, so this only documents the conservative rule);
 * - the call resolves to the Free plan on the caller's own allowance (not a Team pool, not an entitled Pro or Team
 *   subscription, including a Stripe `trialing` one: those resolve to Pro or Team and never reach Free);
 * - neither the organization nor the caller is linked to a Stripe subscription (stripeSubscriptionId null) or has the
 *   Premium Voice add-on flag set, and the organization's stored plan is Free: a lapsed or past-due paid account is
 *   not a trial account;
 * - neither the organization nor the caller has any Stripe billing history: no stripeCustomerId and no
 *   subscriptionStatus. Both survive a cancel (applyEntitlement in billing.ts keeps the customer id and writes status
 *   "canceled" when it unlinks the subscription and drops the plan to Free), so a formerly paid account now on Free is
 *   not a trial account. This also excludes an account whose only checkout never finished paying (incomplete,
 *   incomplete_expired): it fails closed, never open;
 * - the organization is not comped (voiceModelComped is not true): comped orgs have their own Premium arrangement;
 * - the organization has not claimed its trial call yet (premiumTrialCallUsedAt null). The claim is permanent.
 *
 * Deadline: min(the call's existing deadline, 300 seconds). A lower existing deadline wins. When the trial limit is the
 * one that ends the call, it ends through the normal "maximum call length" path (reason max_duration), never a quota
 * error. Minutes come from the plan's ordinary allowance; the paid Premium minutes are never reserved or used.
 */

export const PREMIUM_TRIAL_SAMPLE_ENV = "PREMIUM_TRIAL_SAMPLE_ON";

/** The longest a trial call may run. */
export const TRIAL_SAMPLE_SECONDS = 300;

/** Exactly "true" turns the trial on. Anything else, including unset, is off. */
export const isTrialSampleOn = (env: Record<string, string | undefined>): boolean => env[PREMIUM_TRIAL_SAMPLE_ENV] === "true";

/** The trial call's deadline: the existing deadline, capped at TRIAL_SAMPLE_SECONDS. Never negative. */
export const trialMaxSeconds = (existingSeconds: number): number => Math.max(0, Math.min(existingSeconds, TRIAL_SAMPLE_SECONDS));

/** True when the trial cap, not the existing deadline, is what ends the call. Then the end is a normal max_duration. */
export const trialDeadlineBinds = (existingSeconds: number): boolean => existingSeconds > TRIAL_SAMPLE_SECONDS;

export interface TrialOrgRow {
  planTier: string | null;
  stripeSubscriptionId: string | null;
  /** Kept after a cancel: set once the organization ever became a Stripe customer. */
  stripeCustomerId: string | null;
  /** Kept after a cancel ("canceled"): set once the organization ever had a Stripe subscription. */
  subscriptionStatus: string | null;
  premiumVoice: boolean | null;
  voiceModelComped: boolean | null;
  premiumTrialCallUsedAt: Date | null;
}

export interface TrialUserRow {
  stripeSubscriptionId: string | null;
  stripeCustomerId: string | null;
  subscriptionStatus: string | null;
  premiumVoice: boolean | null;
}

/**
 * Whether this mint may try to claim the organization's trial call. A true answer is not the claim itself: the
 * caller still has to win the conditional update on Organization.premiumTrialCallUsedAt.
 */
export function trialSampleEligible(input: {
  flagOn: boolean;
  plan: string;
  pooled: boolean;
  comped: boolean;
  org: TrialOrgRow | null;
  user: TrialUserRow | null;
}): boolean {
  const { flagOn, plan, pooled, comped, org, user } = input;
  if (!flagOn || comped || pooled || plan !== "free" || !org || !user) return false;
  if (org.voiceModelComped === true) return false;
  if ((org.planTier ?? "free") !== "free" || org.stripeSubscriptionId || org.premiumVoice) return false;
  if (user.stripeSubscriptionId || user.premiumVoice) return false;
  // Ever paid (or ever subscribed): the Stripe customer id and the last subscription status outlive a cancel.
  if (org.stripeCustomerId || org.subscriptionStatus || user.stripeCustomerId || user.subscriptionStatus) return false;
  return org.premiumTrialCallUsedAt == null;
}
