import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { itemKind, parseLiveSubscription, periodEndOf, resolvePriceIds, syncSubscriptionNow, type Interval, type LiveSubscription, type PriceIds } from "./billing";
import { stripeApi, type StripeParams } from "./stripe";
import { PREMIUM_STATUSES } from "./premiumVoice";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "./usagePlan";

/**
 * Premium Voice on an EXISTING subscription, and Team seat changes that keep the add-on quantity in step.
 * Checkout only sells new subscriptions (and answers 409 for an account that already has one), so this is the path
 * for current payers.
 *
 * - Add Premium: preview first (Stripe's prorated invoice preview plus the new renewal total), then an explicit confirm
 *   that carries the server-signed preview token. The token binds the reviewed charge AND the billing terms behind it
 *   (status, period, every item's price, unit amount, quantity and currency, discounts, tax settings, the add-on price).
 *   At confirm the server re-reads the subscription and re-runs the same preview at the same proration_date; any change
 *   in terms or in the amount, currency, total or balance refuses the change and nothing is charged. Only then does it
 *   update with that proration_date, always_invoice, payment_behavior=error_if_incomplete and an idempotency key derived
 *   from the token, so a double submit makes one change.
 * - Remove Premium and seat decreases: at the period end through a NEW subscription schedule made from the subscription
 *   (current phase unchanged, next phase with the new items, then released). The app never edits an existing schedule:
 *   any schedule already on the subscription (its own or anyone's) is refused with a clear message, so no later phase,
 *   end behavior or phase setting is ever overwritten. A subscription with discounts, tax rates, automatic tax or a
 *   non-default collection method is refused too, because the app would not carry those into the scheduled phases.
 * - Seats up: base and add-on quantity change together now, prorated, with the same preview binding as Premium.
 *
 * Every Stripe call goes through `deps`, so tests run on mocks and nothing here calls Stripe in CI.
 */

export interface AddonDeps {
  retrieveSubscription(id: string): Promise<unknown>;
  retrievePrice(id: string): Promise<unknown>;
  previewInvoice(params: StripeParams): Promise<unknown>;
  updateSubscription(id: string, params: StripeParams, idempotencyKey: string): Promise<unknown>;
  createSubscriptionSchedule(params: StripeParams, idempotencyKey: string): Promise<unknown>;
  retrieveSubscriptionSchedule(id: string): Promise<unknown>;
  updateSubscriptionSchedule(id: string, params: StripeParams, idempotencyKey: string): Promise<unknown>;
  releaseSubscriptionSchedule(id: string, idempotencyKey: string): Promise<unknown>;
  prices(): Promise<PriceIds>;
  /** Re-read and apply the subscription now (src/lib/billing.ts syncSubscriptionNow). */
  sync(subscriptionId: string): Promise<void>;
}

export const liveAddonDeps: AddonDeps = {
  retrieveSubscription: (id) => stripeApi.retrieveSubscription(id),
  retrievePrice: (id) => stripeApi.retrievePrice(id),
  previewInvoice: (p) => stripeApi.previewInvoice(p),
  updateSubscription: (id, p, k) => stripeApi.updateSubscription(id, p, k),
  createSubscriptionSchedule: (p, k) => stripeApi.createSubscriptionSchedule(p, k),
  retrieveSubscriptionSchedule: (id) => stripeApi.retrieveSubscriptionSchedule(id),
  updateSubscriptionSchedule: (id, p, k) => stripeApi.updateSubscriptionSchedule(id, p, k),
  releaseSubscriptionSchedule: (id, k) => stripeApi.releaseSubscriptionSchedule(id, k),
  prices: () => resolvePriceIds(),
  sync: (id) => syncSubscriptionNow(id),
};

/** The billing subject the actor may change: a Pro user's own subscription, or a Team organization (owner only). */
export interface AddonSubject {
  kind: "user" | "organization";
  id: string;
  plan: "pro" | "team";
  subscriptionId: string;
  /** Seats the app has on record (Pro is 1). */
  seats: number;
}

export type AddonErrorCode =
  | "already_added" | "not_added" | "price_not_configured" | "not_in_good_standing" | "change_scheduled"
  | "subscription_changed" | "price_changed" | "unsupported_billing_terms"
  | "invalid_token" | "invalid_seats" | "no_change" | "not_team" | "token_not_configured";

