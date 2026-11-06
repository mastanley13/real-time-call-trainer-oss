import "server-only";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "./db";
import { ensureAllowance } from "./usage";
import { emitBillingLifecycle, emitPremiumEvent, classifyPlanChange, type BillingLifecycleEvent, type PremiumEvent } from "./billingEvents";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS, isPlanTier, nextAnchorUnix, type PlanTier } from "./usagePlan";
import { blocksCheckout, isEntitled, nextPastDueSince } from "./subscriptionStatus";
import { PREMIUM_STATUSES } from "./premiumVoice";
import { premiumOnSale } from "./serverConfig";
import { stripeApi, StripeApiError, stripeLiveMode, type StripeParams } from "./stripe";

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

// ---- Prices (an env allowlist of price ids, checked against product metadata) -------------------

export interface PriceIds {
  pro: Record<Interval, string | undefined>;
  team: Record<Interval, string | undefined>;
  premium: Record<Interval, string | undefined>;
}

type PriceSlot = keyof PriceIds;

/** Env vars holding the six allowlisted price ids. Price ids are not secrets. */
export const PRICE_ENV = {
  pro: { month: "STRIPE_PRICE_PRO_MONTHLY", year: "STRIPE_PRICE_PRO_ANNUAL" },
  team: { month: "STRIPE_PRICE_TEAM_MONTHLY", year: "STRIPE_PRICE_TEAM_ANNUAL" },
  premium: { month: "STRIPE_PRICE_PREMIUM_MONTHLY", year: "STRIPE_PRICE_PREMIUM_ANNUAL" },
} as const;

const SLOTS: PriceSlot[] = ["pro", "team", "premium"];
const INTERVALS: Interval[] = ["month", "year"];

const emptyPrices = (): PriceIds => ({ pro: { month: undefined, year: undefined }, team: { month: undefined, year: undefined }, premium: { month: undefined, year: undefined } });

/** The allowlist as configured now. An unset or blank variable leaves its slot undefined. */
export function priceAllowlist(env: NodeJS.ProcessEnv = process.env): PriceIds {
  const ids = emptyPrices();
  for (const slot of SLOTS) for (const interval of INTERVALS) ids[slot][interval] = env[PRICE_ENV[slot][interval]]?.trim() || undefined;
  return ids;
}

/** Which slot an allowlisted price id fills, or null when the id is not on the list. */
function slotOf(id: string, list: PriceIds): { slot: PriceSlot; interval: Interval } | null {
  for (const slot of SLOTS) for (const interval of INTERVALS) if (list[slot][interval] === id) return { slot, interval };
  return null;
}

/**
 * What a product declares itself to be: "pro", "team" or "premium" (the add-on). New ct_* format only; the
 * older plan and addon keys are never read. Null means no valid declaration.
 * - pro or team: ct_plan is that plan and ct_addon is absent or "none".
 * - premium: ct_plan=addon, ct_addon=premium_voice and ct_version=1.
 */
function productKind(meta: Record<string, string> | null | undefined): PriceSlot | null {
  if (!meta) return null;
  if (!Object.keys(meta).some((k) => k.startsWith("ct_"))) {
    console.warn("[billing] product has no ct_* metadata");
    return null;
  }
  if (meta.ct_plan === "pro" || meta.ct_plan === "team") {
    return meta.ct_addon === undefined || meta.ct_addon === "none" ? meta.ct_plan : null;
  }
  return meta.ct_plan === "addon" && meta.ct_addon === "premium_voice" && meta.ct_version === "1" ? "premium" : null;
}

const PriceObject = z.object({
  id: z.string(),
  active: z.boolean().optional(),
  livemode: z.boolean().optional(),
  type: z.string().optional(),
  recurring: z.object({ usage_type: z.string().optional(), interval: z.string().optional() }).nullish(),
  product: z.union([z.string(), z.object({ metadata: z.record(z.string()).nullish() })]).nullish(),
});

const PRICE_CACHE_MS = 5 * 60 * 1000;
let priceCache: { at: number; key: string; ids: PriceIds } | null = null;
export const resetPriceCache = (): void => { priceCache = null; };

/**
 * Checks each allowlisted price id with stripe.prices.retrieve (product expanded). A blank variable, an
 * unknown or inactive price, a non-recurring or metered price, or a product whose plan disagrees with the
 * slot resolves to undefined, which checkout reports as price_not_configured. Cached for a few minutes.
 */
