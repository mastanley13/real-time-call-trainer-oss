import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { billingGate, verifyWebhookSignature } from "@/lib/stripe";
import { handleStripeEvent } from "@/lib/billing";

const Event = z.object({ id: z.string().min(1).max(255), type: z.string().min(1).max(255), data: z.object({ object: z.unknown() }) });

const MAX_WEBHOOK_BYTES = 1_000_000;

/**
 * Stripe webhook. There is no session here: the Stripe-Signature header over the raw body is the
 * authentication, so this route skips requireAuth and the per-IP limit (a throttled delivery would
 * only be retried later). Bypasses the access-code gate in src/middleware.ts for the same reason.
 * Handles checkout.session.completed, customer.subscription.updated and customer.subscription.deleted.
 */
export async function POST(req: NextRequest) {
  const gate = billingGate();
  if (gate) return gate;
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ error: "billing_not_configured", message: "STRIPE_WEBHOOK_SECRET is not set on the server." }, { status: 503 });
  }

  if (Number(req.headers.get("content-length") ?? 0) > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return NextResponse.json({ error: "payload_too_large" }, { status: 413 });

  if (!verifyWebhookSignature(raw, req.headers.get("stripe-signature"), secret)) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
  }

  let event: z.infer<typeof Event>;
  try {
    event = Event.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "invalid_event" }, { status: 400 });
  }

  try {
    const result = await handleStripeEvent(event);
    return NextResponse.json({ received: true, result });
  } catch (e) {
    // 500 so Stripe retries; the event id was rolled back with the failed change.
    console.error("[stripe/webhook]", event.type, e instanceof Error ? e.name : "error");
    return NextResponse.json({ error: "webhook_failed" }, { status: 500 });
  }
}
