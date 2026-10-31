import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stripe, test mode only. A thin typed client over Stripe's form-encoded REST API (no SDK dependency)
 * plus webhook signature verification. Never logs or returns a key or a Stripe response body.
 */

export type StripeStatus = "disabled" | "live_key_refused" | "ready";

type Env = Record<string, string | undefined>;

/** Off without a key and in demo mode; "live_key_refused" when the key is not an sk_test_ key. */
export function stripeStatus(env: Env = process.env): StripeStatus {
  if (env.DEMO_MODE === "true") return "disabled";
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) return "disabled";
  return key.startsWith("sk_test_") ? "ready" : "live_key_refused";
}

export class StripeConfigError extends Error {
  constructor(public code: "billing_not_configured" | "stripe_live_key_refused", message: string) {
    super(message);
  }
}

/** The secret key, or a StripeConfigError. Every Stripe call goes through here, so a live key is refused everywhere. */
export function stripeSecretKey(env: Env = process.env): string {
  const status = stripeStatus(env);
  if (status === "disabled") throw new StripeConfigError("billing_not_configured", "Billing is not set up on this server.");
  if (status === "live_key_refused") {
    throw new StripeConfigError("stripe_live_key_refused", "STRIPE_SECRET_KEY is not a test key. Only Stripe test mode keys (sk_test_) are accepted. Replace it and restart.");
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
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
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
  createPortalSession: (params: StripeParams) => request<{ url: string }>("POST", "billing_portal/sessions", params),
  /** The subscription as Stripe has it now. Webhook payloads are snapshots and can arrive out of order. */
  retrieveSubscription: (id: string) => request<unknown>("GET", `subscriptions/${seg(id)}`),
  /** Cancels immediately. Used only to drop a duplicate subscription for a subject that already has one. */
  cancelSubscription: (id: string) => request<{ id: string }>("DELETE", `subscriptions/${seg(id)}`),
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
