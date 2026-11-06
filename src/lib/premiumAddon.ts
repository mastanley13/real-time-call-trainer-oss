import "server-only";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ADDON_SEATS_SCOPE, itemKind, parseLiveSubscription, periodEndOf, resolvePriceIds, syncSubscriptionNow, type AddonDecreaseOutcome, type Interval, type LiveSubscription, type PriceIds } from "./billing";
import { prisma } from "./db";
import { stripeApi, StripeApiError, type StripeParams } from "./stripe";
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
 *   (current phase unchanged, next phase with the new items, then released). The app never edits a schedule it does not
 *   own: any schedule already on the subscription is refused with a clear message, so no later phase, end behavior or
 *   phase setting is ever overwritten. The one exception is the app's OWN schedule whose setup was cut short, named by
 *   the subject's premiumScheduleRef marker: the next attempt resumes it (or releases it when nothing was applied).
 *   A finished setup clears the marker, so a completed scheduled change is refused like anyone else's. A subscription
 *   with discounts, tax rates, automatic tax or a non-default collection method is refused too, because the app would
 *   not carry those into the scheduled phases.
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
  /** The subject's unfinished schedule setup marker (premiumScheduleRef), or null. */
  readScheduleRef(subject: AddonSubject): Promise<string | null>;
  /** Sets the marker to `to` only if it is still `from` (compare and set). True when it was written. */
  swapScheduleRef(subject: AddonSubject, from: string | null, to: string | null): Promise<boolean>;
  /** The server clock (epoch ms), for the schedule setup lease. */
  now(): number;
}

async function readScheduleRefDb(s: AddonSubject): Promise<string | null> {
  const row = s.kind === "organization"
    ? await prisma.organization.findUnique({ where: { id: s.id }, select: { premiumScheduleRef: true } })
    : await prisma.user.findUnique({ where: { id: s.id }, select: { premiumScheduleRef: true } });
  return row?.premiumScheduleRef ?? null;
}

