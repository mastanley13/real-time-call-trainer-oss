import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { billingGate, StripeApiError } from "@/lib/stripe";
import { appBaseUrl, buildCheckoutParams, checkoutFingerprint, createOrReuseCheckout, CheckoutConfigError, blocksCheckout, resolvePriceIds } from "@/lib/billing";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/usagePlan";
import { CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/billingUi";
import { PREMIUM_COMING_SOON, PREMIUM_VOICE_ON_SALE } from "@/lib/pricing";

const Body = z.object({
  plan: z.enum(["pro", "team"]),
  interval: z.enum(["month", "year"]),
  /** Team only. Pro is always one seat. */
  seats: z.number().int().min(TEAM_MIN_SEATS).max(TEAM_MAX_SEATS).optional(),
  /** Premium Voice add-on; its quantity equals the seats. */
  premium: z.boolean().default(false),
});

/** Starts a Stripe Checkout Session (mode=subscription, test mode only) for Pro or Team, with the optional Premium Voice add-on. */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;

  const ipLimited = ipLimitResponse(req, "billing");
  if (ipLimited) return ipLimited;
  const userLimited = userLimitResponse(auth.id, "billing");
  if (userLimited) return userLimited;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch (e) {
    const seatsIssue = e instanceof z.ZodError && e.issues.some((i) => i.path[0] === "seats");
    return NextResponse.json(
      { error: "invalid_request", message: seatsIssue ? `Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.` : "Choose a plan and a billing period." },
      { status: 400 },
    );
  }
  // Premium is off sale. This answers before the billing check so a hand-crafted POST gets the same 400 in both states.
  if (body.premium && !PREMIUM_VOICE_ON_SALE) {
    return NextResponse.json({ error: "premium_not_available", message: PREMIUM_COMING_SOON }, { status: 400 });
  }
  const gate = billingGate();
  if (gate) return gate;
  if (body.plan === "team" && body.seats === undefined) {
    return NextResponse.json({ error: "invalid_request", message: `Team needs at least ${TEAM_MIN_SEATS} seats.` }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { id: auth.id }, include: { organization: true } });
  if (!user) return NextResponse.json({ error: "not_found", message: "Account not found." }, { status: 404 });
  const org = user.organization;

  // Only an owner or manager can buy seats for the organization.
  if (body.plan === "team" && (!org || (user.role !== "owner" && user.role !== "manager"))) {
    return NextResponse.json({ error: "forbidden", message: "Only an organization owner or manager can buy a Team plan." }, { status: 403 });
  }
  const subject = body.plan === "team" && org ? org : user;
  // A linked subscription in an active, trialing, past_due, unpaid or paused state blocks a second one, even
  // when its items left the account on Free. Only canceled or incomplete_expired subscriptions may check out again.
  if (subject.stripeSubscriptionId && blocksCheckout(subject.subscriptionStatus)) {
    // Plain status only: past_due is told apart so the page can ask for a new card; everything else reads as active.
    const status = subject.subscriptionStatus === "past_due" ? "past_due" : "active";
    return NextResponse.json({ error: "already_subscribed", status, message: "This account already has a paid plan. Use Manage billing to change it." }, { status: 409 });
  }

  try {
    const prices = await resolvePriceIds();
    const params = buildCheckoutParams({
      plan: body.plan,
      interval: body.interval,
      seats: body.seats ?? 1,
      premium: body.premium,
      userId: user.id,
      organizationId: body.plan === "team" ? org?.id : undefined,
      email: user.email,
      customerId: subject.stripeCustomerId,
      anchorAt: body.plan === "team" && org ? org.createdAt : user.usageAnchorAt,
      baseUrl: appBaseUrl(req),
    }, prices);
    // One outstanding Checkout Session per billing subject: a repeat click reuses it, a different plan replaces it.
    const outcome = await createOrReuseCheckout({
      subject: { kind: subject === org ? "organization" : "user", id: subject.id },
      fingerprint: checkoutFingerprint({ plan: body.plan, interval: body.interval, seats: body.seats ?? 1, premium: body.premium }),
      params,
    });
    if (!outcome.ok && outcome.error === "checkout_completed") {
      return NextResponse.json({ error: "checkout_completed", message: "Your earlier checkout just finished. Reload the page to see your plan before choosing another." }, { status: 409 });
    }
    if (!outcome.ok) {
      return NextResponse.json({ error: "checkout_in_progress", message: "Another checkout for this account is being set up. Wait a moment, then try again." }, { status: 409 });
    }
    return NextResponse.json({ url: outcome.url });
  } catch (e) {
    if (e instanceof CheckoutConfigError) {
      return NextResponse.json({ error: e.code, message: e.message }, { status: e.code === "invalid_seats" ? 400 : 422 });
    }
    console.error("[billing/checkout]", e instanceof StripeApiError ? `stripe status ${e.status}` : "unexpected error");
    return NextResponse.json({ error: "stripe_error", message: CHECKOUT_UNAVAILABLE_MESSAGE }, { status: 502 });
  }
}
