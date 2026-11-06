import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { ipLimitResponse, userLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { prisma } from "@/lib/db";
import { billingGate } from "@/lib/stripe";
import { premiumOnSale } from "@/lib/serverConfig";
import { PREMIUM_COMING_SOON } from "@/lib/pricing";
import { TEAM_MAX_SEATS, TEAM_MIN_SEATS } from "@/lib/usagePlan";
import { confirmSeatChange, liveAddonDeps, previewSeatChange } from "@/lib/premiumAddon";
import { addonFailure, addonSubjectFor, auditBilling } from "../_lib/addonRoute";

const Seats = z.number().int().min(TEAM_MIN_SEATS).max(TEAM_MAX_SEATS);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("preview"), seats: Seats }).strict(),
  z.object({ action: z.literal("confirm"), seats: Seats, token: z.string().min(1).max(2048) }).strict(),
]);

/**
 * Team seat changes that keep the Premium add-on quantity equal to the seats, in the same Stripe update
 * (src/lib/premiumAddon.ts). More seats: prorated and charged now, the pool grows at once. Fewer seats: at renewal,
 * nothing credited now, the pool shrinks then.
 *
 * POST { action: "preview", seats }          -> { direction, dueNow, renewalTotal, currency, interval, effectiveAt, token }
 * POST { action: "confirm", seats, token }   -> { direction, effectiveAt }
 *
 * Team owner only. Shipped with Premium Voice, so it is behind the same PREMIUM_VOICE_ON_SALE gate (default off): until
 * then seats change in Manage billing exactly as today.
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
    return NextResponse.json({ error: "invalid_request", message: `Team needs between ${TEAM_MIN_SEATS} and ${TEAM_MAX_SEATS} seats.` }, { status: 400 });
  }
  if (!premiumOnSale()) return NextResponse.json({ error: "premium_not_available", message: PREMIUM_COMING_SOON }, { status: 400 });
  const gate = billingGate();
  if (gate) return gate;

  const found = await addonSubjectFor(auth.id);
  if ("response" in found) return found.response;
  const { subject } = found;
  if (subject.plan !== "team") return NextResponse.json({ error: "not_team", message: "Seats can only be changed on a Team plan." }, { status: 400 });

  try {
    if (body.action === "preview") {
      return NextResponse.json(await previewSeatChange(subject, auth.id, body.seats, liveAddonDeps), { headers: { "Cache-Control": "no-store" } });
    }
    const done = await confirmSeatChange(subject, auth.id, body.seats, body.token, liveAddonDeps);
    if (done.direction === "down") {
      await prisma.organization.update({ where: { id: subject.id }, data: { seatCountAtRenewal: body.seats } });
    }
    await auditBilling(auth.id, subject, done.direction === "up" ? "billing.seats_added" : "billing.seats_decrease_scheduled", { seats: body.seats });
    return NextResponse.json({ direction: done.direction, effectiveAt: done.effectiveAt?.toISOString() ?? null });
  } catch (e) {
    return addonFailure(e, "billing/seats");
  }
}
