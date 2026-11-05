import "server-only";
import type { PlanTier } from "./usagePlan";

/**
 * Billing lifecycle hook for the CRM (GoHighLevel). Off unless GHL_BILLING_EVENTS=true and a sink is registered.
 * billing.ts registers ghlBillingSink from ghlWebhook.ts, which posts each event to the GHL Inbound Webhook URL
 * (GHL_WEBHOOK_URL). Only Calltrainer subscriptions (Stripe metadata app=calltrainer) reach this hook. The event here
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
}

export interface BillingLifecycleEvent extends PlanChange {
  /** The Stripe event id (evt_...), or checkout_session:{id} when a paid checkout was applied without its webhook. Used for dedupe. */
  stripeRef: string;
  /** The user who started the checkout, from Calltrainer's own subscription metadata. Null when absent. */
  purchaserUserId: string | null;
}

/** Only subscriptions Calltrainer's own checkout created carry app=calltrainer. Nothing else on a shared Stripe account is forwarded. */
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