async function swapScheduleRefDb(s: AddonSubject, from: string | null, to: string | null): Promise<boolean> {
  const args = { where: { id: s.id, premiumScheduleRef: from }, data: { premiumScheduleRef: to } };
  const r = s.kind === "organization" ? await prisma.organization.updateMany(args) : await prisma.user.updateMany(args);
  return r.count === 1;
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
  readScheduleRef: readScheduleRefDb,
  swapScheduleRef: swapScheduleRefDb,
  now: () => Date.now(),
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
  | "subscription_changed" | "price_changed" | "unsupported_billing_terms" | "schedule_setup_failed" | "change_pending"
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

/** Premium may be added only to an `active` subscription: never during a Stripe trial (Triage B2). */
const premiumPurchasable = (live: LiveSubscription) => (PREMIUM_STATUSES as readonly string[]).includes(live.status);
/** Seats follow the base plan's own good standing, which still includes a Stripe trial. Unchanged by the Premium rule. */
const SEAT_CHANGE_STATUSES: readonly string[] = ["active", "trialing"];
const seatsChangeable = (live: LiveSubscription) => SEAT_CHANGE_STATUSES.includes(live.status);
/** Shown when an existing subscriber tries to add Premium during a Stripe trial. */
export const PREMIUM_NOT_IN_TRIAL = "Premium voice can be added once your trial ends and your plan is active. Nothing was changed.";
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
  if (live.status === "trialing") throw new AddonError("not_in_good_standing", PREMIUM_NOT_IN_TRIAL);
  if (!premiumPurchasable(live)) throw new AddonError("not_in_good_standing", "Premium voice can be added once your plan is paid up. Update your card in Manage billing, then try again.");
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
const ScheduleObject = z.object({ id: z.string(), status: z.string().nullish(), phases: z.array(SchedulePhase) });

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

/**
 * How long one operation holds a subscription's schedule setup without renewing it. Every Stripe call is preceded by a
 * renewal, and every Stripe call times out after 15 seconds (src/lib/stripe.ts), so a holder's call has finished long
 * before anyone else can take the setup over.
 */
export const SCHEDULE_LEASE_MS = 60_000;
/** The stored original schedule is bounded; a larger one is not set up by the app (released at once). */
const MAX_ORIG_CHARS = 16_000;

/**
 * The app's own schedule setup while it is unfinished, stored on the billing subject (premiumScheduleRef):
 * - `sub`, `key`: the subscription and the attempt key (Stripe idempotency keys derive from it);
 * - `id`: the schedule id once Stripe returned it;
 * - `orig`: the schedule EXACTLY as Stripe created it (canonical JSON of the whole create response, nothing parsed away),
 *   the baseline every later decision compares against;
 * - `op`, `lease`: the one operation that holds the setup now, and until when (epoch ms). Null `op` means nobody.
 * Written BEFORE the schedule is created, renewed by compare-and-set before every Stripe call, and cleared once the setup
 * is done or the schedule is released. A setup cut short is resumed or released by the next attempt instead of blocking
 * it; an operation that lost the setup to another one stops without touching Stripe. A schedule this marker does not name
 * is never touched.
 */
const ScheduleRef = z.object({
  sub: z.string().max(255),
  key: z.string().max(200),
  id: z.string().max(255).nullable(),
  op: z.string().max(64).nullable().default(null),
  lease: z.number().default(0),
  orig: z.string().max(MAX_ORIG_CHARS).nullable().default(null),
});
type ScheduleRef = z.infer<typeof ScheduleRef>;
interface OwnedSetup { raw: string; ref: ScheduleRef }

const parseRef = (raw: string | null): ScheduleRef | null => {
  if (!raw) return null;
  try {
    return ScheduleRef.parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

/** The unfinished setup recorded for THIS subscription, or null. Read-only. */
async function ownedSetup(subject: AddonSubject, live: LiveSubscription, deps: AddonDeps): Promise<OwnedSetup | null> {
  const raw = await deps.readScheduleRef(subject);
  const ref = parseRef(raw);
  return raw && ref && ref.sub === live.id ? { raw, ref } : null;
}

// ---- Exact schedule comparison (nothing parsed away) -------------------------------------------------------------

/** JSON with object keys sorted at every level, so two equal Stripe objects always give the same string. */
export function canonicalJson(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm);
    if (x && typeof x === "object") return Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, norm((x as Record<string, unknown>)[k])]));
    return x === undefined ? null : x;
  };
  return JSON.stringify(norm(v));
}

/** null, "", false, [] or {} at every level: what Stripe shows for a setting nobody set. */
const emptyish = (v: unknown): boolean =>
  v == null || v === "" || v === false
  || (Array.isArray(v) ? v.every(emptyish) : typeof v === "object" ? Object.values(v as object).every(emptyish) : false);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const itemPrice = (i: Obj): string | null => (typeof i.price === "string" ? i.price : isObj(i.price) && typeof i.price.id === "string" ? i.price.id : null);

/** Every key of `obs` outside `skip` is either what `base` had or a setting nobody set. */
const onlyBaseOrEmpty = (obs: Obj, base: Obj, skip: string[]) =>
  Object.keys(obs).filter((k) => !skip.includes(k)).every((k) => emptyish(obs[k]) || sameJson(obs[k], base[k]));

/** A phase's items are exactly `want` (price and quantity), and carry nothing else the original items did not. */
function itemsExactly(items: unknown, want: PhaseItem[], baseItems: unknown): boolean {
  if (!Array.isArray(items) || items.length !== want.length) return false;
  const base = Array.isArray(baseItems) ? baseItems.filter(isObj) : [];
  return items.every((i) => {
    if (!isObj(i)) return false;
    const price = itemPrice(i);
    const w = want.find((x) => x.price === price);
    if (!w || (i.quantity ?? 1) !== w.quantity) return false;
    const b = base.find((x) => itemPrice(x) === price) ?? {};
    return onlyBaseOrEmpty(i, b, ["price", "quantity"]);
  });
}