export class AddonError extends Error {
  constructor(public code: AddonErrorCode, message: string) {
    super(message);
  }
}

const SCHEDULE_EXISTS = "This plan already has a scheduled change in Stripe that the app cannot safely edit. Nothing was changed. Resolve it in Manage billing or contact support, then try again.";
const UNSUPPORTED_TERMS = "This plan has discounts or tax settings the app cannot carry into a scheduled change. Nothing was changed. Make this change in Manage billing or contact support.";
const PRICE_CHANGED = "The price changed since you reviewed it. Nothing was charged. Review the new price, then confirm.";
const TERMS_CHANGED = "Your plan or its billing terms changed since the preview. Nothing was charged. Review the price again, then confirm.";

// ---- Pure helpers ------------------------------------------------------------------------------------

type Item = LiveSubscription["items"]["data"][number];

/** The base plan item and the add-on item of a subscription, by product metadata. */
export function splitItems(live: LiveSubscription): { base: Item | null; premium: Item | null; interval: Interval | null } {
  let base: Item | null = null;
  let premium: Item | null = null;
  for (const it of live.items.data) {
    const kind = itemKind(it.price);
    if (kind === "pro" || kind === "team") base = it;
    else if (kind === "premium" && (it.quantity ?? 1) > 0) premium = it;
  }
  const iv = base?.price.recurring?.interval;
  return { base, premium, interval: iv === "month" || iv === "year" ? iv : null };
}

const inGoodStanding = (live: LiveSubscription) => (PREMIUM_STATUSES as readonly string[]).includes(live.status);
const scheduleId = (live: LiveSubscription): string | null => (typeof live.schedule === "string" ? live.schedule : live.schedule?.id ?? null);

/** Add-on quantity for a plan: Pro is always 1; Team equals the seats on the base item. */
export const addonQuantity = (plan: "pro" | "team", baseQuantity: number): number => (plan === "pro" ? 1 : Math.max(TEAM_MIN_SEATS, Math.floor(baseQuantity)));

/**
 * What adding Premium to this subscription means: the add-on price on the SAME interval as the base plan, quantity =
 * seats (Pro 1). Throws AddonError when it cannot be added (already on it, not in good standing, a change is already
 * scheduled, or the price is not configured).
 */
export function planAddPremium(live: LiveSubscription, prices: PriceIds, plan: "pro" | "team"): { priceId: string; quantity: number; interval: Interval } {
  const { base, premium, interval } = splitItems(live);
  if (premium) throw new AddonError("already_added", "Premium voice is already on this plan.");
  if (!inGoodStanding(live)) throw new AddonError("not_in_good_standing", "Premium voice can be added once your plan is paid up. Update your card in Manage billing, then try again.");
  if (scheduleId(live)) throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  if (live.cancel_at_period_end) {
    throw new AddonError("change_scheduled", "This plan is set to end at the end of the billing period. Nothing was changed. Resume it in Manage billing, then add Premium voice.");
  }
  if (!base || !interval) throw new AddonError("price_not_configured", "Premium voice is not available for this plan right now.");
  const priceId = prices.premium[interval];
  if (!priceId) throw new AddonError("price_not_configured", "Premium voice is not available for this plan right now.");
  return { priceId, quantity: addonQuantity(plan, base.quantity ?? 1), interval };
}

/** Cents a renewal bills before tax and discounts: each item's unit amount times its quantity, plus any added items. */
export function renewalTotal(live: LiveSubscription, changes: { itemId?: string; priceUnit?: number | null; quantity: number }[] = []): number | null {
  let total = 0;
  for (const it of live.items.data) {
    const change = changes.find((c) => c.itemId && c.itemId === it.id);
    const unit = it.price.unit_amount;
    if (unit == null) return null;
    total += unit * (change ? change.quantity : it.quantity ?? 1);
  }
  for (const c of changes) {
    if (c.itemId) continue;
    if (c.priceUnit == null) return null;
    total += c.priceUnit * c.quantity;
  }
  return total;
}