export async function resolvePriceIds(api: Pick<typeof stripeApi, "retrievePrice"> = stripeApi, nowMs = Date.now(), env: NodeJS.ProcessEnv = process.env): Promise<PriceIds> {
  const list = priceAllowlist(env);
  const key = JSON.stringify({ list, live: stripeLiveMode(env) });
  if (priceCache && priceCache.key === key && nowMs - priceCache.at < PRICE_CACHE_MS) return priceCache.ids;
  const ids = emptyPrices();
  for (const slot of SLOTS) {
    for (const interval of INTERVALS) {
      const id = list[slot][interval];
      if (!id) continue;
      let price: z.infer<typeof PriceObject>;
      try {
        price = PriceObject.parse(await api.retrievePrice(id));
      } catch (e) {
        if (e instanceof StripeApiError && e.status === 404) { console.warn("[billing] allowlisted price not found", id); continue; }
        throw e;
      }
      if (price.id !== id || price.active === false) continue;
      // Fail closed: a price from the other Stripe mode (or one that does not say) is never offered.
      if (price.livemode !== stripeLiveMode(env)) { console.warn("[billing] allowlisted price is from the other Stripe mode", id); continue; }
      if (price.type !== "recurring" || price.recurring?.usage_type !== "licensed") { console.warn("[billing] allowlisted price is not flat licensed recurring", id); continue; }
      if (price.recurring.interval && price.recurring.interval !== interval) { console.warn("[billing] allowlisted price interval mismatch", id); continue; }
      const meta = typeof price.product === "object" && price.product ? price.product.metadata : null;
      if (productKind(meta) !== slot) { console.warn("[billing] allowlisted price and product plan disagree", id); continue; }
      ids[slot][interval] = id;
    }
  }
  priceCache = { at: nowMs, key, ids };
  return ids;
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
export function buildCheckoutParams(input: CheckoutInput, prices: PriceIds): StripeParams {
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
    app: "calltrainer",
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
  /** Unix seconds. Older API versions put it here; newer ones only on each item (read both, see periodEndOf). */
  current_period_end: z.number().nullish(),
  cancel_at_period_end: z.boolean().nullish(),
  /** A subscription schedule managing this subscription (a scheduled removal or seat decrease), if any. */
  schedule: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  /**
   * Billing terms that change what a charge or a scheduled phase is. Read only to bind a Premium/seat preview to them
   * and to refuse a scheduled change the app could not carry them into (src/lib/premiumAddon.ts). Never interpreted.
   */
  current_period_start: z.number().nullish(),
  discount: z.unknown().nullish(),
  discounts: z.array(z.unknown()).nullish(),
  default_tax_rates: z.array(z.unknown()).nullish(),
  automatic_tax: z.object({ enabled: z.boolean().nullish() }).passthrough().nullish(),
  collection_method: z.string().nullish(),
  items: z.object({
    data: z.array(z.object({
      id: z.string().optional(),
      quantity: z.number().nullish(),
      current_period_end: z.number().nullish(),
      tax_rates: z.array(z.unknown()).nullish(),
      discounts: z.array(z.unknown()).nullish(),
      price: z.object({
        id: z.string(),
        type: z.string().nullish(),
        /** Cents. Used only to show the renewal total on the Premium confirm screen. */
        unit_amount: z.number().nullish(),
        currency: z.string().nullish(),
        recurring: z.object({ usage_type: z.string().nullish(), interval: z.string().nullish() }).nullish(),
        /** Expanded by retrieveSubscription. A bare id carries no metadata and is not interpreted. */
        product: z.union([z.string(), z.object({ metadata: z.record(z.string()).nullish() })]).nullish(),
      }),
    })),
  }),
});
export type LiveSubscription = z.infer<typeof SubscriptionObject>;

/** Parses a subscription as Stripe returns it (items expanded). Throws on a shape this module cannot read. */
export const parseLiveSubscription = (raw: unknown): LiveSubscription => SubscriptionObject.parse(raw);

/** The current period end: the subscription's own field, else the latest item period end. Null when Stripe gave neither. */
export function periodEndOf(live: Pick<LiveSubscription, "current_period_end" | "items">): Date | null {
  const own = live.current_period_end;
  const items = live.items.data.map((i) => i.current_period_end ?? 0).filter((n) => n > 0);
  const secs = own && own > 0 ? own : items.length ? Math.max(...items) : 0;
  return secs > 0 ? new Date(secs * 1000) : null;
}

/** What kind of item this is, by the same metadata rule entitlement uses. Null when it is neither a plan nor the add-on. */
export function itemKind(price: LiveSubscription["items"]["data"][number]["price"]): PriceSlot | null {
  const meta = typeof price.product === "object" && price.product ? price.product.metadata : null;
  return productKind(meta ?? null);
}

// Which statuses keep a paid plan, and which block a new checkout, is decided only in subscriptionStatus.ts.
export { blocksCheckout };

interface Entitlement {
  plan: PlanTier;
  seats: number;
  premium: boolean;
  /** Present when premium is true: the add-on item's quantity (Team units are min(this, seats)). */
  premiumQuantity?: number;
  interval?: Interval;
}

export interface SubscriptionItemInfo {
  quantity?: number | null;
  priceId?: string | null;
  /** The price's `type` and recurring details as Stripe returns them. */
  priceType?: string | null;
  usageType?: string | null;
  interval?: string | null;
  /** The expanded product's metadata. Null or undefined when the product was not expanded. */
  productMetadata?: Record<string, string> | null;
}

const refuse = (reason: string, it?: SubscriptionItemInfo): null => {
  console.warn("[billing] plan sync refused:", reason, it?.priceId ?? "");
  return null;
};

/**
 * Reads plan, seats and the premium flag from the subscription's own items.
 * 1. A price on the env allowlist is trusted only if its product's ct_plan agrees with the price's slot.
 * 2. Any other price (archived or replaced) needs product metadata with ct_version=1 and a valid ct_plan.
 * Fails closed (null, so the account stays Free) on an unknown base price or product, a mismatch between an
 * allowlisted price and its product, a metered or non-recurring price, an unexpanded product, two different
 * base plans, or Team below the product's seat minimum. Any other item that is neither a valid base plan nor
 * a valid Premium add-on, and does not declare ct_plan pro or team, is skipped with a warning and the base
 * plan still grants (no valid base left still means null). A non-allowlisted item that declares ct_plan pro or
 * team but is otherwise invalid refuses the whole subscription. Premium counts only with quantity above 0
 * next to a base plan, and only on the same billing interval as the base plan (a mismatched add-on grants no Premium,
 * the base plan still grants). `premiumQuantity` is the add-on item quantity.
 */
