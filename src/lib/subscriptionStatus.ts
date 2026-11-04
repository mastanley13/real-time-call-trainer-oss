/**
 * The one place that decides what a Stripe subscription status means for this app. Pure and client-safe.
 * Meanings follow https://docs.stripe.com/billing/subscriptions/overview#subscription-statuses.
 *
 * - active, trialing: in good standing, paid access.
 * - past_due: the latest renewal failed and Stripe is retrying. Access continues only for a grace window.
 * - unpaid: retries are exhausted and invoices stay open. No access.
 * - paused: the trial ended with no payment method. No access.
 * - incomplete: the first payment failed or needs action. No access yet.
 * - incomplete_expired, canceled: terminal. No access.
 */

export const DEFAULT_PAST_DUE_GRACE_DAYS = 7;

/** Reads a grace length in days. Anything that is not a whole number from 0 to 365 falls back to 7. */
export function parseGraceDays(raw: string | null | undefined): number {
  const text = raw?.trim();
  if (!text || !/^\d{1,3}$/.test(text)) return DEFAULT_PAST_DUE_GRACE_DAYS;
  const days = Number(text);
  return days <= 365 ? days : DEFAULT_PAST_DUE_GRACE_DAYS;
}

/** Days a past_due account keeps paid access, counted from when it first entered past_due. Env: PAST_DUE_GRACE_DAYS. */
export const PAST_DUE_GRACE_DAYS = parseGraceDays(process.env.PAST_DUE_GRACE_DAYS);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Statuses that block a new checkout while a subscription is linked. */
export const CHECKOUT_BLOCKING_STATUSES = ["active", "trialing", "past_due", "unpaid", "paused", "incomplete"] as const;
export type CheckoutBlockingStatus = (typeof CHECKOUT_BLOCKING_STATUSES)[number];

export function blocksCheckout(status: string | null | undefined): status is CheckoutBlockingStatus {
  return !!status && (CHECKOUT_BLOCKING_STATUSES as readonly string[]).includes(status);
}

/** True while a past_due account is inside its grace window. A missing start counts as starting now. */
export function inPastDueGrace(pastDueSince: Date | null | undefined, now: Date, graceDays = PAST_DUE_GRACE_DAYS): boolean {
  if (!pastDueSince) return true;
  return now.getTime() - pastDueSince.getTime() < graceDays * DAY_MS;
}

/** Whether a subscription in this status grants paid plan access at `now`. Unknown statuses are not entitled. */
export function isEntitled(status: string | null | undefined, pastDueSince: Date | null | undefined, now: Date, graceDays = PAST_DUE_GRACE_DAYS): boolean {
  if (status === "active" || status === "trialing") return true;
  if (status === "past_due") return inPastDueGrace(pastDueSince, now, graceDays);
  return false;
}

/**
 * The pastDueSince to store after a status update: kept while past_due stays past_due, set to `now` when the
 * account first enters it (or when it was past_due with no start recorded), and cleared for any other status.
 */
export function nextPastDueSince(status: string | null | undefined, existing: Date | null | undefined, now: Date): Date | null {
  return status === "past_due" ? (existing ?? now) : null;
}

/**
 * Whether a stored plan row still grants paid access. The only row that keeps its plan tier without a status is one
 * with no Stripe subscription at all (a comped or seeded account an admin set by hand). Anything linked to a
 * subscription goes through isEntitled, so a linked row with a missing status is not entitled.
 */
export function storedPlanEntitled(
  row: { subscriptionStatus: string | null; stripeSubscriptionId: string | null; pastDueSince?: Date | null },
  now: Date,
): boolean {
  if (row.subscriptionStatus == null && !row.stripeSubscriptionId) return true;
  return isEntitled(row.subscriptionStatus, row.pastDueSince, now);
}