/**
 * True only when `obs` is the original schedule with exactly this change applied by the app: every top-level term the
 * same as the original except end_behavior (now "release"); two phases; the current phase with the original items and
 * dates; the next phase starting at the period end with exactly `next`; proration "none" on both; and every other phase
 * setting either the original's or unset. A discount, tax rate, collection method, metadata or any other setting added by
 * someone else fails this. (Only success is decided here; a false answer never leads to an update or a release.)
 */
function appliedExactly(orig: Obj, obs: Obj, endSec: number, currentItems: PhaseItem[], next: PhaseItem[]): boolean {
  const top = new Set([...Object.keys(orig), ...Object.keys(obs)]);
  for (const k of top) if (k !== "phases" && k !== "end_behavior" && !sameJson(orig[k], obs[k])) return false;
  if (obs.end_behavior !== "release") return false;
  const op = Array.isArray(orig.phases) && isObj(orig.phases[0]) ? orig.phases[0] : null;
  if (!op || !Array.isArray(obs.phases) || obs.phases.length !== 2) return false;
  const [p0, p1] = obs.phases;
  if (!isObj(p0) || !isObj(p1)) return false;
  const pr = (p: Obj) => p.proration_behavior === undefined || p.proration_behavior === "none";
  if (p0.start_date !== op.start_date || p0.end_date !== endSec || !pr(p0) || !itemsExactly(p0.items, currentItems, op.items)) return false;
  if (!onlyBaseOrEmpty(p0, op, ["start_date", "end_date", "items", "proration_behavior"])) return false;
  if (p1.start_date !== endSec || !pr(p1) || !itemsExactly(p1.items, next, op.items)) return false;
  return onlyBaseOrEmpty(p1, op, ["start_date", "end_date", "items", "proration_behavior", "iterations"]);
}

/** A create response that mirrors the subscription: one phase ending at the period end, active, releasing at the end. */
function createdMirror(resp: Obj, endSec: number): boolean {
  if (resp.status != null && resp.status !== "active" && resp.status !== "not_started") return false;
  if (resp.end_behavior != null && resp.end_behavior !== "release") return false;
  const phases = Array.isArray(resp.phases) ? resp.phases : [];
  return phases.length === 1 && isObj(phases[0]) && phases[0].end_date === endSec;
}

/**
 * True when the schedule on the subscription may be the app's own unfinished one: the marker names it, or the marker's
 * create never reported an id (scheduleAtRenewal then proves ownership through Stripe's idempotent replay of that
 * create, and refuses if the replay names another schedule).
 */
function mayResume(live: LiveSubscription, owned: OwnedSetup | null): boolean {
  const attached = scheduleId(live);
  return !!attached && !!owned && (owned.ref.id === attached || owned.ref.id === null);
}

/** The subscription as a preview binds it: the app's own unfinished schedule is not a term the owner agreed to. */
const termsView = (live: LiveSubscription, owned: OwnedSetup | null): LiveSubscription => (mayResume(live, owned) ? { ...live, schedule: null } : live);

/** Refuses what the app cannot schedule safely: anyone else's schedule, or terms a scheduled phase would drop. */
function assertSchedulable(live: LiveSubscription, owned: OwnedSetup | null): void {
  if (scheduleId(live) && !mayResume(live, owned)) throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
  if (hasTermsScheduleCannotCarry(live)) throw new AddonError("unsupported_billing_terms", UNSUPPORTED_TERMS);
}

const SETUP_FAILED = "The change could not be scheduled, so nothing was changed. Try again in a moment.";
const CHANGE_PENDING = "A scheduled change for this plan is still being set up. Nothing new was changed. Try again in a minute, or contact support if this keeps happening.";

/** A Stripe answer that proves the request was NOT applied: a 4xx other than 409 (a concurrent request with the same key). */
const rejected = (e: unknown): boolean => e instanceof StripeApiError && e.status >= 400 && e.status < 500 && e.status !== 409;

const SCHEDULE_EDITED = "This plan's scheduled change was changed outside the app, so it was left exactly as it is. Nothing new was changed. Check it in Manage billing or contact support.";

