import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { billingGate, stripeApi, StripeApiError } from "@/lib/stripe";
import { appBaseUrl } from "@/lib/billing";

/**
 * Opens the Stripe Billing Portal (plan and seat changes, cancel, payment method). A Team owner or
 * manager gets the organization's customer; everyone else gets their own.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const gate = billingGate();
  if (gate) return gate;
  const ipLimited = ipLimitResponse(req, "billing");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "billing");
  if (userLimited) return userLimited;

  const user = await prisma.user.findUnique({ where: { id: auth.id }, include: { organization: true } });
  if (!user) return NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 });
  const manages = user.role === "owner" || user.role === "manager";
  const customer = (manages && user.organization?.stripeCustomerId) || user.stripeCustomerId;
  if (!customer) {
    return NextResponse.json({ error: "no_billing_account", message: "There is no paid plan to manage yet. Pick a plan first." }, { status: 404 });
  }

  try {
    const session = await stripeApi.createPortalSession({ customer, return_url: `${appBaseUrl(req)}/settings/billing` });
    return NextResponse.json({ url: session.url });
  } catch (e) {
    console.error("[billing/portal]", e instanceof StripeApiError ? `stripe status ${e.status}` : "unexpected error");
    return NextResponse.json({ error: "stripe_error", message: "Could not open billing. Try again in a moment." }, { status: 502 });
  }
}
