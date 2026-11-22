import "server-only";
import { after } from "next/server";
import type { PlanTier } from "./usagePlan";
import type { PremiumEvent } from "./premiumEventTypes";

/**
 * Billing lifecycle hook for the CRM (GoHighLevel). Off unless GHL_BILLING_EVENTS=true and a sink is registered.
 * billing.ts registers ghlBillingSink from ghlWebhook.ts, which posts each event to the GHL Inbound Webhook URL
 * (GHL_WEBHOOK_URL). Only Calltrainer subscriptions reach this hook (metadata app=calltrainer, or plan items billing's own
 * price and product rules classify as Calltrainer plans; see lifecycleEventFor in billing.ts). The event here
 * carries ids and plans only; the GHL sink adds the contact email from the database at send time. Never Stripe
 * customer ids, raw Stripe objects or card data.
 */

export type BillingLifecycleKind = "upgrade" | "downgrade" | "churn";

/** A plan change as billing.ts applies it, before it is tied to the Stripe event that caused it. */
export interface PlanChange {
  kind: BillingLifecycleKind;
  subject: "user" | "organization";
  subjectId: string;
  fromPlan: PlanTier;
  toPlan: PlanTier;
  seats: number;
  premiumVoice: boolean;
  /**
   * Names this one transition: a random UUID made inside the transaction that applies it (newTransitionId in billing.ts).
   * Only that transaction's path emits the transition, once, after commit, so the value is unique per transition.
   */
  transition: string;
  /**
   * True when billing's own rules made this change from a Calltrainer plan: reconcile classified the subscription's items
   * as a Calltrainer plan (env price allowlist or product ct_* metadata), or the subject held a paid plan on this very
   * subscription, which only such items grant. Absent or false otherwise. See lifecycleEventFor in billing.ts.
   */
  calltrainerPlan?: boolean;
}

export interface BillingLifecycleEvent extends PlanChange {
  /**
   * Subscription reference, the same on the success-page and webhook paths: subscription:{sha256 digest of the subscription id}.
   * Only when no subscription id is known: checkout_session:{id} or the Stripe event id. See lifecycleRef in billing.ts.
   */
  stripeRef: string;
  /** The user who started the checkout, from Calltrainer's own subscription metadata. Null when absent. */
  purchaserUserId: string | null;
}

/**
 * Calltrainer's own checkout puts app=calltrainer on the subscription. It is one of the two signals lifecycleEventFor
 * accepts; the other is calltrainerPlan on the change. A subscription with neither is never forwarded.
 */
export function isCalltrainerStripe(metadata: Record<string, string> | null | undefined): boolean {
  return metadata?.app === "calltrainer";
}

export type BillingEventSink = (event: BillingLifecycleEvent) => void | Promise<void>;

let sink: BillingEventSink | null = null;

export function setBillingEventSink(next: BillingEventSink | null): void {
  sink = next;
}

export function billingEventsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.GHL_BILLING_EVENTS === "true";
}

const RANK: Record<PlanTier, number> = { free: 0, pro: 1, team: 2 };

/** Free to paid or Pro to Team is an upgrade, Team to Pro a downgrade, any paid plan to Free is churn. Same plan emits nothing. */
export function classifyPlanChange(from: PlanTier, to: PlanTier): BillingLifecycleKind | null {
  if (from === to) return null;
  if (to === "free") return "churn";
  return RANK[to] > RANK[from] ? "upgrade" : "downgrade";
}

/** Fire and forget: a CRM failure must never fail a billing webhook. */
export async function emitBillingLifecycle(event: BillingLifecycleEvent): Promise<void> {
  if (!billingEventsEnabled() || !sink) return;
  try {
    await sink(event);
  } catch {
    console.error("[billing-events] sink failed for", event.kind);
  }
}

// ---- Premium Voice events --------------------------------------------------------------------------------
// Same seam, its own sink. billing.ts registers ghlPremiumSink (src/lib/ghlWebhook.ts), which forwards only voice_cap_hit
// to the GHL emitter and sends nothing unless GHL events are on; no other telemetry is set up here. Payloads carry ids,
// plan, units and reasons only, never email, card data, Stripe ids or model ids. The names match the spec:
// premium_upsell_viewed {surface} comes from the browser (src/lib/premiumEventTypes.ts); the rest are server-side.

export type { PremiumEventName, PremiumEvent } from "./premiumEventTypes";

export type PremiumEventSink = (event: PremiumEvent) => void | Promise<void>;

let premiumSink: PremiumEventSink | null = null;

export function setPremiumEventSink(next: PremiumEventSink | null): void {
  premiumSink = next;
}

/** Fire and forget: a sink failure never fails a mint, a webhook or a billing change. */
export async function emitPremiumEvent(event: PremiumEvent): Promise<void> {
  if (!premiumSink) return;
  try {
    await premiumSink(event);
  } catch {
    console.error("[billing-events] premium sink failed for", event.name);
  }
}

/**
 * Schedules a premium event without waiting for the sink, for request paths whose answer must not wait on it
 * (the 402 at a refused voice start, the heartbeat stop). Call it from a route handler: next/server after() runs the
 * sink once the response is sent and keeps the work alive for the request's lifetime, so neither slow sink work
 * (synchronous or not) nor a sink that throws can delay or change the response. Outside a request scope (tests,
 * scripts) after() throws, and the event runs on a later macrotask instead, still after the caller returns.
 */
export function queuePremiumEvent(event: PremiumEvent): void {
  if (!premiumSink) return;
  const task = () => emitPremiumEvent(event).catch(() => {});
  try {
    after(task);
  } catch {
    setImmediate(() => void task());
  }
}