const phaseItems = (items: z.infer<typeof SchedulePhase>["items"]): PhaseItem[] =>
  items.map((i) => ({ price: typeof i.price === "string" ? i.price : i.price.id, quantity: i.quantity ?? 1 }));

type ScheduleState = { kind: "pristine"; current: z.infer<typeof SchedulePhase>; currentItems: PhaseItem[]; next: PhaseItem[] } | { kind: "applied" } | { kind: "other" };

/**
 * Where a schedule stands for this change, judged against `orig` (the schedule exactly as Stripe created it):
 * - "pristine": byte-for-byte the original (canonical JSON of the whole object, every field, nothing parsed away). Only
 *   this state is ever updated or released after a resume. Any edit, even one that keeps the phase count and dates (a
 *   discount, a tax rate, a collection method, end_behavior, metadata), is not pristine;
 * - "applied": exactly this change on top of the original (appliedExactly);
 * - "other": anything else, including no stored original. Left untouched.
 * Throws when the object cannot be read at all (the caller treats that as unreadable).
 */
function scheduleState(raw: unknown, orig: string | null, endSec: number, nextItems: (items: PhaseItem[]) => PhaseItem[]): ScheduleState {
  ScheduleObject.parse(raw);
  if (!orig || !isObj(raw)) return { kind: "other" };
  const origObj = JSON.parse(orig) as unknown;
  if (!isObj(origObj)) return { kind: "other" };
  const origPhase = ScheduleObject.parse(origObj).phases[0];
  if (!origPhase || origPhase.end_date !== endSec) return { kind: "other" };
  const currentItems = phaseItems(origPhase.items);
  const next = nextItems(currentItems).filter((i) => i.quantity > 0);
  // Equal to the original, so its current phase is the original's.
  if (canonicalJson(raw) === orig) return { kind: "pristine", current: origPhase, currentItems, next };
  if (appliedExactly(origObj, raw, endSec, currentItems, next)) return { kind: "applied" };
  return { kind: "other" };
}

/** The id and the exact original terms of a schedule, from a create response (or its idempotent replay). */
function createdSchedule(resp: unknown, endSec: number): { id: string; orig: string | null; mirror: boolean } {
  const id = z.object({ id: z.string().max(255) }).parse(resp).id;
  const c = canonicalJson(resp);
  const orig = c.length <= MAX_ORIG_CHARS ? c : null;
  return { id, orig, mirror: !!orig && isObj(resp) && createdMirror(resp, endSec) };
}

/**
 * Puts a change at the period end through the app's OWN schedule: a new one made from the subscription, whose next
 * phase (one period, then released) gets `nextItems(currentItems)`. Proration is off for both phases: nothing is
 * credited or charged now. Never edits a schedule it does not own (assertSchedulable, and the marker above).
 *
 * Exclusive ownership. One operation at a time holds the subscription's setup: it takes the marker by compare-and-set
 * (refused while another operation's lease is live), and RENEWS it by compare-and-set right before every Stripe call
 * (create, read, update, release, the create replay) and before every marker write. If the marker is no longer exactly
 * the one it wrote (another operation took the setup over after the lease ran out, finished it, or cleared it), it
 * stops with "still being set up" and touches nothing. So a slow or failed operation can never release or overwrite a
 * schedule that another operation has since completed.
 *
 * External edits. The create response is stored as the exact original. A resumed schedule is updated or released only
 * when it is still byte-for-byte that original; a schedule that already carries exactly this change is a success; any
 * other state (a phase discount, a tax rate, a collection method, end_behavior, metadata, even with the same phase count
 * and dates) is left untouched and refused.
 *
 * Failure handling, so a setup cut short never blocks the next attempt and never undoes a change that went through:
 * - The schedule this operation just created, if it does not mirror the subscription, cannot be read, or Stripe rejects
 *   the update (a 4xx), is released while still held: nothing was applied to it, so the subscription is exactly as it
 *   was. "Nothing was changed. Try again."
 * - An update with no clear answer (5xx, 409, network) is checked by reading the schedule again: exactly this change is
 *   success; still the original is released; anything else is left as it is.
 * - A create with no clear answer, an unreadable resumed schedule, or a failed release keeps the marker and gives up the
 *   lease ("still being set up"); the next attempt resumes from the schedule's real state. A lost create is recovered by
 *   replaying that exact create (same idempotency key), which returns the original schedule as created.
 */