/** A stable label for a Stripe reference that may arrive as an id or an expanded object. */
const refLabel = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" ? (v as { id: string }).id : JSON.stringify(v ?? null));
const refs = (list: unknown[] | null | undefined): string[] => (list ?? []).map(refLabel).sort();

/**
 * Hash of every billing term that decides what a change costs now and at renewal: status, period, cancel and schedule
 * state, discounts, tax settings, collection method, and each item's id, price, unit amount, currency, interval,
 * quantity, tax rates and discounts, plus any extra terms (the add-on price and its unit amount). Bound into the signed
 * preview and recomputed at confirm.
 */
export function billingTermsHash(live: LiveSubscription, extra: Record<string, string | number | null> = {}): string {
  const items = live.items.data.map((i) => ({
    id: i.id ?? null, price: i.price.id, unit: i.price.unit_amount ?? null, currency: i.price.currency ?? null,
    interval: i.price.recurring?.interval ?? null, quantity: i.quantity ?? 1, tax: refs(i.tax_rates), discounts: refs(i.discounts),
  })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const terms = {
    sub: live.id, status: live.status, start: live.current_period_start ?? null, end: periodEndOf(live)?.getTime() ?? null,
    cancel: !!live.cancel_at_period_end, schedule: scheduleId(live), discount: live.discount ? refLabel(live.discount) : null,
    discounts: refs(live.discounts), tax: refs(live.default_tax_rates), autoTax: !!live.automatic_tax?.enabled,
    collection: live.collection_method ?? null, items, extra,
  };
  return createHash("sha256").update(JSON.stringify(terms)).digest("hex");
}

/** True when a scheduled phase made by the app would drop terms the subscription has (so it must be refused). */
export function hasTermsScheduleCannotCarry(live: LiveSubscription): boolean {
  if (live.discount || (live.discounts?.length ?? 0) > 0) return true;
  if ((live.default_tax_rates?.length ?? 0) > 0 || live.automatic_tax?.enabled) return true;
  if (live.collection_method && live.collection_method !== "charge_automatically") return true;
  return live.items.data.some((i) => (i.tax_rates?.length ?? 0) > 0 || (i.discounts?.length ?? 0) > 0);
}

// ---- Preview tokens ------------------------------------------------------------------------------------

const TOKEN_VERSION = "premium-change-v2";
/** A preview is good for this long; after that the owner previews again so the charge shown is still the charge made. */
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_TOKEN_CHARS = 2048;
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);

const TokenItem = z.object({ id: z.string().max(255).optional(), price: z.string().max(255).optional(), quantity: z.number().int().min(0).max(TEAM_MAX_SEATS) });
const TokenPayload = z.object({
  v: z.literal(TOKEN_VERSION),
  k: z.enum(["add", "seats"]),
  s: z.string().max(200),
  u: z.string().max(200),
  sub: z.string().max(255),
  items: z.array(TokenItem).min(1).max(4),
  /** proration_date, unix seconds (0 for a change that waits for renewal). */
  d: z.number().int(),
  /** amount_due of the reviewed preview, cents (0 when nothing is charged now). */
  a: z.number().int(),
  /** currency of the reviewed preview. */
  c: z.string().max(10),
  /** Hash of the reviewed preview's charge fields (amount due, total, subtotal, balances, currency). */
  q: HEX64,
  /** Hash of the billing terms behind the review (billingTermsHash). */
  h: HEX64,
  exp: z.number().int(),
});
export type PreviewToken = z.infer<typeof TokenPayload>;

const tokenKey = () => process.env.JWT_SECRET?.trim() || undefined;
const tokenMac = (key: string, body: string) => createHmac("sha256", key).update(`${TOKEN_VERSION}:${body}`).digest("hex");

export function signPreviewToken(p: Omit<PreviewToken, "v">, key = tokenKey()): string {
  if (!key) throw new AddonError("token_not_configured", "Billing changes need JWT_SECRET on the server.");
  const body = Buffer.from(JSON.stringify({ v: TOKEN_VERSION, ...p })).toString("base64url");
  return `${body}.${tokenMac(key, body)}`;
}

