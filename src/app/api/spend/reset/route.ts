import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth } from "@/lib/apiAuth";
import { prisma } from "@/lib/db";
import { ipLimitResponse, readJsonLimited } from "@/lib/rateLimit";
import { STATE_ID, rememberSpendTrip } from "@/lib/spendState";

const Body = z.object({ reason: z.string().trim().min(1).max(200) });

/**
 * Clears the spend monitor's durable kill switch (and today's recorded voice ceiling). Platform admins only;
 * writes an audit event. Other server instances see the change within 15 seconds (STATE_CACHE_MS).
 *
 * If the condition that tripped it still holds (90% of the budget used, or the credit expired without
 * SPEND_ALLOW_CARD_CHARGES=true), the next hourly run trips it again. Raise SPEND_BUDGET_USD or set
 * SPEND_ALLOW_CARD_CHARGES=true first if that is the intent.
 */
export async function POST(req: NextRequest) {
  const auth = requireAuth(req);
  if (auth instanceof NextResponse) return auth;
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: "server_sessions_unavailable", message: "This server has no database, so there is no spend trip to clear." }, { status: 400 });

  const actor = await prisma.user.findUnique({ where: { id: auth.id }, select: { isPlatformAdmin: true } });
  if (!actor?.isPlatformAdmin) return NextResponse.json({ error: "forbidden", message: "Only platform admins can clear the spend kill switch." }, { status: 403 });

  const ipLimited = ipLimitResponse(req, "usage");
  if (ipLimited) return ipLimited;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJsonLimited(req));
  } catch {
    return NextResponse.json({ error: "invalid_request", message: "Say why the spend kill switch is being cleared (1 to 200 characters)." }, { status: 400 });
  }

  const before = await prisma.spendState.findUnique({ where: { id: STATE_ID }, select: { tripped: true, tripReason: true, trippedAt: true, dailyCapDay: true } });
  await prisma.spendState.upsert({
    where: { id: STATE_ID },
    create: { id: STATE_ID },
    update: { tripped: false, trippedAt: null, tripReason: null, dailyCapDay: null },
  });
  rememberSpendTrip({ tripped: false, dailyCapDay: null });
  await prisma.auditEvent.create({
    data: {
      userId: auth.id,
      action: "spend.trip_cleared",
      metadata: {
        reason: body.reason,
        wasTripped: before?.tripped ?? false,
        tripReason: before?.tripReason ?? null,
        trippedAt: before?.trippedAt?.toISOString() ?? null,
        dailyCapDay: before?.dailyCapDay ?? null,
      },
    },
  });
  return NextResponse.json({ ok: true, wasTripped: before?.tripped ?? false, tripReason: before?.tripReason ?? null });
}