async function scheduleAtRenewal(subject: AddonSubject, live: LiveSubscription, nextItems: (items: PhaseItem[]) => PhaseItem[], scope: string, deps: AddonDeps): Promise<Date> {
  const raw0 = await deps.readScheduleRef(subject);
  const ref0 = parseRef(raw0);
  const owned: OwnedSetup | null = raw0 && ref0 && ref0.sub === live.id ? { raw: raw0, ref: ref0 } : null;
  assertSchedulable(live, owned);
  const end = periodEndOf(live);
  if (!end) throw new AddonError("subscription_changed", "Your renewal date could not be read. Try again in a moment.");
  const endSec = Math.floor(end.getTime() / 1000);
  const attached = scheduleId(live);
  const op = randomBytes(8).toString("hex");
  const pending = () => new AddonError("change_pending", CHANGE_PENDING);
  // Another operation holds this subscription's setup right now: touch nothing, not even the marker.
  if (owned?.ref.op && owned.ref.lease > deps.now()) throw pending();

  let raw: string | null = raw0;
  let ref: ScheduleRef = owned?.ref ?? { sub: live.id, key: "", id: null, op: null, lease: 0, orig: null };
  /** Replaces the marker only if it is still exactly what this operation last wrote (or read); else ownership is lost. */
  const write = async (next: ScheduleRef | null): Promise<void> => {
    const to = next ? JSON.stringify(next) : null;
    if (!(await deps.swapScheduleRef(subject, raw, to))) throw pending();
    raw = to;
    if (next) ref = next;
  };
  /** Takes or renews the lease. Called right before every Stripe call: no call is made without exclusive ownership. */
  const own = () => write({ ...ref, op, lease: deps.now() + SCHEDULE_LEASE_MS });
  /** Leaves the marker for the next attempt and gives up the lease, then reports "still being set up". */
  const park = async (): Promise<AddonError> => {
    await deps.swapScheduleRef(subject, raw, JSON.stringify({ ...ref, op: null, lease: 0 })).catch(() => false);
    return pending();
  };

  // 1. The schedule: the app's own unfinished one (resume), or a new one under a fresh marker.
  let fresh: boolean;
  let id: string;
  if (attached && owned) {
    fresh = false;
    await own();
    if (ref.id) id = ref.id;
    else {
      // The earlier create never reported its id. Its exact replay does (with the schedule as created); anything else
      // means the attached schedule is not ours.
      let created: ReturnType<typeof createdSchedule>;
      try {
        created = createdSchedule(await deps.createSubscriptionSchedule({ from_subscription: live.id }, `${ref.key}:create`), endSec);
      } catch (e) {
        if (!rejected(e)) throw await park();
        await write(null);
        throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
      }
      if (created.id !== attached) {
        await write(null);
        throw new AddonError("change_scheduled", SCHEDULE_EXISTS);
      }
      id = created.id;
      await write({ ...ref, id, orig: created.orig });
    }
  } else {
    // Nothing of the app's is on the subscription: a marker left over (released, or a create that never landed) is stale.
    fresh = true;
    await write({ sub: live.id, key: `${scope}:${live.id}:${endSec}:${randomBytes(6).toString("hex")}`, id: null, op, lease: deps.now() + SCHEDULE_LEASE_MS, orig: null });
    let created: ReturnType<typeof createdSchedule>;
    try {
      created = createdSchedule(await deps.createSubscriptionSchedule({ from_subscription: live.id }, `${ref.key}:create`), endSec);
    } catch (e) {
      if (rejected(e)) {
        // Stripe refused it: no schedule exists. The original error answers as before.
        await write(null);
        throw e;
      }
      throw await park();
    }
    id = created.id;
    await write({ ...ref, id, orig: created.orig });
    if (!created.mirror) return releaseOwn("change_scheduled");
  }

  /** The setup is finished (or no longer the app's to finish): clear the marker this operation holds. */
  async function done(): Promise<void> {
    await write(null);
  }
  /** Releases the app's own schedule, still held and still as created, clears the marker, reports nothing changed. */
  async function releaseOwn(code: "schedule_setup_failed" | "change_scheduled"): Promise<never> {
    await own();
    try {
      await deps.releaseSubscriptionSchedule(id, `${ref.key}:release`);
    } catch {
      throw await park();
    }
    await done();
    throw new AddonError(code, code === "change_scheduled" ? SCHEDULE_EXISTS : SETUP_FAILED);
  }
  const readState = async (): Promise<ScheduleState | null> => {
    await own();
    try {
      return scheduleState(await deps.retrieveSubscriptionSchedule(id), ref.orig, endSec, nextItems);
    } catch {
      return null;
    }
  };
  const leaveUntouched = async (): Promise<never> => {
    await done();
    throw new AddonError("change_scheduled", SCHEDULE_EDITED);
  };

  // 2. Where it stands now.
  const state = await readState();
  if (!state) {
    // Created by this operation and held since, so nothing has been applied to it: releasing restores the subscription.
    // A resumed one may carry an update whose answer was lost, so it is left for the next attempt.
    if (fresh) return releaseOwn("schedule_setup_failed");
    throw await park();
  }
  if (state.kind === "applied") {
    await done();
    return end;
  }
  if (state.kind === "other") return leaveUntouched();

  // 3. The update. Its idempotency key is per attempt: a retry after an unclear answer is a new, identical request.
  const { current, currentItems, next } = state;
  await own();
  try {
    await deps.updateSubscriptionSchedule(id, {
      end_behavior: "release",
      phases: [
        { items: currentItems, start_date: current.start_date, end_date: endSec, proration_behavior: "none" },
        { items: next, iterations: 1, proration_behavior: "none" },
      ],
    }, `${ref.key}:update:${createHash("sha256").update(JSON.stringify(next)).digest("hex").slice(0, 16)}:${randomBytes(4).toString("hex")}`);
  } catch (e) {
    if (rejected(e)) return releaseOwn("schedule_setup_failed");
    const after = await readState();
    if (after?.kind === "applied") {
      await done();
      return end;
    }
    if (after?.kind === "pristine") return releaseOwn("schedule_setup_failed");
    if (after?.kind === "other") return leaveUntouched();
    throw await park();
  }
  await done();
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
  const at = await scheduleAtRenewal(subject, live, (items) => items.filter((i) => !ids.has(i.price)), "premium-remove", deps);
  return { removeAt: at };
}