export function entitlementFromItems(items: SubscriptionItemInfo[], allowlist: PriceIds = priceAllowlist()): Entitlement | null {
  const plans = new Set<PaidPlan>();
  let seats = 1;
  let premium = false;
  let premiumQuantity = 0;
  const premiumIntervals = new Set<string>();
  let interval: Interval | undefined;
  for (const it of items) {
    const qty = Math.max(0, it.quantity ?? 1);
    if (it.priceType !== "recurring" || it.usageType !== "licensed") return refuse("price is not flat licensed recurring", it);
    const meta = it.productMetadata;
    if (!meta) return refuse("product not expanded or has no metadata", it);
    const hit = it.priceId ? slotOf(it.priceId, allowlist) : null;
    const kind = productKind(meta);
    // The allowlisted slot is checked first, so no add-on skip can hide a mismatch on a base price.
    if (hit && hit.slot !== "premium" && kind !== hit.slot) return refuse("allowlisted price and product plan disagree", it);
    if (hit && hit.slot === "premium" && (kind === "pro" || kind === "team")) return refuse("allowlisted Premium price and product plan disagree", it);
    // Anything that is not a valid base plan and does not claim to be one (ct_plan pro or team) is an add-on
    // candidate: if it is not a valid Premium add-on it is skipped, and a valid base still grants.
    const claimsBase = meta.ct_plan === "pro" || meta.ct_plan === "team";
    if (kind !== "premium" && kind !== "pro" && kind !== "team" && !claimsBase) {
      console.warn("[billing] item is not a valid base plan or Premium add-on; skipped", it.priceId ?? "");
      continue;
    }
    if (hit && hit.slot === "premium" && kind !== "premium") return refuse("allowlisted price and product plan disagree", it);
    if (!hit && (meta.ct_version !== "1" || !kind)) {
      return refuse("price is not allowlisted and its product has no valid ct_plan with ct_version=1", it);
    }
    if (kind === "premium") {
      if (qty > 0) {
        premium = true;
        premiumQuantity += qty;
        const pi = hit?.interval ?? it.interval;
        if (pi) premiumIntervals.add(pi);
      }
      continue;
    }
    if (kind === "team") {
      const min = Number.parseInt(meta.ct_seat_min ?? "", 10) || TEAM_MIN_SEATS;
      if (qty < min) return refuse(`Team quantity ${qty} is below the seat minimum ${min}; flag for support`, it);
      seats = Math.min(TEAM_MAX_SEATS, qty);
    }
    plans.add(kind as PaidPlan);
    interval = hit?.interval ?? (it.interval === "month" || it.interval === "year" ? it.interval : undefined);
  }
  if (plans.size > 1) return refuse("items declare two different base plans");
  if (plans.size === 0) return null;
  const plan = [...plans][0];
  // The add-on bills on the base plan's interval. One on another interval (or two intervals) is not a valid add-on.
  if (premium && interval && [...premiumIntervals].some((pi) => pi !== interval)) {
    console.warn("[billing] Premium add-on interval does not match the base plan; Premium not granted");
    premium = false;
  }
  return { plan, seats: plan === "team" ? seats : 1, premium, ...(premium ? { premiumQuantity } : {}), interval };
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

async function pastDueSinceOf(tx: Tx, subject: Subject): Promise<Date | null> {
  const row = subject.kind === "organization"
    ? await tx.organization.findUnique({ where: { id: subject.id }, select: { pastDueSince: true } })
    : await tx.user.findUnique({ where: { id: subject.id }, select: { pastDueSince: true } });
  return row?.pastDueSince ?? null;
}

interface Applied {
  event: BillingLifecycleEvent | null;
  /** A second subscription for a subject that already has one: cancel it at Stripe after the transaction commits. */
  cancelSubscriptionId?: string;
  /** Premium Voice events to emit after commit (premium_added, premium_removed). */
  premiumEvents?: PremiumEvent[];
  /** The add-on quantity drifted from the seats (a portal seat change): bring it back in step after commit. */
  addonSync?: AddonSync;
  /** Whose subscription addonSync is for. A Team decrease is moved to renewal through the app's own schedule. */
  addonSyncSubject?: Subject;
}

export interface AddonSync { subscriptionId: string; itemId: string; from: number; quantity: number; direction: "up" | "down" }

/**
 * Seats changed outside the app (the Billing Portal changes only the base item), so the Premium add-on quantity no longer
 * equals the seats. Returns the one change that restores quantity = seats (Pro: 1), or null when nothing should be
 * written: no add-on, already in step, not `active` (the Premium rule: no paid Premium in a trial or past_due), a
 * schedule owns the next quantities (a removal or seat decrease made in the app, or a portal decrease already moved to
 * renewal), or the subscription is ending at period end.
 * - up: more seats. Prorated on the next invoice (create_prorations); the pool grows when it lands.
 * - down: fewer seats. Spec section 7 line 65: "Removed seats lower qty at renewal". The Team keeps the Premium units it
 *   paid for this period until current_period_end (seatCountAtRenewal marks the pending drop, see premiumSeatsForUnits),
 *   and the add-on quantity is lowered for the NEXT period through the app's own subscription schedule (afterApplied,
 *   premiumAddon.scheduleAddonSeatsAtRenewal), with the same leases, exact-original checks and refusal to touch any
 *   other schedule as an in-app decrease. When that cannot be done safely (terms a schedule would drop, or someone
 *   else's schedule), nothing is lowered: the paid quantity and pool are kept, and the webhook fails visibly for support
 *   (AddonDecreaseNeedsSupport). There is no immediate-decrease fallback.
 *
 * A schedule on the subscription blocks only the increase (nothing is changed now under a schedule). A decrease is
 * still returned (Codex P1): the renewal step goes through scheduleAtRenewal, which resumes the app's OWN unfinished
 * setup with its lease and exact baseline (so a Stripe retry after a partial setup completes it), and refuses any other
 * schedule without touching it; a refused one is then only READ to see whether its renewal phase already lowers the
 * add-on (premiumAddon.scheduleAddonSeatsAtRenewal). It is never skipped silently because a schedule is attached.
 */
export function addonQuantitySync(live: LiveSubscription): AddonSync | null {
  if (!(PREMIUM_STATUSES as readonly string[]).includes(live.status) || live.cancel_at_period_end) return null;
  let base: LiveSubscription["items"]["data"][number] | undefined;
  let premium: LiveSubscription["items"]["data"][number] | undefined;
  for (const it of live.items.data) {
    const kind = itemKind(it.price);
    if (kind === "pro" || kind === "team") base = it;
    else if (kind === "premium" && (it.quantity ?? 1) > 0) premium = it;
  }
  if (!base || !premium?.id) return null;
  const kind = itemKind(base.price);
  const target = kind === "team" ? Math.max(0, Math.floor(base.quantity ?? 1)) : 1;
  const current = premium.quantity ?? 1;
  if (target <= 0 || target === current) return null;
  // Under a schedule nothing is changed now: an increase waits; a decrease is only ever a renewal phase (see above).
  if (live.schedule && target > current) return null;
  return { subscriptionId: live.id, itemId: premium.id, from: current, quantity: target, direction: target > current ? "up" : "down" };
}

/** The scope prefix of the app's portal-decrease schedule setups (premiumAddon.scheduleAddonSeatsAtRenewal). */
export const ADDON_SEATS_SCOPE = "addon-seats-";

interface StripeState { customerId?: string | null; subscriptionId?: string | null; status: string; periodEnd?: Date | null }

const premiumStatus = (s: string | null | undefined): boolean => (PREMIUM_STATUSES as readonly string[]).includes(s ?? "");

/**
 * premium_added or premium_removed when Premium flips: the add-on flag together with a status that allows Premium
 * (`active` only, PREMIUM_STATUSES). Nothing when it stays the same.
 */
function premiumFlip(subject: Subject, plan: PlanTier, before: boolean, after: boolean, units: number, status: string): PremiumEvent[] {
  if (before === after) return [];
  const reason = premiumStatus(status) ? "ended" : `status_${status}`;
  const paid = plan === "pro" || plan === "team" ? plan : undefined;
  return [after
    ? { name: "premium_added", subject: subject.kind, subjectId: subject.id, plan: paid, units }
    : { name: "premium_removed", subject: subject.kind, subjectId: subject.id, plan: paid, reason }];
}

/**
 * Writes plan, seats, premium, add-on quantity, period end and Stripe ids onto the subject, then re-derives its
 * UsageAllowance cap, Premium minutes and period. Never writes voiceModelComped or voiceModelTier: comped overrides
 * billing and Stripe never clears it.
 */
async function applyEntitlement(
  tx: Tx, subject: Subject, next: Entitlement,
  stripe: StripeState, now: Date,
): Promise<Applied> {
  const keepIds = {
    ...(stripe.customerId ? { stripeCustomerId: stripe.customerId } : {}),
    // Free unlinks the subscription only once it is over (canceled, incomplete_expired, gone). While its status
    // still blocks checkout (active, trialing, past_due, unpaid, paused) the link stays, whether access was
    // revoked for failed validation or for non-payment, so no second subscription can be bought.
    stripeSubscriptionId: next.plan === "free" && !(stripe.subscriptionId && blocksCheckout(stripe.status)) ? null : (stripe.subscriptionId ?? undefined),
    subscriptionStatus: stripe.status,
    // A paid subscription is in place, so the checkout that produced it is no longer outstanding.
    ...(next.plan === "free" ? {} : { stripeCheckoutSessionId: null, stripeCheckoutFingerprint: null, stripeCheckoutUrl: null, stripeCheckoutExpiresAt: null }),
  };
  // A free result (canceled, gone, refused) keeps no period end; a paid one records Stripe's.
  const periodEnd = next.plan === "free" ? null : (stripe.periodEnd ?? null);
  // A failed-payment suspension belongs to the subscription it was raised on. It is never cleared here by an update
  // that reports the subscription active (only invoice.paid for that invoice clears it, see onInvoice), but it ends
  // with the subscription: once the subject is unlinked, or another subscription becomes current, it no longer applies.
  const suspensionEnds = (held: string | null) => keepIds.stripeSubscriptionId === null || (!!stripe.subscriptionId && !!held && held !== stripe.subscriptionId);
  const clearSuspension = { premiumSuspendedAt: null, premiumSuspendedInvoiceId: null };
  let from: PlanTier;
  if (subject.kind === "organization") {
    const org = await tx.organization.findUniqueOrThrow({ where: { id: subject.id }, select: { planTier: true, pastDueSince: true, premiumVoice: true, seatCountAtRenewal: true, subscriptionStatus: true, stripeSubscriptionId: true, premiumSuspendedAt: true, subscriptionPeriodEnd: true } });
    const ends = suspensionEnds(org.stripeSubscriptionId);
    const suspendedAfter = !!org.premiumSuspendedAt && !ends;
    from = org.planTier === "team" ? "team" : "free";
    const plan: PlanTier = next.plan === "team" ? "team" : "free";
    const seats = plan === "team" ? next.seats : 1;
    const premium = plan === "team" && next.premium;
    const qty = premium ? Math.max(0, next.premiumQuantity ?? seats) : 0;
    // A pending seat decrease is done once it has landed in full (the seats AND the add-on are at the target). After a
    // renewal it is also dropped once the add-on is no longer above the seats. While the add-on is still billed above
    // the seats (a decrease that could not be scheduled and needs support), the mark stays: the Team keeps exactly the
    // Premium units it is billed for, and the pending target stays visible, never a silent shrink.
    const landed = org.seatCountAtRenewal === seats && qty <= seats;
    const renewed = !!org.subscriptionPeriodEnd && !!periodEnd && periodEnd.getTime() > org.subscriptionPeriodEnd.getTime();
    await tx.organization.update({
      where: { id: subject.id },
      data: {
        planTier: plan, seatCount: seats, premiumVoice: premium, premiumVoiceQuantity: qty, subscriptionPeriodEnd: periodEnd,
        // A scheduled removal is done once the add-on has left; a scheduled seat decrease is done once it has landed.
        ...(premium ? {} : { premiumVoiceRemoveAt: null }),
        ...(plan !== "team" || landed || (renewed && qty <= seats) ? { seatCountAtRenewal: null } : {}),
        ...(ends ? clearSuspension : {}),
        pastDueSince: nextPastDueSince(stripe.status, org.pastDueSince, now), ...keepIds,
      },
    });
    await ensureAllowance(tx, { organizationId: subject.id }, now);
    return {
      event: build(subject, from, plan, seats, premium),
      premiumEvents: premiumFlip(
        subject, plan === "team" ? plan : from,
        !!org.premiumVoice && premiumStatus(org.subscriptionStatus) && !org.premiumSuspendedAt,
        premium && premiumStatus(stripe.status) && !suspendedAfter,
        Math.min(qty, seats), stripe.status,
      ),
    };
  }
  const user = await tx.user.findUniqueOrThrow({ where: { id: subject.id }, select: { planTier: true, pastDueSince: true, premiumVoice: true, subscriptionStatus: true, stripeSubscriptionId: true, premiumSuspendedAt: true } });
  const userEnds = suspensionEnds(user.stripeSubscriptionId);
  const userSuspendedAfter = !!user.premiumSuspendedAt && !userEnds;
  from = isPlanTier(user.planTier) && user.planTier !== "team" ? user.planTier : "free";
  const plan: PlanTier = next.plan === "pro" ? "pro" : "free";
  const premium = plan === "pro" && next.premium;
  const qty = premium ? Math.max(0, next.premiumQuantity ?? 1) : 0;
  await tx.user.update({
    where: { id: subject.id },
    data: {
      planTier: plan, premiumVoice: premium, premiumVoiceQuantity: qty, subscriptionPeriodEnd: periodEnd,
      ...(premium ? {} : { premiumVoiceRemoveAt: null }),
      ...(userEnds ? clearSuspension : {}),
      pastDueSince: nextPastDueSince(stripe.status, user.pastDueSince, now), ...keepIds,
    },
  });
  await ensureAllowance(tx, { userId: subject.id }, now);
  return {
    event: build(subject, from, plan, 1, premium),
    premiumEvents: premiumFlip(
      subject, plan === "pro" ? plan : from,
      !!user.premiumVoice && premiumStatus(user.subscriptionStatus) && !user.premiumSuspendedAt,
      premium && premiumStatus(stripe.status) && !userSuspendedAfter,
      premium ? 1 : 0, stripe.status,
    ),
  };
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
  tx: Tx, subscriptionId: string, live: Live, hint: { customerId?: string | null; metadata?: Record<string, string> | null }, now: Date,
): Promise<Applied | null> {
  if (live === null) return null;
  if (live === "gone") {
    // Stripe no longer has it: the same as canceled, and only for the subject that still holds it.
    const holder = await subjectOfSubscription(tx, subscriptionId);
    return holder ? applyEntitlement(tx, holder, FREE, { customerId: hint.customerId, subscriptionId: null, status: "canceled" }, now) : null;
  }
  // "incomplete" (first payment pending or needs action) goes through like any other status: it is recorded and
  // linked, grants nothing (not entitled) and blocks a second checkout until it becomes active or expires.
  const found = entitlementFromItems(live.items.data.map((i) => ({
    quantity: i.quantity,
    priceId: i.price.id,
    priceType: i.price.type,
    usageType: i.price.recurring?.usage_type,
    interval: i.price.recurring?.interval,
    productMetadata: typeof i.price.product === "object" ? i.price.product?.metadata : null,
  })));
  if (!found) {
    // Items that fail validation never grant access, and they revoke it too: the subject whose CURRENT
    // subscription this is drops to Free (fail closed), whatever the status. A subscription nobody holds,
    // or an old one a newer subscription replaced, finds no holder and changes nothing. While Stripe is still
    // billing it (entitled status) the link is kept, so the account cannot start a second subscription.
    const holder = await subjectOfSubscription(tx, live.id);
    if (holder) return applyEntitlement(tx, holder, FREE, { customerId: live.customer, subscriptionId: live.id, status: live.status }, now);
    // Nobody holds it yet: a new purchase that failed validation. If Stripe is billing it, record the link
    // (without granting anything) so checkout is blocked and a duplicate is detected, as for a valid purchase.
    if (!blocksCheckout(live.status)) return null;
    const owner = await findSubject(tx, { subscriptionId: live.id, customerId: live.customer, metadata: { ...(hint.metadata ?? {}), ...(live.metadata ?? {}) } });
    if (!owner) return null;
    const heldByOwner = await currentSubscriptionId(tx, owner);
    if (heldByOwner && heldByOwner !== live.id) return { event: null, cancelSubscriptionId: live.id };
    return applyEntitlement(tx, owner, FREE, { customerId: live.customer, subscriptionId: live.id, status: live.status }, now);
  }
  const subject = await findSubject(tx, { subscriptionId: live.id, customerId: live.customer, metadata: { ...(hint.metadata ?? {}), ...(live.metadata ?? {}) } });
  if (!subject) return null;

  const held = await currentSubscriptionId(tx, subject);
  if (held && held !== live.id) {
    // The subject already has a different subscription. This one is either an old subscription's late
    // event (ignore it) or a duplicate purchase (cancel it so the customer is not billed twice).
    return isEntitled(live.status, null, now) ? { event: null, cancelSubscriptionId: live.id } : null;
  }
  // Grace counts from when the account first went past_due; a first sighting starts it now.
  const since = nextPastDueSince(live.status, await pastDueSinceOf(tx, subject), now);
  const next = isEntitled(live.status, since, now) ? found : FREE;
  // The stored status and period end feed the stricter Premium check at every mint (src/lib/premiumVoice.ts).
  const applied = await applyEntitlement(tx, subject, next, { customerId: live.customer, subscriptionId: live.id, status: live.status, periodEnd: periodEndOf(live) }, now);
  // Keep the add-on quantity equal to the seats after a seat change made outside the app. Only while Premium is on sale:
  // with the sale off no paid Premium is used, and nothing is written to Stripe for it.
  let sync = next.premium && premiumOnSale() ? addonQuantitySync(live) : null;
  // Only a Team decrease goes through the renewal schedule; anything else under a schedule waits (nothing written now).
  if (sync && live.schedule && !(sync.direction === "down" && subject.kind === "organization")) sync = null;
  if (!sync) return applied;
  if (sync.direction === "down" && subject.kind === "organization") {
    // A portal seat decrease: the add-on drops at renewal, not now. Until it has landed the Team keeps the Premium units
    // it is billed for (seatCountAtRenewal marks it; premiumSeatsForUnits reads it), then the next period gets the
    // target. Repeated deliveries write the same value, so they never extend or enlarge anything.
    await tx.organization.update({ where: { id: subject.id }, data: { seatCountAtRenewal: sync.quantity } });
    await ensureAllowance(tx, { organizationId: subject.id }, now);
  }
  return { ...applied, addonSync: sync, addonSyncSubject: subject };
}

const SubRef = z.union([z.string(), z.object({ id: z.string() })]).nullish();
const InvoiceObject = z.object({
  id: z.string().optional(),
  /** draft | open | paid | uncollectible | void. invoice.paid carries "paid". */
  status: z.string().nullish(),
  customer: z.union([z.string(), z.object({ id: z.string() })]).nullish(),
  /** Older API versions. */
  subscription: SubRef,
  /** Newer API versions (2025-03-31 and later) moved it under parent.subscription_details. */
  parent: z.object({ subscription_details: z.object({ subscription: SubRef }).nullish() }).nullish(),
});
const refId = (r: z.infer<typeof SubRef>): string | null => (typeof r === "string" ? r : r?.id ?? null);

/** The subscription an invoice belongs to, in either API shape. Null for a one-off invoice. */
export function invoiceSubscriptionId(obj: unknown): string | null {
  const parsed = InvoiceObject.safeParse(obj);
  if (!parsed.success) return null;
  return refId(parsed.data.subscription) ?? refId(parsed.data.parent?.subscription_details?.subscription);
}

type SuspensionRow = { premiumVoice: boolean; premiumSuspendedAt: Date | null; premiumSuspendedInvoiceId: string | null };
const SUSPENSION_SELECT = { premiumVoice: true, premiumSuspendedAt: true, premiumSuspendedInvoiceId: true } as const;

async function suspensionOf(tx: Tx, s: Subject): Promise<SuspensionRow | null> {
  return s.kind === "organization"
    ? tx.organization.findUnique({ where: { id: s.id }, select: SUSPENSION_SELECT })
    : tx.user.findUnique({ where: { id: s.id }, select: SUSPENSION_SELECT });
}

async function writeSuspension(tx: Tx, s: Subject, where: { premiumSuspendedInvoiceId?: string }, data: { premiumSuspendedAt: Date | null; premiumSuspendedInvoiceId: string | null }): Promise<number> {
  const w = { id: s.id, ...where };
  const r = s.kind === "organization" ? await tx.organization.updateMany({ where: w, data }) : await tx.user.updateMany({ where: w, data });
  return r.count;
}

/**
 * invoice.paid and invoice.payment_failed: re-read the subscription and apply it, like any other event. Then:
 * - payment_failed persists a Premium suspension (premiumSuspendedAt, and the failed invoice id) on the subject whose
 *   current subscription this is, so the NEXT call is Standard even while Stripe still reports `active`. The base plan
 *   keeps its past_due grace; the add-on flag and quantity stay as the items say.
 * - paid clears that suspension ONLY when the paid invoice is the one that failed, the invoice says `paid` (when it says
 *   anything), and the subscription as Stripe has it now is active (the Premium rule). No other event clears it: an unrelated
 *   customer.subscription.updated reporting `active` leaves Premium suspended (see applyEntitlement).
 * - stale_failure: a payment_failed whose invoice Stripe now reports paid or void (or no longer has). It was delivered
 *   after the recovery, so it changes nothing beyond the usual subscription reconcile; it never suspends.
 */
async function onInvoice(tx: Tx, obj: unknown, live: Live, now: Date, mode: "failed" | "paid" | "stale_failure"): Promise<Applied | null> {
  const failed = mode === "failed";
  const subscriptionId = invoiceSubscriptionId(obj);
  if (!subscriptionId) return null;
  const inv = InvoiceObject.safeParse(obj);
  const invoiceId = inv.success ? inv.data.id ?? null : null;
  const customerId = inv.success ? refId(inv.data.customer as z.infer<typeof SubRef>) : null;
  const applied = await reconcile(tx, subscriptionId, live, { customerId }, now);
  if (mode === "stale_failure") return applied;
  const holder = await subjectOfSubscription(tx, subscriptionId);
  if (!holder) return applied;
  const before = await suspensionOf(tx, holder);
  if (!before) return applied;
  const allowance = holder.kind === "organization" ? { organizationId: holder.id } : { userId: holder.id };

  if (failed) {
    // Keep the first suspension time; point it at the latest failed invoice, which is the one that must be paid.
    await writeSuspension(tx, holder, {}, { premiumSuspendedAt: before.premiumSuspendedAt ?? now, premiumSuspendedInvoiceId: invoiceId });
    await ensureAllowance(tx, allowance, now);
    // A flip already reported by reconcile (status no longer entitled) is not reported twice.
    const already = applied?.premiumEvents?.some((e) => e.name === "premium_removed") ?? false;
    const events = before.premiumVoice && !before.premiumSuspendedAt && !already
      ? [{ name: "premium_removed" as const, subject: holder.kind, subjectId: holder.id, reason: "payment_failed" }] : [];
    return { event: applied?.event ?? null, cancelSubscriptionId: applied?.cancelSubscriptionId, premiumEvents: [...(applied?.premiumEvents ?? []).filter((e) => e.name !== "premium_added"), ...events] };
  }

  const invoicePaid = !inv.success || inv.data.status == null || inv.data.status === "paid";
  const goodStanding = !!live && live !== "gone" && live.id === subscriptionId && premiumStatus(live.status);
  if (!before.premiumSuspendedAt || !invoiceId || !invoicePaid || !goodStanding) return applied;
  const cleared = await writeSuspension(tx, holder, { premiumSuspendedInvoiceId: invoiceId }, { premiumSuspendedAt: null, premiumSuspendedInvoiceId: null });
  if (cleared === 0) return applied;
  await ensureAllowance(tx, allowance, now);
  const events = before.premiumVoice ? [{ name: "premium_added" as const, subject: holder.kind, subjectId: holder.id, reason: "payment_recovered" }] : [];
  return { ...(applied ?? { event: null }), premiumEvents: [...(applied?.premiumEvents ?? []), ...events] };
}

async function onCheckoutPaid(tx: Tx, obj: unknown, live: Live, now: Date, requirePaid: boolean): Promise<Applied | null> {
  const s = SessionObject.parse(obj);
  if (s.mode && s.mode !== "subscription") return null;
  if (!s.subscription) return null;
  // A delayed payment method completes Checkout before the money arrives. Nothing is granted until Stripe says
  // the payment succeeded (async_payment_succeeded) or the subscription itself becomes active.
  if (requirePaid && s.payment_status === "unpaid") return null;
  return reconcile(tx, s.subscription, live, { customerId: s.customer, metadata: s.metadata }, now);
}

async function onSubscriptionChanged(tx: Tx, obj: unknown, live: Live, now: Date): Promise<Applied | null> {
  const sub = SubscriptionObject.pick({ id: true, customer: true, metadata: true }).parse(obj);
  return reconcile(tx, sub.id, live, { customerId: sub.customer, metadata: sub.metadata }, now);
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
  /** Used only for the add-on quantity sync. Optional so a caller that cannot write to Stripe simply skips it. */
  updateSubscription?(id: string, params: StripeParams, idempotencyKey: string): Promise<unknown>;
  /**
   * The invoice as Stripe has it now, read before a payment failure is acted on, so a failure event that arrives after
   * the invoice was already paid suspends nothing. Optional: without it the event body's own status is used.
   */
  retrieveInvoice?(id: string): Promise<unknown>;
  /**
   * Moves a Team's add-on quantity drop to renewal through the app's own subscription schedule. "scheduled" when it is
   * set up (or found already set up); "not_needed" when there is nothing left to lower or the plan ends anyway; or a
   * reason it cannot be done safely ("unsupported_terms": discounts, tax or collection settings a schedule would drop;
   * "schedule_conflict": someone else's schedule, or the app's own one changed outside the app). It never lowers
   * anything now. Optional: without it a decrease is left pending and fails for support, never applied at once.
   */
  scheduleAddonDecrease?(subject: { kind: "organization"; id: string }, subscriptionId: string, seats: number): Promise<AddonDecreaseOutcome>;
}

export type AddonDecreaseOutcome = "scheduled" | "not_needed" | "unsupported_terms" | "schedule_conflict";

/**
 * A portal seat decrease whose renewal schedule cannot be set up safely. Thrown after the event's own changes have
 * committed (the paid quantity and pool are kept, the pending target is recorded on seatCountAtRenewal and an audit row
 * `billing.addon_decrease_needs_support` names the reason), so the webhook answers 500: the event stays unacknowledged,
 * shows as failing in the Stripe dashboard, and Stripe retries it. Nothing is lowered and no schedule is overwritten.
 */
export class AddonDecreaseNeedsSupport extends Error {
  constructor(public reason: "unsupported_terms" | "schedule_conflict" | "not_configured") {
    super(`add-on decrease at renewal needs support: ${reason}`);
    this.name = "AddonDecreaseNeedsSupport";
  }
}

/** What the audit row and the log say, per reason. Operator-facing; no Stripe ids, amounts or provider bodies. */
const NEEDS_SUPPORT_ACTION: Record<AddonDecreaseNeedsSupport["reason"], string> = {
  unsupported_terms: "The subscription has discounts, tax or collection settings a renewal schedule would drop. Lower the Premium voice add-on to the seat count for the next period in the Stripe Dashboard, keeping those terms, then let the webhook retry.",
  schedule_conflict: "Another schedule is on the subscription (or the app's own one was changed outside the app). Review it in the Stripe Dashboard, add the Premium voice quantity change for renewal there or release it, then let the webhook retry.",
  not_configured: "This server cannot schedule add-on changes. Lower the Premium voice add-on for the next period in the Stripe Dashboard.",
};
const liveDeps: StripeDeps = {
  retrieveSubscription: (id) => stripeApi.retrieveSubscription(id),
  cancelSubscription: (id) => stripeApi.cancelSubscription(id),
  updateSubscription: (id, params, key) => stripeApi.updateSubscription(id, params, key),
  retrieveInvoice: (id) => stripeApi.retrieveInvoice(id),
  // Loaded when used: premiumAddon imports this module, so a static import would be circular.
  scheduleAddonDecrease: async (subject, subscriptionId, seats) => (await import("./premiumAddon")).scheduleAddonSeatsAtRenewal(subject, subscriptionId, seats),
};

/** What a failed invoice is now: "open" (still owed), "settled" (paid or void: nothing owed), or "gone". */
type InvoiceNow = "owed" | "settled" | "gone";

/**
 * Reads the invoice's CURRENT status before the database transaction, like fetchLive. paid and void owe nothing, so
 * a payment_failed for them is stale. A 404 also owes nothing. Any other read failure throws: the webhook answers 500
 * and Stripe retries, with nothing written.
 */
async function fetchInvoiceNow(id: string | null, bodyStatus: string | null | undefined, deps: StripeDeps): Promise<InvoiceNow> {
  const settledStatus = (s: unknown) => s === "paid" || s === "void";
  if (!id || !deps.retrieveInvoice) return settledStatus(bodyStatus) ? "settled" : "owed";
  try {
    const inv = z.object({ id: z.string(), status: z.string().nullish() }).parse(await deps.retrieveInvoice(id));
    return settledStatus(inv.status) ? "settled" : "owed";
  } catch (e) {
    if (e instanceof StripeApiError && e.status === 404) return "gone";
    throw e;
  }
}

/**
 * The Stripe write that puts the add-on back in step with the seats. The idempotency key names ONE transition: the
 * subscription, the item, the quantity it moves from and to, and the trigger (the Stripe event id, or the app's own sync).
 * A retried delivery of the same event sends the same key, so Stripe applies it once. A later, separate change (3 to 4,
 * back to 3, then to 4 again) comes from a different event, so it gets a new key and is never answered from the cache
 * of an earlier request for the same quantity.
 */
export function addonSyncRequest(s: AddonSync, trigger: string): { id: string; params: StripeParams; idempotencyKey: string } {
  return {
    id: s.subscriptionId,
    params: { items: [{ id: s.itemId, quantity: s.quantity }], proration_behavior: s.direction === "up" ? "create_prorations" : "none" },
    idempotencyKey: `addon-sync:${s.subscriptionId}:${s.itemId}:${s.from}-${s.quantity}:${trigger}`.slice(0, 255),
  };
}

/** Events whose subscription is re-read from Stripe before anything is granted or revoked. */
const RECONCILED = new Set(["checkout.session.completed", "checkout.session.async_payment_succeeded", "customer.subscription.updated", "invoice.paid", "invoice.payment_failed"]);

function subscriptionIdOf(event: StripeEventLike): string | null {
  const o = event.data.object as { id?: unknown; subscription?: unknown } | undefined;
  if (event.type.startsWith("checkout.session.")) return typeof o?.subscription === "string" ? o.subscription : null;
  if (event.type.startsWith("invoice.")) return invoiceSubscriptionId(o);
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
 * Cancelling a duplicate subscription happens after commit; if that call fails the event id is dropped so
 * Stripe's 500 retry can cancel again.
 */
export async function handleStripeEvent(event: StripeEventLike, now = new Date(), deps: StripeDeps = liveDeps): Promise<EventResult> {
  if ((await prisma.stripeEvent.findUnique({ where: { id: event.id } })) !== null) return "duplicate";
  const live = RECONCILED.has(event.type) ? await fetchLive(subscriptionIdOf(event), deps) : null;
  // A payment failure is acted on only if the invoice is still owed NOW: Stripe can deliver payment_failed after the
  // invoice.paid that settled it, and an old failure must not suspend a recovered subscriber.
  let invoiceNow: InvoiceNow = "owed";
  if (event.type === "invoice.payment_failed") {
    const inv = InvoiceObject.safeParse(event.data.object);
    invoiceNow = await fetchInvoiceNow(inv.success ? inv.data.id ?? null : null, inv.success ? inv.data.status : null, deps);
  }
  let applied: Applied | null = null;
  try {
    applied = await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({ data: { id: event.id, type: event.type } });
      switch (event.type) {
        case "checkout.session.completed": return onCheckoutPaid(tx, event.data.object, live, now, true);
        case "checkout.session.async_payment_succeeded": return onCheckoutPaid(tx, event.data.object, live, now, false);
        case "customer.subscription.updated": return onSubscriptionChanged(tx, event.data.object, live, now);
        case "customer.subscription.deleted": return onSubscriptionDeleted(tx, event.data.object, now);
        // Payment results re-read the subscription; a failure also turns Premium off for the next call at once.
        case "invoice.paid": return onInvoice(tx, event.data.object, live, now, "paid");
        case "invoice.payment_failed": return onInvoice(tx, event.data.object, live, now, invoiceNow === "owed" ? "failed" : "stale_failure");
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
  try {
    // The event id is the trigger: Stripe's retry of this event repeats the same add-on sync key, a later event does not.
    await afterApplied(applied, deps, event.id);
  } catch (e) {
    // Cancel and add-on sync run after commit. Drop the event id so Stripe's 500 retry can do them again.
    if (applied?.cancelSubscriptionId || applied?.addonSync) {
      await prisma.stripeEvent.deleteMany({ where: { id: event.id } }).catch(() => undefined);
    }
    throw e;
  }
  return applied ? "processed" : "ignored";
}

/** The work that must wait until the transaction has committed: dropping a duplicate subscription, then the lifecycle event. */
async function afterApplied(applied: Applied | null, deps: StripeDeps, trigger: string): Promise<void> {
  if (applied?.cancelSubscriptionId) {
    try {
      await deps.cancelSubscription(applied.cancelSubscriptionId);
    } catch (e) {
      console.error("[stripe] duplicate subscription cancel failed", e instanceof StripeApiError ? `status ${e.status}` : "error");
      throw e;
    }
  }
  let syncNow = !!applied?.addonSync;
  const sync = applied?.addonSync;
  const owner = applied?.addonSyncSubject;
  if (sync && sync.direction === "down" && owner?.kind === "organization") {
    // A Team's portal seat decrease waits for renewal. It is NEVER applied now: the paid quantity and pool stay until the
    // renewal schedule lowers them. A failure that may have left the app's own schedule half set up throws, so Stripe's
    // retry resumes it through the lease and the exact baseline (reconcile routes the retry to it). A setup that cannot
    // be done safely keeps everything and fails visibly for support.
    syncNow = false;
    let outcome: AddonDecreaseOutcome;
    try {
      outcome = deps.scheduleAddonDecrease ? await deps.scheduleAddonDecrease({ kind: "organization", id: owner.id }, sync.subscriptionId, sync.quantity) : "unsupported_terms";
    } catch (e) {
      console.error("[stripe] add-on decrease at renewal failed", e instanceof StripeApiError ? `status ${e.status}` : e instanceof Error ? e.name : "error");
      throw e;
    }
    if (outcome === "unsupported_terms" || outcome === "schedule_conflict") {
      const reason = deps.scheduleAddonDecrease ? outcome : "not_configured";
      console.error("[stripe] add-on decrease at renewal needs support:", reason, "; the paid Premium quantity is kept and nothing was changed");
      await prisma.auditEvent.create({
        data: {
          action: "billing.addon_decrease_needs_support", resource: `organization:${owner.id}`,
          metadata: { reason, pendingSeats: sync.quantity, addonQuantity: sync.from, trigger, action: NEEDS_SUPPORT_ACTION[reason] },
        },
      }).catch(() => undefined);
      throw new AddonDecreaseNeedsSupport(reason);
    }
  }
  if (sync && syncNow && deps.updateSubscription) {
    const req = addonSyncRequest(sync, trigger);
    try {
      await deps.updateSubscription(req.id, req.params, req.idempotencyKey);
    } catch (e) {
      console.error("[stripe] add-on quantity sync failed", e instanceof StripeApiError ? `status ${e.status}` : "error");
      throw e;
    }
  }
  if (applied?.event) await emitBillingLifecycle(applied.event);
  for (const e of applied?.premiumEvents ?? []) await emitPremiumEvent(e);
}

/**
 * Re-reads one subscription from Stripe and applies it now, as a webhook would. Used right after the app itself changed
 * the subscription (Premium added, seats changed) so the page does not wait for the webhook. Idempotent with it.
 */
export async function syncSubscriptionNow(subscriptionId: string, now = new Date(), deps: StripeDeps = liveDeps): Promise<void> {
  const live = await fetchLive(subscriptionId, deps);
  const applied = await prisma.$transaction((tx) => reconcile(tx, subscriptionId, live, {}, now));
  // No Stripe event here: the app's own sync is its own trigger.
  await afterApplied(applied, deps, `app-sync-${now.getTime()}`);
}

/**
 * Applies a completed Checkout Session without waiting for its webhook. Reconciliation depends only on the
 * subscription as Stripe has it now, so running it again when the webhook arrives changes nothing.
 */
async function applyCompletedCheckout(session: z.infer<typeof SessionObject>, now: Date, deps: StripeDeps): Promise<void> {
  const live = await fetchLive(session.subscription ?? null, deps);
  const applied = await prisma.$transaction((tx) => onCheckoutPaid(tx, session, live, now, true));
  await afterApplied(applied, deps, `checkout-${session.id ?? now.getTime()}`);
}
