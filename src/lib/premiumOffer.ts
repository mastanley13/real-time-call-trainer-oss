import "server-only";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "./db";
import { PREMIUM_NEEDS_GRADED_CALL } from "./billingUi";

/**
 * Spec 10.2 (/workspace/ct-launch/tier/premium-voice/final-spec-draft.md, section 10 item 2): the Premium voice add-on
 * is never offered "before first graded call". Triage B3.
 *
 * "Graded call" uses the stored meaning the Team view already uses (src/app/api/team/_lib/server.ts): a TrainerSession
 * with `overallScore` set. A score is only stored when the server verified the grade seal (POST /api/transcripts) or
 * re-graded it (PATCH /api/transcripts/[id]), so an ungraded or text-only save never counts, and nothing the browser
 * caches or counts locally is read.
 *
 * Organization-wide: any member's graded call counts for everyone in the organization. An account without an
 * organization counts its own graded calls.
 *
 * Used at operation time by every purchase path (checkout with premium:true, existing-subscription preview AND
 * confirm) and by /api/usage, which tells the UI (an allowlisted boolean) whether to show the offer at all. It never
 * gates base checkout, calls already entitled to Premium, removal, or seat changes.
 */
export async function hasGradedCall(userId: string, db: Pick<Prisma.TransactionClient, "user" | "trainerSession"> = prisma): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { organizationId: true } });
  if (!user) return false;
  const scope: Prisma.TrainerSessionWhereInput = user.organizationId ? { organizationId: user.organizationId } : { userId };
  const graded = await db.trainerSession.count({ where: { ...scope, overallScore: { not: null } } });
  return graded > 0;
}

/** The neutral 409 every Premium purchase path answers before the first graded call. Nothing reaches Stripe. */
export function gradedCallRequired(): NextResponse {
  return NextResponse.json({ error: "premium_needs_graded_call", message: PREMIUM_NEEDS_GRADED_CALL }, { status: 409 });
}