/**
 * A Billing Portal seat decrease (the base item already dropped) moves the Team's Premium add-on to the new seat count
 * at RENEWAL (spec section 7 line 65), through the app's own schedule: the same leases, exact-original comparison and
 * refusal of any other schedule as every scheduled change (scheduleAtRenewal). The current period keeps the add-on
 * quantity it paid for. Called by the webhook after commit (billing.ts afterApplied).
 *
 * Outcomes (it never lowers anything now, and never writes over a schedule it does not own):
 * - "scheduled": the next phase lowers the add-on at the CURRENT period end (the original renewal date): set up now, the
 *   app's own unfinished setup resumed and finished (or found already finished) through the lease and exact baseline,
 *   or an attached schedule (read only) that already lowers it at that date.
 * - "not_needed": nothing left to lower, or the plan ends at period end anyway.
 * - "unsupported_terms": discounts, tax or collection settings a scheduled phase would drop.
 * - "schedule_conflict": someone else's schedule, or the app's own one changed outside the app (left untouched).
 * The last two need support; the caller keeps the paid quantity and pool and fails the webhook visibly. Any other
 * failure (a lease held by another operation, a setup cut short, a Stripe error) throws so Stripe's retry resumes it.
 */
export async function scheduleAddonSeatsAtRenewal(owner: { kind: "organization"; id: string }, subscriptionId: string, seats: number, deps: AddonDeps = liveAddonDeps): Promise<AddonDecreaseOutcome> {
  const subject: AddonSubject = { kind: "organization", id: owner.id, plan: "team", subscriptionId, seats };
  const live = await loadLive(subject, deps);
  const { premium } = splitItems(live);
  if (!premium || (premium.quantity ?? 1) <= seats || live.cancel_at_period_end) return "not_needed";
  const ids = premiumPriceIds(live, await deps.prices());
  try {
    await scheduleAtRenewal(subject, live, (items) => items.map((i) => (ids.has(i.price) ? { ...i, quantity: seats } : i)), `${ADDON_SEATS_SCOPE}${seats}`, deps);
    return "scheduled";
  } catch (e) {
    if (e instanceof AddonError && e.code === "unsupported_billing_terms") return "unsupported_terms";
    // A schedule the app may not edit (anyone else's, or the app's own finished or externally changed one): only READ
    // it. If its renewal phase already lowers the add-on to the seats, the decrease is arranged; otherwise support.
    if (e instanceof AddonError && e.code === "change_scheduled") return (await decreaseArrangedAtRenewal(live, seats, ids, deps)) ? "scheduled" : "schedule_conflict";
    throw e;
  }
}