/** The preview this token was signed for, when it is ours, for this actor and subject, and not expired. Else null. */
export function readPreviewToken(token: unknown, expect: { userId: string; subject: string; kind: PreviewToken["k"] }, nowMs = Date.now(), key = tokenKey()): PreviewToken | null {
  if (!key || typeof token !== "string" || token.length > MAX_TOKEN_CHARS) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[0-9a-f]{64}$/.test(sig)) return null;
  if (!timingSafeEqual(Buffer.from(tokenMac(key, body), "hex"), Buffer.from(sig, "hex"))) return null;
  let parsed: PreviewToken;
  try {
    parsed = TokenPayload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    return null;
  }
  if (parsed.u !== expect.userId || parsed.s !== expect.subject || parsed.k !== expect.kind) return null;
  if (parsed.exp * 1000 <= nowMs) return null;
  return parsed;
}

const idemKey = (scope: string, token: string) => `${scope}:${createHash("sha256").update(token).digest("hex").slice(0, 48)}`;
const subjectKey = (s: AddonSubject) => `${s.kind}:${s.id}`;

// ---- Stripe response shapes ------------------------------------------------------------------------------

const PreviewObject = z.object({
  amount_due: z.number().int(),
  currency: z.string().optional(),
  total: z.number().int().nullish(),
  subtotal: z.number().int().nullish(),
  starting_balance: z.number().int().nullish(),
  ending_balance: z.number().int().nullish(),
});
type InvoicePreview = z.infer<typeof PreviewObject>;
const previewHash = (p: InvoicePreview) => createHash("sha256").update(JSON.stringify({
  amount_due: p.amount_due, currency: p.currency ?? null, total: p.total ?? null, subtotal: p.subtotal ?? null,
  starting_balance: p.starting_balance ?? null, ending_balance: p.ending_balance ?? null,
})).digest("hex");
const ZERO_PREVIEW = previewHash({ amount_due: 0 });

const PriceUnit = z.object({ unit_amount: z.number().int().nullish() });
const SchedulePhase = z.object({
  start_date: z.number(),
  end_date: z.number().nullish(),
  items: z.array(z.object({ price: z.union([z.string(), z.object({ id: z.string() })]), quantity: z.number().nullish() })),
});
const ScheduleObject = z.object({ id: z.string(), phases: z.array(SchedulePhase) });

export interface ChangePreview {
  /** Signed; send it back to confirm. Opaque to the browser. */
  token: string;
  /** Cents charged now (prorated), 0 for a change that waits for renewal. */
  dueNow: number;
  /** Cents the next renewal bills for the whole subscription after the change, before tax and discounts. Null if unknown. */
  renewalTotal: number | null;
  currency: string;
  interval: Interval;
  /** ISO date of the next renewal. */
  renewsAt: string | null;
  quantity: number;
}

async function loadLive(subject: AddonSubject, deps: AddonDeps): Promise<LiveSubscription> {
  const live = parseLiveSubscription(await deps.retrieveSubscription(subject.subscriptionId));
  if (live.id !== subject.subscriptionId) throw new AddonError("subscription_changed", "Your plan changed. Reload the page and try again.");
  return live;
}

async function runPreview(deps: AddonDeps, live: LiveSubscription, items: StripeParams[], prorationDate: number): Promise<InvoicePreview> {
  return PreviewObject.parse(await deps.previewInvoice({
    subscription: live.id,
    subscription_details: { items, proration_behavior: "always_invoice", proration_date: prorationDate },
  }));
}

/**
 * The confirm-time check every charged change goes through: the terms the owner reviewed are still the terms (else
 * terms changed), and the same preview at the same proration_date still gives the same charge (else price changed).
 */
async function recheckCharge(t: PreviewToken, deps: AddonDeps, live: LiveSubscription, items: StripeParams[], extra: Record<string, string | number | null>): Promise<void> {
  if (billingTermsHash(live, extra) !== t.h) throw new AddonError("subscription_changed", TERMS_CHANGED);
  const again = await runPreview(deps, live, items, t.d);
  if (again.amount_due !== t.a || (again.currency ?? t.c) !== t.c || previewHash(again) !== t.q) throw new AddonError("price_changed", PRICE_CHANGED);
}

// ---- Add Premium -------------------------------------------------------------------------------------------

