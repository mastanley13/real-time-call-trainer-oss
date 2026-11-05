import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { meteringEnabled, premiumOnSale } from "@/lib/serverConfig";
import { VOICE_UNAVAILABLE_MESSAGE } from "@/lib/billingUi";
import { stripeReady, stripeTestMode } from "@/lib/stripe";
import { usageSummary } from "@/lib/usage";
import { hasGradedCall } from "@/lib/premiumOffer";
import { effectiveVoiceTier } from "@/lib/voiceTier";

/**
 * Voice minutes for the signed-in user, read from the allowance and the ledger, plus what the billing
 * panel needs to know. `metered: false` in demo mode and without a database; Stripe is not required.
 * Without a Stripe key it reports plan free and `billing.enabled: false`.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!meteringEnabled()) return NextResponse.json({ metered: false, billing: { enabled: false } });

  // A failed lookup is a 503, not a guess: the briefing then blocks voice and keeps text open.
  const loaded = await Promise.all([
    usageSummary(auth.id),
    prisma.user.findUnique({ where: { id: auth.id }, include: { organization: true } }),
    // Spec 10.2: Premium is never offered before the organization's first graded call (server-side, stored sessions).
    hasGradedCall(auth.id),
  ]).catch((e) => {
    console.error("[usage] lookup failed", e instanceof Error ? e.name : "unknown");
    return null;
  });
  if (!loaded) return NextResponse.json({ error: "usage_unavailable", message: VOICE_UNAVAILABLE_MESSAGE }, { status: 503 });
  const [summary, user, graded] = loaded;
  if (!summary || !user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const manages = user.role === "owner" || user.role === "manager";
  const subjectRow = summary.pooled ? user.organization : user;
  // Who may change the add-on on this billing subject: the Pro subscriber, or the Team owner.
  const canManage = summary.pooled ? user.role === "owner" : true;
  // Premium is not part of a Stripe trial (Triage B2): nothing to buy until the plan is active.
  const trialing = subjectRow?.subscriptionStatus === "trialing";
  return NextResponse.json({
    metered: true,
    ...summary,
    premiumVoice: {
      ...summary.premiumVoice,
      // Buy controls show only while Premium is on sale. A Team member who is not the owner is sent to their admin.
      onSale: premiumOnSale(),
      // May buy now: the right person, the organization's first graded call done, and not in a Stripe trial.
      canBuy: canManage && graded && !trialing,
      // May remove it or change seats: never gated by the graded call (spec 10.2 gates the offer only).
      canManage,
      // Allowlisted boolean: whether Premium may be offered at all yet. No counts, no session data.
      offerReady: graded,
      // Comped AND set to Premium (the same rule the mint uses), so the setup can offer Standard or Premium. A boolean only.
      comped: effectiveVoiceTier(user.organization?.voiceModelTier, user.organization?.voiceModelComped) === "premium",
      removeAt: subjectRow?.premiumVoiceRemoveAt?.toISOString() ?? null,
    },
    billing: {
      enabled: stripeReady(),
      testMode: stripeTestMode(),
      canBuyTeam: manages && !!user.organization,
      // A member of a Team pool who is not an owner or manager has nothing to upgrade: the admin buys the minutes.
      canUpgrade: !(summary.pooled && !manages),
      hasPortal: !!((manages && user.organization?.stripeCustomerId) || user.stripeCustomerId),
      seats: summary.pooled ? user.organization?.seatCount ?? 1 : 1,
      /** Seats the Team drops to at renewal, when a decrease is scheduled. */
      seatsAtRenewal: summary.pooled ? user.organization?.seatCountAtRenewal ?? null : null,
      /** A paid subscription the app can change in place (Premium add, removal, seats). */
      hasSubscription: !!subjectRow?.stripeSubscriptionId && (summary.plan === "pro" || summary.plan === "team"),
      renewsAt: subjectRow?.subscriptionPeriodEnd?.toISOString() ?? null,
      status: (summary.pooled ? user.organization?.subscriptionStatus : user.subscriptionStatus) ?? null,
    },
  });
}
