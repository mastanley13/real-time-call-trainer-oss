import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { ensureAllowance } from "./usage";
import { emitBillingLifecycle, classifyPlanChange, type BillingLifecycleEvent } from "./billingEvents";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS, isPlanTier, nextAnchorUnix, type PlanTier } from "./usagePlan";
import { stripeApi, StripeApiError, type StripeParams } from "./stripe";

/**
 * Checkout parameters and webhook handling. Stripe is the billing source of truth; this module mirrors
 * its plan, seats, premium flag and status onto the user or organization and re-derives the voice cap.
 * No overages and no metered prices exist: every line item is a flat licensed price.
 *
 * Webhook payloads are snapshots and Stripe does not deliver them in order, so an event only tells us
 * WHICH subscription to look at. The entitlement always comes from the subscription as Stripe has it now.
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

/** What makes two checkout requests "the same purchase". A different fingerprint replaces the outstanding session. */
export const checkoutFingerprint = (i: { plan: PaidPlan; interval: Interval; seats: number; premium: boolean }): string =>
  `${i.plan}|${i.interval}|${i.plan === "team" ? Math.floor(i.seats) : 1}|${i.premium ? "premium" : "base"}`;

/** Stripe keeps a Checkout Session open for 24 hours; ours is treated as stale a little sooner. */
export const CHECKOUT_REUSE_MS = 23 * 60 * 60 * 1000;

export type CheckoutSubject = { kind: "user" | "organization"; id: string };

interface PendingRow {
  stripeCheckoutSessionId: string | null;
  stripeCheckoutFingerprint: string | null;
  stripeCheckoutUrl: string | null;
  stripeCheckoutExpiresAt: Date | null;
}
interface PendingDelegate {
  findUnique(args: { where: { id: string } }): Promise<PendingRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Partial<PendingRow> }): Promise<{ count: number }>;
}
const pendingTable = (kind: CheckoutSubject["kind"]) => (kind === "user" ? prisma.user : prisma.organization) as unknown as PendingDelegate;

type CheckoutApi = Pick<typeof stripeApi, "createCheckoutSession" | "expireCheckoutSession" | "retrieveCheckoutSession">;

export type CheckoutOutcome =
  | { ok: true; url: string; reused: boolean }
  | { ok: false; error: "checkout_in_progress" | "checkout_completed" };

/**
 * Makes sure the previous Checkout Session can no longer be paid before a replacement exists. Expiring it
 * is attempted first; if Stripe refuses (it is already complete, already expired, or the call failed) the
 * session is read back. Only a confirmed "expired" lets the caller go on. A completed session is applied
 * from its subscription right away instead of waiting for the webhook. A session that is still open, or
 * whose state cannot be read, throws: no replacement is created while the old one might still be paid.
 */
async function closePrevious(id: string, api: CheckoutApi, now: Date, deps: StripeDeps): Promise<"closed" | "completed"> {
  try {
    await api.expireCheckoutSession(id);
    return "closed";
  } catch {
    // Fall through: the session may be complete or expired already.
  }
  const s = SessionObject.extend({ status: z.string().nullish() }).parse(await api.retrieveCheckoutSession(id));
  if (s.status === "expired") return "closed";
  if (s.status !== "complete") throw new StripeApiError(502);
  await applyCompletedCheckout(s, now, deps);
  return "completed";
}

/**
 * One outstanding Checkout Session per billing subject. A repeat request for the same purchase gets the
 * stored session back instead of a second one; a different purchase expires the old session first.
 * Two requests racing each other both ask Stripe with the same idempotency key (so Stripe returns one
 * session), then compare-and-swap the stored id, so exactly one session is ever recorded.
 */