async function addTerms(deps: AddonDeps, priceId: string): Promise<{ extra: Record<string, string | number | null>; unit: number | null }> {
  const unit = PriceUnit.safeParse(await deps.retrievePrice(priceId));
  const unitAmount = unit.success ? unit.data.unit_amount ?? null : null;
  return { extra: { addonPrice: priceId, addonUnit: unitAmount }, unit: unitAmount };
}

export async function previewAddPremium(subject: AddonSubject, userId: string, deps: AddonDeps = liveAddonDeps, now = new Date()): Promise<ChangePreview> {
  const live = await loadLive(subject, deps);
  const add = planAddPremium(live, await deps.prices(), subject.plan);
  const prorationDate = Math.floor(now.getTime() / 1000);
  const items = [{ price: add.priceId, quantity: add.quantity }];
  const preview = await runPreview(deps, live, items, prorationDate);
  const { extra, unit } = await addTerms(deps, add.priceId);
  const end = periodEndOf(live);
  const currency = preview.currency ?? live.items.data[0]?.price.currency ?? "usd";
  const token = signPreviewToken({
    k: "add", s: subjectKey(subject), u: userId, sub: live.id, items, d: prorationDate, a: preview.amount_due, c: currency,
    q: previewHash(preview), h: billingTermsHash(live, extra), exp: Math.floor((now.getTime() + PREVIEW_TTL_MS) / 1000),
  });
  return {
    token,
    dueNow: preview.amount_due,
    renewalTotal: renewalTotal(live, [{ priceUnit: unit, quantity: add.quantity }]),
    currency,
    interval: add.interval,
    renewsAt: end ? end.toISOString() : null,
    quantity: add.quantity,
  };
}

/**
 * Applies a confirmed preview, only if it is still exactly what was reviewed: same add-on price and quantity, same
 * billing terms, and the same charge from a fresh preview at the reviewed proration_date. Otherwise nothing is charged.
 */
export async function confirmAddPremium(subject: AddonSubject, userId: string, token: string, deps: AddonDeps = liveAddonDeps, now = new Date()): Promise<{ added: true; quantity: number }> {
  const t = readPreviewToken(token, { userId, subject: subjectKey(subject), kind: "add" }, now.getTime());
  if (!t || t.sub !== subject.subscriptionId) throw new AddonError("invalid_token", "This preview expired. Review the price again, then confirm.");
  const live = await loadLive(subject, deps);
  const add = planAddPremium(live, await deps.prices(), subject.plan);
  const [item] = t.items;
  if (item.price !== add.priceId || item.quantity !== add.quantity) throw new AddonError("subscription_changed", TERMS_CHANGED);
  const items = [{ price: add.priceId, quantity: add.quantity }];
  const { extra } = await addTerms(deps, add.priceId);
  await recheckCharge(t, deps, live, items, extra);
  await deps.updateSubscription(live.id, {
    items,
    proration_behavior: "always_invoice",
    proration_date: t.d,
    payment_behavior: "error_if_incomplete",
    metadata: { premium: "true" },
  }, idemKey("premium-add", token));
  await deps.sync(live.id);
  return { added: true, quantity: add.quantity };
}

// ---- Scheduled changes (removal, seat decrease) --------------------------------------------------------------

type PhaseItem = { price: string; quantity: number };

/** Refuses what the app cannot schedule safely: any existing schedule, or terms a scheduled phase would drop. */
function assertSchedulable(live: LiveSubscription): void {
  if (scheduleId(live)) throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  if (hasTermsScheduleCannotCarry(live)) throw new AddonError("unsupported_billing_terms", UNSUPPORTED_TERMS);
}

/**
 * Makes a NEW schedule from the subscription and sets its next phase (from the current period end, one period, then
 * released) to `nextItems(currentItems)`. Never edits an existing schedule (assertSchedulable). If the new schedule does
 * not look exactly like the subscription (one phase ending at the current period end), it is released at once and
 * nothing changes. Proration is off for both phases: nothing is credited or charged now.
 */
