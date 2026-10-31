import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { ensureAllowance } from "./usage";
import { emitBillingLifecycle, classifyPlanChange, type BillingLifecycleEvent } from "./billingEvents";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS, isPlanTier, nextAnchorUnix, type PlanTier } from "./usagePlan";
import type { StripeParams } from "./stripe";

/**
 * Checkout parameters and webhook handling. Stripe is the billing source of truth; this module mirrors
 * its plan, seats, premium flag and status onto the user or organization and re-derives the voice cap.
 * No overages and no metered prices exist: every line item is a flat licensed price.
 */

export type Interval = "month" | "year";
export type PaidPlan = Exclude<PlanTier, "free">;

// ---- Prices (env var names only; the ids themselves live in the server environment) -------------

export interface PriceIds {
  pro: Record<Interval, string | undefined>;
  team: Record<Interval, string | undefined>;
  premium: Record<Interval, string | undefined>;
}

export function priceIds(env: Record<string, string | undefined> = process.env): PriceIds {
  const get = (n: string) => env[n]?.trim() || undefined;
  return {
    pro: { month: get("STRIPE_PRICE_PRO_MONTHLY"), year: get("STRIPE_PRICE_PRO_ANNUAL") },
    team: { month: get("STRIPE_PRICE_TEAM_MONTHLY"), year: get("STRIPE_PRICE_TEAM_ANNUAL") },
    premium: { month: get("STRIPE_PRICE_PREMIUM_MONTHLY"), year: get("STRIPE_PRICE_PREMIUM_ANNUAL") },
  };
}

// ---- Checkout -----------------------------------------------------------------------------------

/** Where Stripe sends people back to: APP_BASE_URL when set (behind a proxy), else the request origin. */
export const appBaseUrl = (req: { nextUrl: { origin: string } }): string => (process.env.APP_BASE_URL?.trim() || req.nextUrl.origin).replace(/\/$/, "");

export interface CheckoutInput {
  plan: PaidPlan;
  interval: Interval;
  /** Team only; Pro is always one seat. */
  seats: number;
  premium: boolean;
  userId: string;
  organizationId?: string;
  email: string;
  /** Existing Stripe customer for this subject, if any. */
  customerId?: string | null;
  /** The subject's usage anchor (user signup, or org creation for Team), for billing_cycle_anchor. */
  anchorAt: Date;
  baseUrl: string;
  now?: Date;
}

export class CheckoutConfigError extends Error {
  constructor(public code: "price_not_configured" | "invalid_seats", message: string) {
    super(message);
  }
}

/** The Checkout Session body (mode=subscription). Team needs at least 3 seats; the Premium add-on quantity equals seats. */
export function buildCheckoutParams(input: CheckoutInput, prices: PriceIds = priceIds()): StripeParams {
  const seats = input.plan === "team" ? Math.floor(input.seats) : 1;
  if (input.plan === "team" && !(seats >= TEAM_MIN_SEATS && seats <= TEAM_MAX_SEATS)) {
    throw new CheckoutConfigError("invalid_seats", `Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.`);
  }
  const main = prices[input.plan][input.interval];
  const addon = input.premium ? prices.premium[input.interval] : undefined;
  if (!main || (input.premium && !addon)) {
    throw new CheckoutConfigError("price_not_configured", "This plan is not available yet. The price is not set up on the server.");
  }
  const lineItems: StripeParams[] = [{ price: main, quantity: seats }];
  if (addon) lineItems.push({ price: addon, quantity: seats });

  const metadata = {
    plan: input.plan,
    interval: input.interval,
    seats: String(seats),
    premium: input.premium ? "true" : "false",
    userId: input.userId,
    ...(input.organizationId ? { organizationId: input.organizationId } : {}),
  };
  // Match the Stripe billing day to the usage reset day. Stripe needs a future timestamp, so on the anchor day itself it is omitted.
  const anchor = nextAnchorUnix(input.anchorAt, input.now ?? new Date());
  return {
    mode: "subscription",
    line_items: lineItems,
    success_url: `${input.baseUrl}/settings/billing?checkout=success`,
    cancel_url: `${input.baseUrl}/settings/billing?checkout=cancelled`,
    client_reference_id: input.userId,
    ...(input.customerId ? { customer: input.customerId } : { customer_email: input.email }),
    metadata,
    subscription_data: {
      metadata,
      ...(anchor ? { billing_cycle_anchor: anchor, proration_behavior: "create_prorations" } : {}),
    },
  };
}