/**
 * Read-only: whether the schedule attached to `live` already lowers the Premium add-on to at most `seats` in the phase
 * that starts at the current period end (the original renewal date). Never writes anything. A read that fails throws, so
 * the webhook retries; an object that cannot be read as a schedule is "not arranged".
 */
async function decreaseArrangedAtRenewal(live: LiveSubscription, seats: number, premiumIds: Set<string>, deps: AddonDeps): Promise<boolean> {
  const attached = scheduleId(live);
  const end = periodEndOf(live);
  if (!attached || !end) return false;
  const endSec = Math.floor(end.getTime() / 1000);
  const parsed = ScheduleObject.safeParse(await deps.retrieveSubscriptionSchedule(attached));
  if (!parsed.success) return false;
  const next = parsed.data.phases.find((p) => p.start_date === endSec);
  if (!next) return false;
  return phaseItems(next.items).every((i) => !premiumIds.has(i.price) || i.quantity <= seats);
}

// ---- Seats ----------------------------------------------------------------------------------------------------

export type SeatPreview = ChangePreview & { direction: "up" | "down"; effectiveAt: string | null; token: string };

function checkSeats(subject: AddonSubject, seats: number, live: LiveSubscription) {
  if (subject.plan !== "team") throw new AddonError("not_team", "Seats can only be changed on a Team plan.");
  if (!Number.isInteger(seats) || seats < TEAM_MIN_SEATS || seats > TEAM_MAX_SEATS) {
    throw new AddonError("invalid_seats", `Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.`);
  }
  if (!seatsChangeable(live)) throw new AddonError("not_in_good_standing", "Seats can be changed once your plan is paid up. Update your card in Manage billing, then try again.");
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
    // The app's own unfinished schedule (a setup cut short) does not block it: the confirm resumes or releases it.
    const owned = await ownedSetup(subject, live, deps);
    assertSchedulable(live, owned);
    const token = signPreviewToken({ k: "seats", s: subjectKey(subject), u: userId, sub: live.id, items, d: 0, a: 0, c: currency, q: ZERO_PREVIEW, h: billingTermsHash(termsView(live, owned)), exp });
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
    const owned = await ownedSetup(subject, live, deps);
    if (t.d !== 0 || t.a !== 0 || billingTermsHash(termsView(live, owned)) !== t.h) throw new AddonError("subscription_changed", TERMS_CHANGED);
    const ids = premiumPriceIds(live, await deps.prices());
    const at = await scheduleAtRenewal(subject, live, (phase) => phase.map((i) => (i.price === base.price.id || ids.has(i.price) ? { ...i, quantity: seats } : i)), `seats-down-${seats}`, deps);
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
