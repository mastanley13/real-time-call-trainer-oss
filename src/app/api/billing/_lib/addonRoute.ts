import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { AddonError, type AddonErrorCode, type AddonSubject } from "@/lib/premiumAddon";
import { StripeApiError } from "@/lib/stripe";
import { CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/billingUi";

/**
 * Who may change Premium voice or seats on an existing subscription, read from the database (never the token or body):
 * - a Team organization: only its owner;
 * - a Pro subscription: only the user who holds it.
 * Anyone else gets 403 (a Team member is told to ask their admin) or 409 when there is no paid subscription to change.
 */
export async function addonSubjectFor(userId: string): Promise<{ subject: AddonSubject } | { response: NextResponse }> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { organization: true } });
  if (!user) return { response: NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 }) };
  const org = user.organization;
  if (org && org.planTier === "team" && org.stripeSubscriptionId) {
    if (user.role !== "owner") {
      return { response: NextResponse.json({ error: "forbidden", message: "Only your team owner can change Premium voice or seats. Ask your admin." }, { status: 403 }) };
    }
    return { subject: { kind: "organization", id: org.id, plan: "team", subscriptionId: org.stripeSubscriptionId, seats: org.seatCount } };
  }
  if (user.planTier === "pro" && user.stripeSubscriptionId) {
    return { subject: { kind: "user", id: user.id, plan: "pro", subscriptionId: user.stripeSubscriptionId, seats: 1 } };
  }
  return { response: NextResponse.json({ error: "no_subscription", message: "Premium voice is added to a Pro or Team plan. Choose a plan first." }, { status: 409 }) };
}

/** Audit row for a billing change made in the app. Ids and counts only; no Stripe ids, no amounts from Stripe bodies. */
export async function auditBilling(actorId: string, subject: AddonSubject, action: string, metadata: Record<string, string | number | null>): Promise<void> {
  await prisma.auditEvent.create({ data: { userId: actorId, action, resource: `${subject.kind}:${subject.id}`, metadata } });
}

const STATUS: Record<AddonErrorCode, number> = {
  already_added: 409,
  not_added: 409,
  change_scheduled: 409,
  subscription_changed: 409,
  price_changed: 409,
  unsupported_billing_terms: 409,
  // An earlier scheduled change for this plan is still being set up; the next attempt resumes it.
  change_pending: 409,
  // Stripe did not complete the schedule setup; the app released its own schedule, so nothing changed.
  schedule_setup_failed: 502,
  not_in_good_standing: 409,
  invalid_token: 400,
  invalid_seats: 400,
  no_change: 400,
  not_team: 400,
  price_not_configured: 422,
  token_not_configured: 503,
};

/** Maps a failure to the app's error shape. Stripe bodies are never forwarded or logged; only the status code is. */
export function addonFailure(e: unknown, scope: string): NextResponse {
  if (e instanceof AddonError) return NextResponse.json({ error: e.code, message: e.message }, { status: STATUS[e.code] });
  if (e instanceof StripeApiError) {
    console.error(`[${scope}] stripe status`, e.status);
    if (e.status === 402) {
      return NextResponse.json({ error: "payment_failed", message: "Your card was declined, so nothing changed. Update your card in Manage billing, then try again." }, { status: 402 });
    }
    return NextResponse.json({ error: "stripe_error", message: CHECKOUT_UNAVAILABLE_MESSAGE }, { status: 502 });
  }
  console.error(`[${scope}]`, e instanceof Error ? e.name : "unexpected error");
  return NextResponse.json({ error: "stripe_error", message: CHECKOUT_UNAVAILABLE_MESSAGE }, { status: 502 });
}
