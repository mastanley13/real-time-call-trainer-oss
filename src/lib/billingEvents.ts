import "server-only";
import type { PlanTier } from "./usagePlan";
import type { PremiumEvent } from "./premiumEventTypes";

/**
 * Billing lifecycle hook for the CRM (GoHighLevel). The GHL emitter from STR-714 is not on this branch,
 * so this is a typed seam with a registered sink. Off unless GHL_BILLING_EVENTS=true.
 *
 * TODO(STR-714): when src/lib/ghl lands, register its emitter with setBillingEventSink() and reuse its
 * feature flag in place of GHL_BILLING_EVENTS. Payloads carry ids and plans only, never email or card data.
 */

export type BillingLifecycleKind = "upgrade" | "downgrade" | "churn";

export interface BillingLifecycleEvent {
  kind: BillingLifecycleKind;
  subject: "user" | "organization";
  subjectId: string;
  fromPlan: PlanTier;
  toPlan: PlanTier;
  seats: number;
  premiumVoice: boolean;
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
// Same seam, its own sink. Nothing is registered by default and no external telemetry is set up here: a deployment
// that wants these registers a sink (for example the GHL emitter) with setPremiumEventSink(). Payloads carry ids,
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
