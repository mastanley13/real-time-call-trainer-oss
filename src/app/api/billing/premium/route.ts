import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { billingGate } from "@/lib/stripe";
import { premiumOnSale } from "@/lib/serverConfig";
import { PREMIUM_COMING_SOON } from "@/lib/pricing";
import { emitPremiumEvent } from "@/lib/billingEvents";
import { confirmAddPremium, liveAddonDeps, previewAddPremium, scheduleRemovePremium, type AddonDeps } from "@/lib/premiumAddon";
import { addonFailure, addonSubjectFor, auditBilling } from "../_lib/addonRoute";
import { gradedCallRequired, hasGradedCall } from "@/lib/premiumOffer";

const Body = z.discriminatedUnion("action", [
  /** Shows the prorated charge now and the new renewal total. Changes nothing. */
  z.object({ action: z.literal("preview") }).strict(),
  /** Applies exactly the previewed change. The token is the server-signed preview. */
  z.object({ action: z.literal("confirm"), token: z.string().min(1).max(2048) }).strict(),
  /** Schedules removal at the period end. Allowed while Premium is off sale. */
  z.object({ action: z.literal("remove") }).strict(),
]);

/** Every Stripe call goes through stripeApi (src/lib/stripe.ts); tests mock those methods, nothing reaches Stripe. */
const deps: AddonDeps = liveAddonDeps;

/**
 * Premium Voice on an existing Pro or Team subscription (src/lib/premiumAddon.ts). Checkout only sells new
 * subscriptions, so this is how a current payer adds Premium without a Checkout 409.
 *
 * POST { action: "preview" }                 -> { dueNow, renewalTotal, currency, interval, renewsAt, quantity, token }
 * POST { action: "confirm", token }          -> { added: true, quantity }
 * POST { action: "remove" }                  -> { removeAt }  (Premium stays until then)
 *
 * Team: owner only. Pro: the subscriber. Preview and confirm need PREMIUM_VOICE_ON_SALE=true; remove does not.
 * No Stripe ids or provider bodies are returned.
 */
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
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Choose preview, confirm or remove." }, { status: 400 });
  }
  // The sale gate controls purchases (and paid Premium at mint), not removal. Answered before the billing check, like checkout.
  if (body.action !== "remove" && !premiumOnSale()) {
    return NextResponse.json({ error: "premium_not_available", message: PREMIUM_COMING_SOON }, { status: 400 });
  }
  const gate = billingGate();
  if (gate) return gate;

  const found = await addonSubjectFor(auth.id);
  if ("response" in found) return found.response;
  const { subject } = found;
  // Spec 10.2: never before the organization's first graded call. Re-checked at confirm too, so a token minted earlier
  // or a forged request cannot buy before it. Removal is never gated.
  if (body.action !== "remove" && !(await hasGradedCall(auth.id))) return gradedCallRequired();

  try {
    if (body.action === "preview") {
      const p = await previewAddPremium(subject, auth.id, deps);
      await emitPremiumEvent({ name: "premium_add_started", subject: subject.kind, subjectId: subject.id, plan: subject.plan, units: p.quantity });
      return NextResponse.json(p, { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "confirm") {
      // premium_added is emitted by the subscription sync (and again never: the webhook finds nothing changed).
      const done = await confirmAddPremium(subject, auth.id, body.token, deps);
      await auditBilling(auth.id, subject, "billing.premium_added", { quantity: done.quantity });
      return NextResponse.json(done);
    }
    const { removeAt } = await scheduleRemovePremium(subject, deps);
    const where = { id: subject.id };
    const data = { premiumVoiceRemoveAt: removeAt };
    if (subject.kind === "organization") await prisma.organization.update({ where, data });
    else await prisma.user.update({ where, data });
    await auditBilling(auth.id, subject, "billing.premium_remove_scheduled", { removeAt: removeAt?.toISOString() ?? null });
    await emitPremiumEvent({ name: "premium_removed", subject: subject.kind, subjectId: subject.id, plan: subject.plan, reason: "scheduled" });
    return NextResponse.json({ removeAt: removeAt?.toISOString() ?? null });
  } catch (e) {
    return addonFailure(e, "billing/premium");
  }
}
