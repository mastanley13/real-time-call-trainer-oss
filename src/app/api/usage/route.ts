import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { meteringEnabled } from "@/lib/serverConfig";
import { VOICE_UNAVAILABLE_MESSAGE } from "@/lib/billingUi";
import { stripeStatus, stripeTestMode } from "@/lib/stripe";
import { usageSummary } from "@/lib/usage";

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
  ]).catch((e) => {
    console.error("[usage] lookup failed", e instanceof Error ? e.name : "unknown");
    return null;
  });
  if (!loaded) return NextResponse.json({ error: "usage_unavailable", message: VOICE_UNAVAILABLE_MESSAGE }, { status: 503 });
  const [summary, user] = loaded;
  if (!summary || !user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const manages = user.role === "owner" || user.role === "manager";
  return NextResponse.json({
    metered: true,
    ...summary,
    billing: {
      enabled: stripeStatus() === "ready",
      testMode: stripeTestMode(),
      canBuyTeam: manages && !!user.organization,
      // A member of a Team pool who is not an owner or manager has nothing to upgrade: the admin buys the minutes.
      canUpgrade: !(summary.pooled && !manages),
      hasPortal: !!((manages && user.organization?.stripeCustomerId) || user.stripeCustomerId),
      seats: summary.pooled ? user.organization?.seatCount ?? 1 : 1,
      status: (summary.pooled ? user.organization?.subscriptionStatus : user.subscriptionStatus) ?? null,
    },
  });
}