// ---- Webhook ------------------------------------------------------------------------------------

const Meta = z.record(z.string()).nullish();
const SessionObject = z.object({
  mode: z.string().optional(),
  customer: z.string().nullish(),
  subscription: z.string().nullish(),
  metadata: Meta,
});
const SubscriptionObject = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  metadata: Meta,
  items: z.object({ data: z.array(z.object({ quantity: z.number().nullish(), price: z.object({ id: z.string() }) })) }),
});

/** Stripe statuses that keep a paid plan. Anything else (canceled, unpaid, incomplete_expired, paused) is Free. */
const ENTITLED = new Set(["active", "trialing", "past_due"]);

interface Entitlement { plan: PlanTier; seats: number; premium: boolean }

/** Reads plan, seats and the premium flag from a subscription's price ids. Null when no known price is on it. */
export function entitlementFromItems(items: { quantity?: number | null; priceId: string }[], prices: PriceIds = priceIds()): Entitlement | null {
  const is = (id: string, p: Record<Interval, string | undefined>) => !!id && (id === p.month || id === p.year);
  let plan: PlanTier | null = null;
  let seats = 1;
  let premium = false;
  for (const it of items) {
    const qty = Math.max(0, it.quantity ?? 1);
    if (is(it.priceId, prices.team)) { plan = "team"; seats = Math.min(TEAM_MAX_SEATS, Math.max(TEAM_MIN_SEATS, qty)); }
    else if (is(it.priceId, prices.pro) && plan !== "team") { plan = "pro"; seats = 1; }
    else if (is(it.priceId, prices.premium) && qty > 0) premium = true;
  }
  return plan ? { plan, seats, premium } : null;
}

type Subject = { kind: "user"; id: string } | { kind: "organization"; id: string };
type Tx = Prisma.TransactionClient;

async function findSubject(tx: Tx, ref: { subscriptionId?: string | null; customerId?: string | null; metadata?: Record<string, string> | null }): Promise<Subject | null> {
  const { subscriptionId, customerId, metadata } = ref;
  if (subscriptionId) {
    const u = await tx.user.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } });
    if (u) return { kind: "user", id: u.id };
    const o = await tx.organization.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } });
    if (o) return { kind: "organization", id: o.id };
  }
  if (metadata?.organizationId) {
    const o = await tx.organization.findUnique({ where: { id: metadata.organizationId }, select: { id: true } });
    if (o) return { kind: "organization", id: o.id };
  }
  if (metadata?.userId) {
    const u = await tx.user.findUnique({ where: { id: metadata.userId }, select: { id: true } });
    if (u) return { kind: "user", id: u.id };
  }
  if (customerId) {
    const u = await tx.user.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (u) return { kind: "user", id: u.id };
    const o = await tx.organization.findUnique({ where: { stripeCustomerId: customerId }, select: { id: true } });
    if (o) return { kind: "organization", id: o.id };
  }
  return null;
}

interface Applied { event: BillingLifecycleEvent | null }

/** Writes plan, seats, premium and Stripe ids onto the subject, then re-derives its UsageAllowance cap and period. */
async function applyEntitlement(
  tx: Tx, subject: Subject, next: Entitlement,
  stripe: { customerId?: string | null; subscriptionId?: string | null; status: string }, now: Date,
): Promise<Applied> {
  const keepIds = {
    ...(stripe.customerId ? { stripeCustomerId: stripe.customerId } : {}),
    stripeSubscriptionId: next.plan === "free" ? null : (stripe.subscriptionId ?? undefined),
    subscriptionStatus: stripe.status,
  };
  let from: PlanTier;
  if (subject.kind === "organization") {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: subject.id }, select: { planTier: true } });
    from = org.planTier === "team" ? "team" : "free";
    const plan: PlanTier = next.plan === "team" ? "team" : "free";
    await tx.organization.update({
      where: { id: subject.id },
      data: { planTier: plan, seatCount: plan === "team" ? next.seats : 1, premiumVoice: plan === "team" && next.premium, ...keepIds },
    });
    await ensureAllowance(tx, { organizationId: subject.id }, now);
    return { event: build(subject, from, plan, plan === "team" ? next.seats : 1, plan === "team" && next.premium) };
  }
  const user = await tx.user.findUniqueOrThrow({ where: { id: subject.id }, select: { planTier: true } });
  from = isPlanTier(user.planTier) && user.planTier !== "team" ? user.planTier : "free";
  const plan: PlanTier = next.plan === "pro" ? "pro" : "free";
  await tx.user.update({ where: { id: subject.id }, data: { planTier: plan, premiumVoice: plan === "pro" && next.premium, ...keepIds } });
  await ensureAllowance(tx, { userId: subject.id }, now);
  return { event: build(subject, from, plan, 1, plan === "pro" && next.premium) };
}