export async function createOrReuseCheckout(
  input: { subject: CheckoutSubject; fingerprint: string; params: StripeParams; now?: Date },
  api: CheckoutApi = stripeApi,
  deps: StripeDeps = liveDeps,
): Promise<CheckoutOutcome> {
  const now = input.now ?? new Date();
  const table = pendingTable(input.subject.kind);
  const where = { id: input.subject.id };
  const row = await table.findUnique({ where });
  if (!row) throw new Error("billing subject not found");

  const hasLive = !!(row.stripeCheckoutSessionId && row.stripeCheckoutUrl && row.stripeCheckoutExpiresAt && row.stripeCheckoutExpiresAt.getTime() > now.getTime());
  if (hasLive && row.stripeCheckoutFingerprint === input.fingerprint) return { ok: true, url: row.stripeCheckoutUrl!, reused: true };
  // Any stored session may still be payable (Stripe keeps it open a little longer than we reuse it), so it
  // is confirmed closed before a replacement is made, whatever our own expiry says.
  if (row.stripeCheckoutSessionId && (await closePrevious(row.stripeCheckoutSessionId, api, now, deps)) === "completed") {
    return { ok: false, error: "checkout_completed" };
  }

  const expected = row.stripeCheckoutSessionId;
  const key = `checkout:${input.subject.kind}:${input.subject.id}:${input.fingerprint}:${expected ?? "none"}`;
  const created = await api.createCheckoutSession(input.params, key);
  if (!created.url) throw new StripeApiError(502);

  const stored = await table.updateMany({
    where: { ...where, stripeCheckoutSessionId: expected },
    data: {
      stripeCheckoutSessionId: created.id,
      stripeCheckoutFingerprint: input.fingerprint,
      stripeCheckoutUrl: created.url,
      stripeCheckoutExpiresAt: new Date(now.getTime() + CHECKOUT_REUSE_MS),
    },
  });
  if (stored.count === 1) return { ok: true, url: created.url, reused: false };

  // Someone else recorded a session first. If it is the same purchase, use theirs; never leave two open.
  const winner = await table.findUnique({ where });
  if (winner?.stripeCheckoutSessionId === created.id) return { ok: true, url: created.url, reused: true };
  await api.expireCheckoutSession(created.id).catch(() => undefined);
  if (winner?.stripeCheckoutUrl && winner.stripeCheckoutFingerprint === input.fingerprint) return { ok: true, url: winner.stripeCheckoutUrl, reused: true };
  return { ok: false, error: "checkout_in_progress" };
}

// ---- Webhook ------------------------------------------------------------------------------------

const Meta = z.record(z.string()).nullish();
const SessionObject = z.object({
  id: z.string().optional(),
  mode: z.string().optional(),
  customer: z.string().nullish(),
  subscription: z.string().nullish(),
  /** paid | unpaid | no_payment_required. Delayed payment methods complete Checkout while still unpaid. */
  payment_status: z.string().optional(),
  metadata: Meta,
});
const SubscriptionObject = z.object({
  id: z.string(),
  customer: z.string(),
  status: z.string(),
  metadata: Meta,
  items: z.object({ data: z.array(z.object({ quantity: z.number().nullish(), price: z.object({ id: z.string() }) })) }),
});
type LiveSubscription = z.infer<typeof SubscriptionObject>;

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

/** The subject whose CURRENT subscription is this one. No fallback: an old subscription must never match a newer one's owner. */
async function subjectOfSubscription(tx: Tx, subscriptionId: string): Promise<Subject | null> {
  const u = await tx.user.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } });
  if (u) return { kind: "user", id: u.id };
  const o = await tx.organization.findUnique({ where: { stripeSubscriptionId: subscriptionId }, select: { id: true } });
  if (o) return { kind: "organization", id: o.id };
  return null;
}