async function scheduleAtRenewal(live: LiveSubscription, nextItems: (items: PhaseItem[]) => PhaseItem[], scope: string, deps: AddonDeps): Promise<Date> {
  assertSchedulable(live);
  const end = periodEndOf(live);
  if (!end) throw new AddonError("subscription_changed", "Your renewal date could not be read. Try again in a moment.");
  const endSec = Math.floor(end.getTime() / 1000);
  const key = `${scope}:${live.id}:${endSec}`;
  const id = z.object({ id: z.string() }).parse(await deps.createSubscriptionSchedule({ from_subscription: live.id }, `${key}:create`)).id;
  const schedule = ScheduleObject.parse(await deps.retrieveSubscriptionSchedule(id));
  const [current] = schedule.phases;
  if (schedule.phases.length !== 1 || !current || current.end_date !== endSec) {
    await deps.releaseSubscriptionSchedule(id, `${key}:release`);
    throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  }
  const currentItems: PhaseItem[] = current.items.map((i) => ({ price: typeof i.price === "string" ? i.price : i.price.id, quantity: i.quantity ?? 1 }));
  const next = nextItems(currentItems).filter((i) => i.quantity > 0);
  await deps.updateSubscriptionSchedule(id, {
    end_behavior: "release",
    phases: [
      { items: currentItems, start_date: current.start_date, end_date: endSec, proration_behavior: "none" },
      { items: next, iterations: 1, proration_behavior: "none" },
    ],
  }, `${key}:update:${createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 16)}`);
  return end;
}

/** Price ids that are the Premium add-on on this subscription or on the allowlist. */
function premiumPriceIds(live: LiveSubscription, prices: PriceIds): Set<string> {
  const ids = new Set<string>();
  for (const it of live.items.data) if (itemKind(it.price) === "premium") ids.add(it.price.id);
  for (const id of [prices.premium.month, prices.premium.year]) if (id) ids.add(id);
  return ids;
}

/**
 * Schedules the add-on to leave at the period end. Premium stays until then. A subscription already set to cancel at
 * period end needs no schedule: everything ends on that date. Returns when Premium ends.
 */
export async function scheduleRemovePremium(subject: AddonSubject, deps: AddonDeps = liveAddonDeps): Promise<{ removeAt: Date | null }> {
  const live = await loadLive(subject, deps);
  const { premium } = splitItems(live);
  if (!premium) throw new AddonError("not_added", "Premium voice is not on this plan.");
  if (live.cancel_at_period_end && !scheduleId(live)) return { removeAt: periodEndOf(live) };
  const ids = premiumPriceIds(live, await deps.prices());
  const at = await scheduleAtRenewal(live, (items) => items.filter((i) => !ids.has(i.price)), "premium-remove", deps);
  return { removeAt: at };
}

// ---- Seats ----------------------------------------------------------------------------------------------------

export type SeatPreview = ChangePreview & { direction: "up" | "down"; effectiveAt: string | null; token: string };

function checkSeats(subject: AddonSubject, seats: number, live: LiveSubscription) {
  if (subject.plan !== "team") throw new AddonError("not_team", "Seats can only be changed on a Team plan.");
  if (!Number.isInteger(seats) || seats < TEAM_MIN_SEATS || seats > TEAM_MAX_SEATS) {
    throw new AddonError("invalid_seats", `Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.`);
  }
  if (!inGoodStanding(live)) throw new AddonError("not_in_good_standing", "Seats can be changed once your plan is paid up. Update your card in Manage billing, then try again.");
  const { base, premium } = splitItems(live);
  if (!base?.id) throw new AddonError("subscription_changed", "Your plan changed. Reload the page and try again.");
  const current = base.quantity ?? 1;
  if (seats === current) throw new AddonError("no_change", "That is already your seat count.");
  return { base, premium, current };
}

/** Item updates for a seat change: the base item and, when present, the add-on item move to the same quantity. */
export function seatItems(base: Item, premium: Item | null, seats: number): { id: string; quantity: number }[] {
  return [{ id: base.id!, quantity: seats }, ...(premium?.id ? [{ id: premium.id, quantity: seats }] : [])];
}

