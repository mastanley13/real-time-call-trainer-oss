import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe, test mode by default; live keys need STRIPE_LIVE_MODE=true. A thin typed client over Stripe's form-encoded REST API (no SDK dependency)
 * plus webhook signature verification. Never logs or returns a key or a Stripe response body.
 */

export type StripeStatus = "disabled" | "live_key_refused" | "mode_mismatch" | "ready" | "ready_live";

type Env = Record<string, string | undefined>;

/**
 * Off without a key and in demo mode. Test keys (sk_test_, rk_test_) are "ready". Live keys (sk_live_, rk_live_)
 * are "ready_live" only when STRIPE_LIVE_MODE is exactly "true", otherwise "live_key_refused". STRIPE_LIVE_MODE=true
 * with a test key is "mode_mismatch" (a half-flipped env). Anything else is "live_key_refused".
 */
export function stripeStatus(env: Env = process.env): StripeStatus {
  if (env.DEMO_MODE === "true") return "disabled";
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return "disabled";
  const liveFlag = env.STRIPE_LIVE_MODE === "true";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return liveFlag ? "mode_mismatch" : "ready";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return liveFlag ? "ready_live" : "live_key_refused";
  return "live_key_refused";
}

/** True when Stripe is configured and usable, in test or live mode. */
export const stripeReady = (env: Env = process.env): boolean => {
  const s = stripeStatus(env);
  return s === "ready" || s === "ready_live";
};

/** True when Stripe is running with a test-mode key. The UI shows its "test cards only" note only then. */
export const stripeTestMode = (env: Env = process.env): boolean => stripeStatus(env) === "ready";

/** The livemode value Stripe events must carry for this server's configuration. */
export const stripeLiveMode = (env: Env = process.env): boolean => stripeStatus(env) === "ready_live";

export class StripeConfigError extends Error {
  constructor(public code: "billing_not_configured" | "stripe_live_key_refused" | "stripe_mode_mismatch", message: string) {
    super(message);
  }
}

/** The secret key, or a StripeConfigError. Every Stripe call goes through here, so an unapproved or mismatched key is refused everywhere. */
export function stripeSecretKey(env: Env = process.env): string {
  const status = stripeStatus(env);
  if (status === "disabled") throw new StripeConfigError("billing_not_configured", "Billing is not set up on this server.");
  if (status === "live_key_refused") {
    throw new StripeConfigError("stripe_live_key_refused", "STRIPE_SECRET_KEY is not a test key. Test keys (sk_test_) are accepted, and live keys only when STRIPE_LIVE_MODE=true. Replace the key or set STRIPE_LIVE_MODE=true, then restart.");
  }
  if (status === "mode_mismatch") {
    throw new StripeConfigError("stripe_mode_mismatch", "STRIPE_LIVE_MODE=true needs a live Stripe key (sk_live_ or rk_live_), but STRIPE_SECRET_KEY is a test key. Use a live key or unset STRIPE_LIVE_MODE, then restart.");
  }
  return env.STRIPE_SECRET_KEY!.trim();
}

/** A 503 for routes to return before touching Stripe, or null when Stripe is ready. Routes share the same wording. */
export function billingGate(env: Env = process.env): Response | null {
  try {
    stripeSecretKey(env);
    return null;
  } catch (e) {
    if (!(e instanceof StripeConfigError)) throw e;
    return Response.json({ error: e.code, message: e.message }, { status: 503 });
  }
}

export class StripeApiError extends Error {
  constructor(public status: number) {
    super(`Stripe returned ${status}`);
  }
}

// ---- Form encoding ----------------------------------------------------------------------------

export type StripeParams = { [key: string]: string | number | boolean | undefined | null | StripeParams | StripeParams[] | string[] };