function build(subject: Subject, from: PlanTier, to: PlanTier, seats: number, premiumVoice: boolean): BillingLifecycleEvent | null {
  const kind = classifyPlanChange(from, to);
  return kind ? { kind, subject: subject.kind, subjectId: subject.id, fromPlan: from, toPlan: to, seats, premiumVoice } : null;
}

const FREE: Entitlement = { plan: "free", seats: 1, premium: false };

async function onCheckoutCompleted(tx: Tx, obj: unknown, now: Date): Promise<Applied | null> {
  const s = SessionObject.parse(obj);
  if (s.mode && s.mode !== "subscription") return null;
  const m = s.metadata ?? {};
  if (!isPlanTier(m.plan) || m.plan === "free") return null;
  const subject = await findSubject(tx, { metadata: m.plan === "team" ? { organizationId: m.organizationId } : { userId: m.userId }, customerId: s.customer });
  if (!subject) return null;
  const seats = m.plan === "team" ? Math.min(TEAM_MAX_SEATS, Math.max(TEAM_MIN_SEATS, Number.parseInt(m.seats ?? "", 10) || TEAM_MIN_SEATS)) : 1;
  return applyEntitlement(tx, subject, { plan: m.plan, seats, premium: m.premium === "true" }, { customerId: s.customer, subscriptionId: s.subscription, status: "active" }, now);
}

async function onSubscriptionUpdated(tx: Tx, obj: unknown, now: Date, prices: PriceIds): Promise<Applied | null> {
  const sub = SubscriptionObject.parse(obj);
  const subject = await findSubject(tx, { subscriptionId: sub.id, customerId: sub.customer, metadata: sub.metadata });
  if (!subject) return null;
  // "incomplete" is a checkout still being paid; wait for it to become active.
  if (sub.status === "incomplete") return null;
  const found = entitlementFromItems(sub.items.data.map((i) => ({ quantity: i.quantity, priceId: i.price.id })), prices);
  // A subscription with none of our prices is not ours to interpret; leave the plan alone.
  if (!found) return null;
  const next = ENTITLED.has(sub.status) ? found : FREE;
  return applyEntitlement(tx, subject, next, { customerId: sub.customer, subscriptionId: sub.id, status: sub.status }, now);
}

async function onSubscriptionDeleted(tx: Tx, obj: unknown, now: Date): Promise<Applied | null> {
  const sub = SubscriptionObject.pick({ id: true, customer: true, metadata: true }).parse(obj);
  const subject = await findSubject(tx, { subscriptionId: sub.id, customerId: sub.customer, metadata: sub.metadata });
  if (!subject) return null;
  return applyEntitlement(tx, subject, FREE, { customerId: sub.customer, subscriptionId: null, status: "canceled" }, now);
}

export interface StripeEventLike { id: string; type: string; data: { object?: unknown } }

export type EventResult = "processed" | "duplicate" | "ignored";

/**
 * Handles one verified Stripe event once. The event id and the plan changes commit in one transaction, so
 * a failure rolls both back and Stripe's retry is processed, while a redelivery of a handled event is a no-op.
 */
export async function handleStripeEvent(event: StripeEventLike, now = new Date(), prices: PriceIds = priceIds()): Promise<EventResult> {
  if ((await prisma.stripeEvent.findUnique({ where: { id: event.id } })) !== null) return "duplicate";
  let applied: Applied | null = null;
  try {
    applied = await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });
      switch (event.type) {
        case "checkout.session.completed": return onCheckoutCompleted(tx, event.data.object, now);
        case "customer.subscription.updated": return onSubscriptionUpdated(tx, event.data.object, now, prices);
        case "customer.subscription.deleted": return onSubscriptionDeleted(tx, event.data.object, now);
        default: return null;
      }
    });
  } catch (e) {
    // A concurrent delivery of the same event won the insert.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }
  if (applied?.event) await emitBillingLifecycle(applied.event);
  return applied ? "processed" : "ignored";
}