async function findSubject(tx: Tx, ref: { subscriptionId?: string | null; customerId?: string | null; metadata?: Record<string, string> | null }): Promise<Subject | null> {
  const { subscriptionId, customerId, metadata } = ref;
  if (subscriptionId) {
    const s = await subjectOfSubscription(tx, subscriptionId);
    if (s) return s;
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

async function currentSubscriptionId(tx: Tx, subject: Subject): Promise<string | null> {
  const row = subject.kind === "organization"
    ? await tx.organization.findUnique({ where: { id: subject.id }, select: { stripeSubscriptionId: true } })
    : await tx.user.findUnique({ where: { id: subject.id }, select: { stripeSubscriptionId: true } });
  return row?.stripeSubscriptionId ?? null;
}

interface Applied {
  event: BillingLifecycleEvent | null;
  /** A second subscription for a subject that already has one: cancel it at Stripe after the transaction commits. */
  cancelSubscriptionId?: string;
}

/** Writes plan, seats, premium and Stripe ids onto the subject, then re-derives its UsageAllowance cap and period. */
async function applyEntitlement(
  tx: Tx, subject: Subject, next: Entitlement,
  stripe: { customerId?: string | null; subscriptionId?: string | null; status: string }, now: Date,
): Promise<Applied> {
  const keepIds = {
    ...(stripe.customerId ? { stripeCustomerId: stripe.customerId } : {}),
    stripeSubscriptionId: next.plan === "free" ? null : (stripe.subscriptionId ?? undefined),
    subscriptionStatus: stripe.status,
    // A paid subscription is in place, so the checkout that produced it is no longer outstanding.
    ...(next.plan === "free" ? {} : { stripeCheckoutSessionId: null, stripeCheckoutFingerprint: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null }),
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

/** The subscription as Stripe has it now: parsed, "gone" when Stripe no longer has it, or null when there is no id. */
type Live = LiveSubscription | "gone" | null;

/**
 * Applies the current state of one subscription to its owner. Safe to run for any event in any order:
 * the outcome depends only on `live` and what the owner currently holds, never on the event's snapshot.
 */
async function reconcile(
  tx: Tx, subscriptionId: string, live: Live, hint: { customerId?: string | null; metadata?: Record<string, string> | null }, now: Date, prices: PriceIds,
): Promise<Applied | null> {
  if (live === null) return null;
  if (live === "gone") {
    // Stripe no longer has it: the same as canceled, and only for the subject that still holds it.
    const holder = await subjectOfSubscription(tx, subscriptionId);
    return holder ? applyEntitlement(tx, holder, FREE, { customerId: hint.customerId, subscriptionId: null, status: "canceled" }, now) : null;
  }
  // "incomplete" is a checkout still being paid; wait for it to become active.
  if (live.status === "incomplete") return null;
  const found = entitlementFromItems(live.items.data.map((i) => ({ quantity: i.quantity, priceId: i.price.id })), prices);
  // A subscription with none of our prices is not ours to interpret; leave the plan alone.
  if (!found) return null;
  const subject = await findSubject(tx, { subscriptionId: live.id, customerId: live.customer, metadata: { ...(hint.metadata ?? {}), ...(live.metadata ?? {}) } });
  if (!subject) return null;

  const held = await currentSubscriptionId(tx, subject);
  if (held && held !== live.id) {
    // The subject already has a different subscription. This one is either an old subscription's late
    // event (ignore it) or a duplicate purchase (cancel it so the customer is not billed twice).
    return ENTITLED.has(live.status) ? { event: null, cancelSubscriptionId: live.id } : null;
  }
  const next = ENTITLED.has(live.status) ? found : FREE;
  return applyEntitlement(tx, subject, next, { customerId: live.customer, subscriptionId: live.id, status: live.status }, now);
}

async function onCheckoutPaid(tx: Tx, obj: unknown, live: Live, now: Date, prices: PriceIds, requirePaid: boolean): Promise<Applied | null> {
  const s = SessionObject.parse(obj);
  if (s.mode && s.mode !== "subscription") return null;
  if (!s.subscription) return null;
  // A delayed payment method completes Checkout before the money arrives. Nothing is granted until Stripe says
  // the payment succeeded (async_payment_succeeded) or the subscription itself becomes active.
  if (requirePaid && s.payment_status === "unpaid") return null;
  return reconcile(tx, s.subscription, live, { customerId: s.customer, metadata: s.metadata }, now, prices);
}

async function onSubscriptionChanged(tx: Tx, obj: unknown, live: Live, now: Date, prices: PriceIds): Promise<Applied | null> {
  const sub = SubscriptionObject.pick({ id: true, customer: true, metadata: true }).parse(obj);
  return reconcile(tx, sub.id, live, { customerId: sub.customer, metadata: sub.metadata }, now, prices);
}

async function onSubscriptionDeleted(tx: Tx, obj: unknown, now: Date): Promise<Applied | null> {
  const sub = SubscriptionObject.pick({ id: true, customer: true }).parse(obj);
  // Only the subject whose current subscription this is loses access. A deleted OLD subscription finds
  // nobody here, so it cannot cancel a newer subscription's entitlement.
  const holder = await subjectOfSubscription(tx, sub.id);
  return holder ? applyEntitlement(tx, holder, FREE, { customerId: sub.customer, subscriptionId: null, status: "canceled" }, now) : null;
}

async function onCheckoutExpired(tx: Tx, obj: unknown): Promise<Applied | null> {
  const s = SessionObject.parse(obj);
  if (!s.id) return null;
  const cleared = { stripeCheckoutSessionId: null, stripeCheckoutFingerprint: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null };
  await tx.user.updateMany({ where: { stripeCheckoutSessionId: s.id }, data: cleared });
  await tx.organization.updateMany({ where: { stripeCheckoutSessionId: s.id }, data: cleared });
  return { event: null };
}

export interface StripeEventLike { id: string; type: string; data: { object?: unknown } }

export type EventResult = "processed" | "duplicate" | "ignored";

export interface StripeDeps {
  retrieveSubscription(id: string): Promise<unknown>;
  cancelSubscription(id: string): Promise<unknown>;
}
const liveDeps: StripeDeps = {
  retrieveSubscription: (id) => stripeApi.retrieveSubscription(id),
  cancelSubscription: (id) => stripeApi.cancelSubscription(id),
};

/** Events whose subscription is re-read from Stripe before anything is granted or revoked. */
const RECONCILED = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.updated"]);

function subscriptionIdOf(event: StripeEventLike): string | null {
  const o = event.data.object as { id?: unknown; subscription?: unknown } | undefined;
  if (event.type.startsWith("checkout.session.")) return typeof o?.subscription === "string" ? o.subscription : null;
  return typeof o?.id === "string" ? o.id : null;
}

/** Reads the subscription from Stripe before the database transaction starts, so no network call holds a transaction open. */
async function fetchLive(id: string | null, deps: StripeDeps): Promise<Live> {
  if (!id) return null;
  try {
    return SubscriptionObject.parse(await deps.retrieveSubscription(id));
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return "gone";
    throw e; // the webhook answers 500 and Stripe retries; nothing has been written
  }
}

/**
 * Handles one verified Stripe event once. The event id and the plan changes commit in one transaction, so
 * a failure rolls both back and Stripe's retry is processed, while a redelivery of a handled event is a no-op.
 * Updates and completed checkouts are applied from the subscription's current state, not the event body.
 */
export async function handleStripeEvent(event: StripeEventLike, now = new Date(), prices: PriceIds = priceIds(), deps: StripeDeps = liveDeps): Promise<EventResult> {
  if ((await prisma.stripeEvent.findUnique({ where: { id: event.id } })) !== null) return "duplicate";
  const live = RECONCILED.has(event.type) ? await fetchLive(subscriptionIdOf(event), deps) : null;
  let applied: Applied | null = null;
  try {
    applied = await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });
      switch (event.type) {
        case "checkout.session.completed": return onCheckoutPaid(tx, event.data.object, live, now, prices, true);
        case "checkout.session.async_payment_succeeded": return onCheckoutPaid(tx, event.data.object, live, now, prices, false);
        case "customer.subscription.updated": return onSubscriptionChanged(tx, event.data.object, live, now, prices);
        case "customer.subscription.deleted": return onSubscriptionDeleted(tx, event.data.object, now);
        // A failed delayed payment grants nothing; the session is cleared so the account can start a new checkout.
        case "checkout.session.async_payment_failed":
        case "checkout.session.expired": return onCheckoutExpired(tx, event.data.object);
        default: return null;
      }
    });
  } catch (e) {
    // A concurrent delivery of the same event won the insert.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return "duplicate";
    throw e;
  }
  await afterApplied(applied, deps);
  return applied ? "processed" : "ignored";
}

/** The work that must wait until the transaction has committed: dropping a duplicate subscription, then the lifecycle event. */
async function afterApplied(applied: Applied | null, deps: StripeDeps): Promise<void> {
  if (applied?.cancelSubscriptionId) {
    await deps.cancelSubscription(applied.cancelSubscriptionId).catch((e) => console.error("[stripe] duplicate subscription cancel failed", e instanceof StripeApiError ? `status ${e.status}` : "error"));
  }
  if (applied?.event) await emitBillingLifecycle(applied.event);
}

/**
 * Applies a completed Checkout Session without waiting for its webhook. Reconciliation depends only on the
 * subscription as Stripe has it now, so running it again when the webhook arrives changes nothing.
 */
async function applyCompletedCheckout(session: z.infer<typeof SessionObject>, now: Date, deps: StripeDeps, prices: PriceIds = priceIds()): Promise<void> {
  const live = await fetchLive(session.subscription ?? null, deps);
  const applied = await prisma.$transaction((tx) => onCheckoutPaid(tx, session, live, now, prices, true));
  await afterApplied(applied, deps);
}
