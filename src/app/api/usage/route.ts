import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { meteringEnabled } from "@/lib/serverConfig";
import { stripeStatus } from "@/lib/stripe";
import { usageSummary } from "@/lib/usage";

/**
 * Voice minutes for the signed-in user, read from the allowance and the ledger, plus what the billing
 * panel needs to know. `metered: false` in demo mode and without a database.
 */
export async function GET(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!meteringEnabled()) return NextResponse.json({ metered: false, billing: { enabled: false } });

  const [summary, user] = await Promise.all([
    usageSummary(auth.id),
    prisma.user.findUnique({ where: { id: auth.id }, include: { organization: true } }),
  ]);
  if (!summary || !user) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const manages = user.role === "owner" || user.role === "manager";
  return NextResponse.json({
    metered: true,
    ...summary,
    billing: {
      enabled: stripeStatus() === "ready",
      canBuyTeam: manages && !!user.organization,
      hasPortal: !!((manages && user.organization?.stripeCustomerId) || user.stripeCustomerId),
      seats: summary.pooled ? user.organization?.seatCount ?? 1 : 1,
      status: (summary.pooled ? user.organization?.subscriptionStatus : user.subscriptionStatus) ?? null,
    },
  });
}