/** Stripe's nested form encoding: a[b][0][c]=1. Skips undefined and null. */
export function encodeForm(params: StripeParams, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "object") out.push(...encodeForm(item as StripeParams, `${key}[${i}]`));
        else out.push(`${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === "object") out.push(...encodeForm(v, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

async function request<T>(method: "GET" | "POST" | "DELETE", path: string, params: StripeParams = {}, idempotencyKey?: string): Promise<T> {
  const key = stripeSecretKey();
  const query = method === "GET" ? encodeForm(params).join("&") : "";
  const res = await fetch(`https://api.stripe.com/v1/${path}${query ? `?${query}` : ""}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(method === "POST" ? { body: encodeForm(params).join("&") } : {}),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    // Status only: the body can echo request details and is never forwarded or logged.
    console.error("[stripe]", path, "status", res.status);
    throw new StripeApiError(res.status);
  }
  return (await res.json()) as T;
}

const seg = encodeURIComponent;

export const stripeApi = {
  /** The idempotency key makes two identical in-flight requests return the same Checkout Session. */
  createCheckoutSession: (params: StripeParams, idempotencyKey?: string) => request<{ id: string; url: string | null }>("POST", "checkout/sessions", params, idempotencyKey),
  expireCheckoutSession: (id: string) => request<{ id: string }>("POST", `checkout/sessions/${seg(id)}/expire`),
  /** The session as Stripe has it now: status is open, complete or expired. */
  retrieveCheckoutSession: (id: string) => request<unknown>("GET", `checkout/sessions/${seg(id)}`),
  /** One allowlisted price by id, with its product expanded so its metadata can be checked. */
  retrievePrice: (id: string) => request<unknown>("GET", `prices/${seg(id)}`, { expand: ["product"] }),
  createPortalSession: (params: StripeParams) => request<{ url: string }>("POST", "billing_portal/sessions", params),
  /** The subscription as Stripe has it now. Webhook payloads are snapshots and can arrive out of order. */
  retrieveSubscription: (id: string) => request<unknown>("GET", `subscriptions/${seg(id)}`, { expand: ["items.data.price.product"] }),
  /** Cancels immediately. Used only to drop a duplicate subscription for a subject that already has one. */
  cancelSubscription: (id: string) => request<{ id: string }>("DELETE", `subscriptions/${seg(id)}`),
  /**
   * Updates a subscription's items (Premium add, seat increase). Callers always pass an idempotency key, a
   * proration_date fixed at preview time and payment_behavior=error_if_incomplete, so a failed charge changes nothing.
   */
  updateSubscription: (id: string, params: StripeParams, idempotencyKey: string) => request<unknown>("POST", `subscriptions/${seg(id)}`, params, idempotencyKey),
  /** The prorated invoice an item change would produce, without changing anything (POST /v1/invoices/create_preview). */
  previewInvoice: (params: StripeParams) => request<unknown>("POST", "invoices/create_preview", params),
  /** Puts an existing subscription under a schedule, so a change can wait for the period end. */
  createSubscriptionSchedule: (params: StripeParams, idempotencyKey: string) => request<unknown>("POST", "subscription_schedules", params, idempotencyKey),
  retrieveSubscriptionSchedule: (id: string) => request<unknown>("GET", `subscription_schedules/${seg(id)}`),
  updateSubscriptionSchedule: (id: string, params: StripeParams, idempotencyKey: string) => request<unknown>("POST", `subscription_schedules/${seg(id)}`, params, idempotencyKey),
};

// ---- Webhook signatures -----------------------------------------------------------------------

/** Stripe rejects a timestamp older than this by default. */
export const WEBHOOK_TOLERANCE_SEC = 300;

/**
 * Verifies a `Stripe-Signature` header (t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">), in constant
 * time and within the tolerance. Needs the exact raw body.
 */
export function verifyWebhookSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header || !secret) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const [k, v] = part.split("=");
    if (k?.trim() === "t") t = (v ?? "").trim();
    else if (k?.trim() === "v1" && v) sigs.push(v.trim());
  }
  const ts = Number(t);
  if (!t || !Number.isFinite(ts) || Math.abs(nowSec - ts) > WEBHOOK_TOLERANCE_SEC) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}