export async function previewSeatChange(subject: AddonSubject, userId: string, seats: number, deps: AddonDeps = liveAddonDeps, now = new Date()): Promise<SeatPreview> {
  const live = await loadLive(subject, deps);
  const { base, premium, current } = checkSeats(subject, seats, live);
  const end = periodEndOf(live);
  const items = seatItems(base, premium, seats);
  const iv = base.price.recurring?.interval === "year" ? "year" : "month";
  const total = renewalTotal(live, items.map((i) => ({ itemId: i.id, quantity: i.quantity })));
  const currency = base.price.currency ?? "usd";
  const exp = Math.floor((now.getTime() + PREVIEW_TTL_MS) / 1000);
  if (seats < current) {
    // A decrease waits for renewal: nothing is charged or credited now. Refused up front if it can't be scheduled safely.
    assertSchedulable(live);
    const token = signPreviewToken({ k: "seats", s: subjectKey(subject), u: userId, sub: live.id, items, d: 0, a: 0, c: currency, q: ZERO_PREVIEW, h: billingTermsHash(live), exp });
    return { token, dueNow: 0, renewalTotal: total, currency, interval: iv, renewsAt: end?.toISOString() ?? null, quantity: seats, direction: "down", effectiveAt: end?.toISOString() ?? null };
  }
  if (scheduleId(live)) throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  if (live.cancel_at_period_end) throw new AddonError("change_scheduled", "This plan is set to end at the end of the billing period. Nothing was changed. Resume it in Manage billing, then add seats.");
  const prorationDate = Math.floor(now.getTime() / 1000);
  const preview = await runPreview(deps, live, items, prorationDate);
  const cur = preview.currency ?? currency;
  const token = signPreviewToken({ k: "seats", s: subjectKey(subject), u: userId, sub: live.id, items, d: prorationDate, a: preview.amount_due, c: cur, q: previewHash(preview), h: billingTermsHash(live), exp });
  return { token, dueNow: preview.amount_due, renewalTotal: total, currency: cur, interval: iv, renewsAt: end?.toISOString() ?? null, quantity: seats, direction: "up", effectiveAt: now.toISOString() };
}

/**
 * Applies a confirmed seat change, only if it is still exactly what was reviewed. Up: same items, same terms and the
 * same charge from a fresh preview at the reviewed proration_date; then base and add-on change together now. Down: same
 * items and terms; then both drop at renewal through a new schedule.
 */
export async function confirmSeatChange(subject: AddonSubject, userId: string, seats: number, token: string, deps: AddonDeps = liveAddonDeps, now = new Date()): Promise<{ direction: "up" | "down"; effectiveAt: Date | null }> {
  const t = readPreviewToken(token, { userId, subject: subjectKey(subject), kind: "seats" }, now.getTime());
  if (!t || t.sub !== subject.subscriptionId) throw new AddonError("invalid_token", "This preview expired. Review the price again, then confirm.");
  const live = await loadLive(subject, deps);
  const { base, premium, current } = checkSeats(subject, seats, live);
  const items = seatItems(base, premium, seats);
  if (JSON.stringify(items) !== JSON.stringify(t.items.map((i) => ({ id: i.id, quantity: i.quantity })))) {
    throw new AddonError("subscription_changed", TERMS_CHANGED);
  }
  if (seats < current) {
    if (t.d !== 0 || t.a !== 0 || billingTermsHash(live) !== t.h) throw new AddonError("subscription_changed", TERMS_CHANGED);
    const ids = premiumPriceIds(live, await deps.prices());
    const at = await scheduleAtRenewal(live, (phase) => phase.map((i) => (i.price === base.price.id || ids.has(i.price) ? { ...i, quantity: seats } : i)), `seats-down-${seats}`, deps);
    return { direction: "down", effectiveAt: at };
  }
  if (scheduleId(live)) throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  if (live.cancel_at_period_end) throw new AddonError("change_scheduled", "This plan is set to end at the end of the billing period. Nothing was changed. Resume it in Manage billing, then add seats.");
  await recheckCharge(t, deps, live, items, {});
  await deps.updateSubscription(live.id, {
    items,
    proration_behavior: "always_invoice",
    proration_date: t.d,
    payment_behavior: "error_if_incomplete",
  }, idemKey("seats-up", token));
  await deps.sync(live.id);
  return { direction: "up", effectiveAt: now };
}
